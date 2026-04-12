'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const registry = require('../connectors/connector-registry');

async function processSyncQueue(integrationId = null) {
  const db = getDb();
  const now = new Date().toISOString();

  let query = `
    SELECT sq.*, i.type, i.config_json, i.enabled
    FROM sync_queue sq
    JOIN integrations i ON i.id = sq.integration_id
    WHERE sq.status IN ('pending','failed')
    AND (sq.next_retry_at IS NULL OR sq.next_retry_at <= ?)
    AND i.enabled = 1
  `;
  const params = [now];
  if (integrationId) { query += ' AND sq.integration_id = ?'; params.push(integrationId); }
  query += ' ORDER BY sq.created_at ASC LIMIT 50';

  const items = db.prepare(query).all(...params);
  const results = { processed: 0, succeeded: 0, failed: 0 };

  for (const item of items) {
    // Mark processing
    db.prepare("UPDATE sync_queue SET status='processing' WHERE id=?").run(item.id);
    results.processed++;

    try {
      const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(item.integration_id);
      const credentials = db.prepare('SELECT * FROM integration_credentials WHERE integration_id=?').all(item.integration_id);
      const fieldMaps = db.prepare('SELECT * FROM field_mappings WHERE integration_id=? AND object_type=?').all(item.integration_id, item.object_type);

      const ConnectorClass = registry.get(integration.type);
      if (!ConnectorClass) throw new Error(`No connector registered for type: ${integration.type}`);

      const connector = new ConnectorClass(integration, credentials, fieldMaps);
      const startMs = Date.now();

      if (item.direction === 'inbound') {
        await connector.syncInbound(item.object_type, item.payload_json ? JSON.parse(item.payload_json) : {});
      } else if (item.direction === 'outbound') {
        await connector.syncOutbound(item.object_type, item.payload_json ? JSON.parse(item.payload_json) : {});
      }

      db.prepare(`
        UPDATE sync_queue SET status='completed', processed_at=?, error=NULL WHERE id=?
      `).run(new Date().toISOString(), item.id);

      await connector.log('sync_queue', 'success', null, Date.now() - startMs);
      results.succeeded++;
    } catch (err) {
      const retryCount = item.retry_count + 1;
      const failed = retryCount >= item.max_retries;
      const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 3600000); // max 1 hour
      const nextRetry = new Date(Date.now() + backoffMs).toISOString();

      db.prepare(`
        UPDATE sync_queue
        SET status=?, retry_count=?, next_retry_at=?, error=?
        WHERE id=?
      `).run(failed ? 'failed' : 'pending', retryCount, failed ? null : nextRetry, err.message, item.id);

      results.failed++;
    }
  }
  return results;
}

function enqueueSync(integrationId, objectType, objectId, direction, payload = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sync_queue (id, integration_id, object_type, object_id, direction, status, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(uuidv4(), integrationId, objectType, objectId || null, direction, payload ? JSON.stringify(payload) : null, new Date().toISOString());
}

module.exports = { processSyncQueue, enqueueSync };
