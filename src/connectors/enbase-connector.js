'use strict';
const BaseConnector = require('./base-connector');
const https = require('https');
const http = require('http');

/**
 * EnbaseConnector — Detechtion Enbase API
 * Auth: HTTP Basic (username:password)
 * Base: https://api.detechtion.com/enbase/api
 */
class EnbaseConnector extends BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    super(integration, credentials, fieldMappings);
    let baseUrl = this.config.base_url || 'https://api.detechtion.com/enbase/api';
    if (!baseUrl.includes('/enbase/api')) baseUrl = baseUrl.replace(/\/?$/, '') + '/enbase/api';
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  _basicHeader() {
    const username = this.getCredential('username') || process.env.ENBASE_USERNAME || 'ccastille@servicecompression.com';
    const password = this.getCredential('password') || process.env.ENBASE_PASSWORD || 'Brayden1!1';
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  async _fetch(path, options = {}) {
    // Concatenate directly — new URL(path, base) drops base path when path starts with /
    const fullUrl = path.startsWith('http') ? path : this.baseUrl + '/' + path.replace(/^\//, '');
    const url = new URL(fullUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': this._basicHeader(),
          'User-Agent': 'TechServicePortal/1.0',
          ...(options.headers || {}),
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
    const probes = ['/assets', '/alarms', '/devices', '/locations'];
    for (const p of probes) {
      try {
        const res = await this._fetch(p);
        if (res.status < 500) {
          const ok = res.status < 400;
          await this.log('test_connection', ok ? 'success' : 'failed', ok ? null : `HTTP ${res.status}`, Date.now() - start);
          return { ok, message: ok ? `Connected to Enbase (${p})` : `HTTP ${res.status} on ${p}` };
        }
      } catch (_) {}
    }
    await this.log('test_connection', 'failed', 'No endpoint responded', Date.now() - start);
    return { ok: false, message: 'No Enbase endpoint responded — check credentials and base URL' };
  }

  async syncInbound(objectType, options = {}) {
    const start = Date.now();
    const endpointMap = {
      assets:          '/assets',
      alarms:          '/alarms',
      devices:         '/devices',
      measurements:    '/measurements',
      customers:       '/customers',
      locations:       '/locations',
      downtime_events: '/downtimeevents',
    };
    const path = endpointMap[objectType] || `/${objectType}`;
    const qs = options.since ? `?since=${options.since}` : '';
    try {
      const res = await this._fetch(path + qs);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const records = Array.isArray(res.body) ? res.body : (res.body?.data || res.body?.items || res.body?.results || []);
      await this.log('sync_inbound', 'success', null, Date.now() - start);
      return records;
    } catch (err) {
      await this.log('sync_inbound', 'failed', err.message, Date.now() - start);
      throw err;
    }
  }

  async syncOutbound(objectType, records) {
    await this.log('sync_outbound', 'skipped', 'Enbase is a read-only monitoring source', 0);
    return { skipped: true, reason: 'Enbase is a read-only monitoring source' };
  }
}

module.exports = EnbaseConnector;
