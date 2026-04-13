'use strict';
const BaseConnector = require('./base-connector');
const https = require('https');

/**
 * MlinkConnector — FW Murphy IoT MLink API
 * Auth: query param ?code=API_KEY or header x-functions-key
 * Base: https://api.fwmurphy-iot.com/api
 *
 * Endpoints:
 *   GET /DeviceHierarchy?v=2         — full fleet tree (all devices + groups)
 *   GET /LatestDeviceData?deviceId=X — current readings for one device
 *   GET /RunReport?deviceId=X&startTs=N&endTs=N — historical (max 24h, 30 day lookback)
 *
 * All responses throttled to 15 min by MLink server.
 */
class MlinkConnector extends BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    super(integration, credentials, fieldMappings);
    this.baseUrl = (this.config.base_url || 'https://api.fwmurphy-iot.com/api').replace(/\/$/, '');
  }

  _apiKey() {
    return this.getCredential('api_key')
      || process.env.MLINK_API_KEY
      || null;
  }

  async _fetch(endpoint, params = {}) {
    const zlib = require('zlib');
    const url = new URL(this.baseUrl + '/' + endpoint.replace(/^\//, ''));
    url.searchParams.set('code', this._apiKey());
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate', 'User-Agent': 'TechServicePortal/2.0' },
      }, (res) => {
        // Handle gzip/deflate decompression
        let stream = res;
        if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (res.headers['content-encoding'] === 'deflate') stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = raw;
          // MLink double-encodes some responses (JSON string inside JSON string)
          try { body = JSON.parse(raw); if (typeof body === 'string') body = JSON.parse(body); } catch { /* keep as string */ }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.setTimeout(45000, () => { req.destroy(); reject(new Error('Request timeout (45s)')); });
      req.end();
    });
  }

  // ── Hierarchy helpers ────────────────────────────────────────────────────

  _flattenHierarchy(tree) {
    const devices = [];
    function walk(nodes, path) {
      for (const node of nodes) {
        const groupPath = path ? path + ' / ' + node.d : node.d;
        for (const [devId, devName] of Object.entries(node.g || {})) {
          devices.push({ id: devId, name: devName, group: node.d, path: groupPath });
        }
        if (node.c && node.c.length) walk(node.c, groupPath);
      }
    }
    walk(tree, '');
    return devices;
  }

  // ── Test connection ──────────────────────────────────────────────────────

  async testConnection() {
    const start = Date.now();
    try {
      const res = await this._fetch('DeviceHierarchy', { v: '2' });
      const duration = Date.now() - start;
      if (res.status === 200 && Array.isArray(res.body)) {
        const devices = this._flattenHierarchy(res.body);
        await this.log('test_connection', 'success', null, duration);
        return { ok: true, message: `Connected to MLink — ${devices.length} devices in fleet` };
      }
      await this.log('test_connection', 'failed', `HTTP ${res.status}`, duration);
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      await this.log('test_connection', 'failed', err.message, Date.now() - start);
      return { ok: false, message: err.message };
    }
  }

  // ── Sync inbound ─────────────────────────────────────────────────────────

  async syncInbound(objectType, options = {}) {
    const start = Date.now();
    try {
      let records = [];

      if (objectType === 'devices' || objectType === 'hierarchy') {
        // Return flat device list from hierarchy
        const res = await this._fetch('DeviceHierarchy', { v: '2' });
        if (res.status === 200 && Array.isArray(res.body)) {
          records = this._flattenHierarchy(res.body);
        }

      } else if (objectType === 'telemetry') {
        // Get hierarchy first to know all device IDs, then fetch specified or first N
        const deviceIds = options.deviceIds || [];
        if (!deviceIds.length) {
          // If no device IDs specified, get from hierarchy
          const hRes = await this._fetch('DeviceHierarchy', { v: '2' });
          if (hRes.status === 200 && Array.isArray(hRes.body)) {
            const allDevs = this._flattenHierarchy(hRes.body);
            // Cap at 20 to avoid hammering the API (each is a separate HTTP call)
            deviceIds.push(...allDevs.slice(0, 20).map(d => d.id));
          }
        }

        for (const deviceId of deviceIds.slice(0, 20)) {
          try {
            const res = await this._fetch('LatestDeviceData', { deviceId });
            if (res.status === 200 && res.body?.datapoints) {
              const timestamps = res.body.timestamps || [];
              const ports = res.body.ports || [];
              const lastTs = timestamps.length ? Math.max(...timestamps) : null;
              for (const dp of res.body.datapoints) {
                records.push({
                  deviceId,
                  alias: (dp.alias || '').trim(),
                  description: dp.desc || '',
                  value: dp.value,
                  units: dp.units || '',
                  address: dp.addressStr || '',
                  portName: ports[dp.portIdx]?.name || '',
                  timestamp: lastTs,
                });
              }
            }
          } catch (_) {}
        }

      } else if (objectType === 'report') {
        const deviceId = options.deviceId;
        if (!deviceId) throw new Error('deviceId required for report');
        const params = { deviceId, startTs: options.startTs, endTs: options.endTs };
        const res = await this._fetch('RunReport', params);
        if (res.status === 200) {
          records = Array.isArray(res.body) ? res.body : [res.body];
        }
      }

      await this.log('sync_inbound', 'success', `${records.length} records`, Date.now() - start);
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
