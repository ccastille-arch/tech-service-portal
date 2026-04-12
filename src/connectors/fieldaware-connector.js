'use strict';
const BaseConnector = require('./base-connector');

class FieldawareConnector extends BaseConnector {
  async testConnection() {
    await this.log('test_connection', 'skipped', 'FieldAware connector not yet configured', 0);
    return { ok: false, message: 'FieldAware connector stub — configure API key and base URL in credentials.' };
  }

  async syncInbound(objectType, options = {}) {
    await this.log('sync_inbound', 'skipped', 'FieldAware stub', 0);
    return [];
  }

  async syncOutbound(objectType, records) {
    await this.log('sync_outbound', 'skipped', 'FieldAware stub', 0);
    return { skipped: true };
  }
}

module.exports = FieldawareConnector;
