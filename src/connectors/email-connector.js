'use strict';
const BaseConnector = require('./base-connector');

class EmailConnector extends BaseConnector {
  async testConnection() {
    await this.log('test_connection', 'skipped', 'Email connector not yet configured', 0);
    return { ok: false, message: 'Email connector stub — configure SMTP host, port, username, password in credentials.' };
  }

  async syncInbound(objectType, options = {}) {
    return [];
  }

  async syncOutbound(objectType, records) {
    await this.log('sync_outbound', 'skipped', 'Email connector stub', 0);
    return { skipped: true };
  }
}

module.exports = EmailConnector;
