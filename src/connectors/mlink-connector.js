'use strict';
const BaseConnector = require('./base-connector');
const https = require('https');
const http = require('http');

class MlinkConnector extends BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    super(integration, credentials, fieldMappings);
    this.baseUrl = this.config.base_url || 'https://mlink-datastore.up.railway.app';
  }

  async _fetch(path, options = {}) {
    const apiKey = this.getCredential('api_key');
    const url = new URL(path, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['X-API-Key'] = apiKey;
      if (options.headers) Object.assign(headers, options.headers);

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers,
        timeout: 10000
      };

      const req = lib.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  }

  async testConnection() {
    const start = Date.now();
    try {
      const res = await this._fetch('/api/health');
      const ok = res.status >= 200 && res.status < 300;
      await this.log('test_connection', ok ? 'success' : 'failed', ok ? null : `HTTP ${res.status}`, Date.now() - start);
      return { ok, message: ok ? 'Connected to MLink DataStore' : `HTTP ${res.status}: ${JSON.stringify(res.body)}` };
    } catch (err) {
      await this.log('test_connection', 'failed', err.message, Date.now() - start);
      return { ok: false, message: err.message };
    }
  }

  async syncInbound(objectType, options = {}) {
    const start = Date.now();
    try {
      let endpoint = '/api/data';
      if (objectType === 'telemetry') endpoint = '/api/telemetry';
      else if (objectType === 'devices') endpoint = '/api/devices';

      const since = options.since ? `?since=${options.since}` : '';
      const res = await this._fetch(endpoint + since);

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      }

      const records = Array.isArray(res.body) ? res.body : (res.body.data || []);
      await this.log('sync_inbound', 'success', null, Date.now() - start);
      return records;
    } catch (err) {
      await this.log('sync_inbound', 'failed', err.message, Date.now() - start);
      throw err;
    }
  }

  async syncOutbound(objectType, records) {
    // MLink is a telemetry source — we don't push data to it
    await this.log('sync_outbound', 'skipped', 'MLink is read-only', 0);
    return { skipped: true, reason: 'MLink is a read-only telemetry source' };
  }
}

module.exports = MlinkConnector;
