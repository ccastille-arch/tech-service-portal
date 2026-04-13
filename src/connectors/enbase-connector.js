'use strict';
const BaseConnector = require('./base-connector');
const https = require('https');

/**
 * EnbaseConnector — Detechtion Enbase API
 * Auth: HTTP Basic (username:password)
 * Base: https://api.detechtion.com/enbase
 * Docs: https://api.detechtion.com/enbase/docs
 *
 * All list endpoints use POST /{resource}/find with { TenantName, PageSize, ... }
 * Single-resource GETs use /{resource}/{id}?TenantName=...
 */
class EnbaseConnector extends BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    super(integration, credentials, fieldMappings);
    // Force correct base URL — always ends with /enbase, never /enbase/api
    let baseUrl = (this.config.base_url || process.env.ENBASE_API_URL || 'https://api.detechtion.com/enbase')
      .replace(/\/+$/, '');
    if (!baseUrl.endsWith('/enbase')) {
      baseUrl = baseUrl.replace(/\/enbase.*$/, '') + '/enbase';
    }
    this.baseUrl = baseUrl;
    this.tenantName = this.config.tenant_name || process.env.ENBASE_TENANT || 'Service Compression';
  }

  _basicHeader() {
    const username = this.getCredential('username') || process.env.ENBASE_USERNAME || 'ccastille@servicecompression.com';
    const password = this.getCredential('password') || process.env.ENBASE_PASSWORD || 'Brayden1!1';
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  _request(method, fullUrl, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(fullUrl);
      const headers = {
        'Accept': 'application/json',
        'Authorization': this._basicHeader(),
        'User-Agent': 'TechServicePortal/2.0',
      };
      const payload = body != null ? JSON.stringify(body) : null;
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, body: json ?? data });
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout (30s)')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** POST /{resource}/find with TenantName in body */
  _find(resource, searchBody = {}) {
    const body = { TenantName: this.tenantName, PageSize: 5000, ...searchBody };
    return this._request('POST', `${this.baseUrl}/${resource}/find`, body);
  }

  /** GET /{resource}/{id}?TenantName=... */
  _getById(resource, id) {
    const qs = new URLSearchParams({ TenantName: this.tenantName });
    return this._request('GET', `${this.baseUrl}/${resource}/${id}?${qs}`);
  }

  async testConnection() {
    const start = Date.now();
    try {
      const res = await this._find('assets', { PageSize: 1 });
      const duration = Date.now() - start;
      if (res.status === 200) {
        const total = res.body?.TotalCount ?? res.body?.Assets?.length ?? '?';
        await this.log('test_connection', 'success', null, duration);
        return { ok: true, message: `Connected to Enbase — ${total} assets in "${this.tenantName}"` };
      }
      if (res.status === 401) {
        await this.log('test_connection', 'failed', 'HTTP 401', duration);
        return { ok: false, message: 'Authentication failed (401) — check username/password' };
      }
      if (res.status === 403) {
        await this.log('test_connection', 'failed', 'HTTP 403', duration);
        return { ok: false, message: 'Forbidden (403) — account may lack API role' };
      }
      await this.log('test_connection', 'failed', `HTTP ${res.status}`, duration);
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      await this.log('test_connection', 'failed', err.message, Date.now() - start);
      return { ok: false, message: err.message };
    }
  }

  // Map between object types and API resource names + response wrapper keys
  static RESOURCE_MAP = {
    assets:          { resource: 'assets',            key: 'Assets' },
    alarms:          { resource: 'alarms',            key: 'Alarms' },
    devices:         { resource: 'monitoringdevices', key: 'MonitoringDevices' },
    measurements:    { resource: 'measurements',      key: 'Measurements' },
    customers:       { resource: 'customers',         key: 'Customers' },
    locations:       { resource: 'locations',         key: 'Locations' },
    downtime_events: { resource: 'downtimeEvents',    key: 'DowntimeEvents' },
    tags:            { resource: 'tags',              key: 'Tags' },
    codelegends:     { resource: 'codeLegends',       key: 'CodeLegends' },
  };

  async syncInbound(objectType, options = {}) {
    const start = Date.now();
    const mapping = EnbaseConnector.RESOURCE_MAP[objectType];
    if (!mapping) {
      await this.log('sync_inbound', 'failed', `Unknown object type: ${objectType}`, 0);
      throw new Error(`Unknown Enbase object type: ${objectType}`);
    }

    const searchBody = {};
    if (objectType === 'alarms') searchBody.IsActive = true;
    if (options.since) searchBody.UpdatedDateFrom = options.since;

    try {
      const res = await this._find(mapping.resource, searchBody);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);

      // Unwrap PascalCase response: { Assets: [...], TotalCount: N }
      let records = [];
      if (Array.isArray(res.body)) {
        records = res.body;
      } else if (res.body && typeof res.body === 'object') {
        records = res.body[mapping.key] || [];
      }

      await this.log('sync_inbound', 'success', `${records.length} records`, Date.now() - start);
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
