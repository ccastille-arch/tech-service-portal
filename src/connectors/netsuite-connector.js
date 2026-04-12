'use strict';
const BaseConnector = require('./base-connector');

class NetsuiteConnector extends BaseConnector {
  async testConnection() {
    await this.log('test_connection', 'skipped', 'NetSuite connector not yet configured', 0);
    return { ok: false, message: 'NetSuite connector stub — configure Account ID, Consumer Key, Consumer Secret, Token ID, Token Secret in credentials.' };
  }

  async syncInbound(objectType, options = {}) {
    await this.log('sync_inbound', 'skipped', 'NetSuite stub', 0);
    return [];
  }

  async syncOutbound(objectType, records) {
    await this.log('sync_outbound', 'skipped', 'NetSuite stub', 0);
    return { skipped: true };
  }
}

module.exports = NetsuiteConnector;
