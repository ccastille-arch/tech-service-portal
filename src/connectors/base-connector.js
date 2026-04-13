'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { decrypt } = require('../services/crypto');

// Default timeout for all outbound integration calls (10 seconds)
const DEFAULT_TIMEOUT_MS = 10000;
// Maximum response body size to log (prevent logging huge payloads)
const MAX_LOG_SUMMARY = 500;

class BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    this.integration   = integration;
    this.credentials   = credentials || [];
    this.fieldMappings = fieldMappings || [];
    this.config        = integration.config_json ? JSON.parse(integration.config_json) : {};
    this.timeoutMs     = this.config.timeout_ms || DEFAULT_TIMEOUT_MS;

    // Environment guard — prevent accidental use of sandbox credentials in production
    this._checkEnvironmentBoundary();
  }

  _checkEnvironmentBoundary() {
    const appEnv  = process.env.NODE_ENV || 'development';
    const intEnv  = this.integration.environment || 'sandbox';
    // Block sandbox integrations from running in production environment
    if (appEnv === 'production' && intEnv === 'sandbox') {
      throw new Error(
        `Integration "${this.integration.name}" is configured as sandbox but the app is running in production. ` +
        `Switch the integration environment to "production" before enabling it.`
      );
    }
  }

  getCredential(keyName) {
    const cred = this.credentials.find(c => c.key_name === keyName);
    if (!cred) return null;
    try { return decrypt(cred.encrypted_value); }
    catch { return null; }
  }

  // Wrap a fetch call with timeout using AbortController
  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  mapRecord(sourceRecord, direction) {
    if (!this.fieldMappings.length) return sourceRecord;
    const result = {};
    for (const mapping of this.fieldMappings) {
      const src = direction === 'inbound' ? mapping.source_field : mapping.target_field;
      const tgt = direction === 'inbound' ? mapping.target_field : mapping.source_field;
      const val = sourceRecord[src];
      if (val === undefined && mapping.is_required) {
        throw new Error(`Required field missing: ${src}`);
      }
      result[tgt] = this._applyTransform(val, mapping.transform_rule);
    }
    return result;
  }

  _applyTransform(val, rule) {
    if (val === undefined || val === null) return val;
    switch (rule) {
      case 'uppercase': return String(val).toUpperCase();
      case 'lowercase': return String(val).toLowerCase();
      case 'date_iso':  return val ? new Date(val).toISOString() : val;
      case 'trim':      return String(val).trim();
      default:          return val; // 'direct'
    }
  }

  // Truncate a value for safe logging — never log full credential or large payloads
  _safeLog(val) {
    if (!val) return null;
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    return s.substring(0, MAX_LOG_SUMMARY);
  }

  async log(action, status, error = null, durationMs = null, requestSummary = null, responseSummary = null) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO integration_logs (id, integration_id, action, status, request_summary, response_summary, error, duration_ms, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        this.integration.id,
        action,
        status,
        this._safeLog(requestSummary),
        this._safeLog(responseSummary),
        error ? String(error).substring(0, 1000) : null,
        durationMs,
        new Date().toISOString()
      );
    } catch (e) {
      console.error('[CONNECTOR LOG ERROR]', e.message);
    }
  }

  async testConnection() {
    throw new Error('testConnection() not implemented');
  }

  async syncInbound(objectType, options = {}) {
    throw new Error('syncInbound() not implemented');
  }

  async syncOutbound(objectType, records = {}) {
    throw new Error('syncOutbound() not implemented');
  }
}

module.exports = BaseConnector;
