'use strict';
const BaseConnector = require('./base-connector');
const https = require('https');
const http = require('http');

/**
 * MlinkConnector — FW Murphy IoT MLink API
 * Auth: query param ?code=API_KEY
 * Base: https://api.fwmurphy-iot.com/api
 * Devices: Panel 2504-504495, Compressor A 2504-505561, Compressor B 2504-505472
 */
const DEFAULT_DEVICES = ['2504-504495', '2504-505561', '2504-505472'];
const DEVICE_LABELS   = {
  '2504-504495': 'Panel',
  '2504-505561': 'Compressor A',
  '2504-505472': 'Compressor B',
};

class MlinkConnector extends BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    super(integration, credentials, fieldMappings);
    this.baseUrl = (this.config.base_url || 'https://api.fwmurphy-iot.com/api').replace(/\/$/, '');
    this.deviceIds = this.config.device_ids || DEFAULT_DEVICES;
  }

  _apiKey() {
    return this.getCredential('api_key')
      || process.env.MLINK_API_KEY
      || null;
  }

  async _fetch(endpoint, params = {}) {
    const url = new URL(this.baseUrl + '/' + endpoint.replace(/^\//, ''));
    url.searchParams.set('code', this._apiKey());
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'TechServicePortal/1.0',
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  async testConnection() {
    const start = Date.now();
    try {
      const deviceId = this.deviceIds[0];
      const res = await this._fetch('LatestDeviceData', { deviceId });
      const ok = res.status >= 200 && res.status < 300;
      await this.log('test_connection', ok ? 'success' : 'failed', ok ? null : `HTTP ${res.status}`, Date.now() - start);
      return { ok, message: ok ? `Connected to FW Murphy IoT (device ${deviceId})` : `HTTP ${res.status}: ${JSON.stringify(res.body)}` };
    } catch (err) {
      await this.log('test_connection', 'failed', err.message, Date.now() - start);
      return { ok: false, message: err.message };
    }
  }

  async syncInbound(objectType, options = {}) {
    const start = Date.now();
    try {
      let records = [];

      if (objectType === 'telemetry' || objectType === 'devices') {
        // Fetch latest data for each device
        for (const deviceId of this.deviceIds) {
          try {
            const res = await this._fetch('LatestDeviceData', { deviceId });
            if (res.status < 300 && res.body) {
              const data = Array.isArray(res.body) ? res.body : [res.body];
              records.push(...data.map(r => ({
                ...r,
                _deviceId: deviceId,
                _deviceLabel: DEVICE_LABELS[deviceId] || deviceId,
              })));
            }
          } catch (_) {}
        }
      } else if (objectType === 'report') {
        const deviceId = options.deviceId || this.deviceIds[0];
        const params = { deviceId };
        if (options.startDate) params.startDate = options.startDate;
        if (options.endDate)   params.endDate   = options.endDate;
        const res = await this._fetch('RunReport', params);
        if (res.status < 300) {
          records = Array.isArray(res.body) ? res.body : (res.body?.data || [res.body]);
        }
      }

      await this.log('sync_inbound', 'success', null, Date.now() - start);
      return records;
    } catch (err) {
      await this.log('sync_inbound', 'failed', err.message, Date.now() - start);
      throw err;
    }
  }

  async syncOutbound(objectType, records) {
    await this.log('sync_outbound', 'skipped', 'MLink is a read-only telemetry source', 0);
    return { skipped: true, reason: 'MLink is a read-only telemetry source' };
  }
}

module.exports = MlinkConnector;
