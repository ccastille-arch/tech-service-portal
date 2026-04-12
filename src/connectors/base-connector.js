'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { decrypt } = require('../services/crypto');

class BaseConnector {
  constructor(integration, credentials, fieldMappings) {
    this.integration = integration;
    this.credentials = credentials || [];
    this.fieldMappings = fieldMappings || [];
    this.config = integration.config_json ? JSON.parse(integration.config_json) : {};
  }

  getCredential(keyName) {
    const cred = this.credentials.find(c => c.key_name === keyName);
    if (!cred) return null;
    try { return decrypt(cred.encrypted_value); }
    catch { return null; }
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
      case 'date_iso': return val ? new Date(val).toISOString() : val;
      case 'trim': return String(val).trim();
      default: return val; // 'direct'
    }
  }

  async log(action, status, error = null, durationMs = null) {
    const db = getDb();
    db.prepare(`
      INSERT INTO integration_logs (id, integration_id, action, status, error, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), this.integration.id, action, status, error, durationMs, new Date().toISOString());
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
