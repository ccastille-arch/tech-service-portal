'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const { encrypt, maskValue, decrypt } = require('../services/crypto');
const registry = require('../connectors/connector-registry');
const { logAudit, actorFromReq, AUDIT_ACTIONS } = require('../services/audit');
const { sanitizeString } = require('../middleware/validate');
const router = express.Router();

// List integrations
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const integrations = db.prepare('SELECT * FROM integrations ORDER BY type, name').all();
  res.render('integrations', {
    title: 'Integrations',
    integrations,
    connectorTypes: registry.list(),
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken,
    view: 'list'
  });
});

// Add new integration
router.post('/', requireAdmin, (req, res) => {
  const db   = getDb();
  const name = sanitizeString(req.body.name, 100);
  const type = sanitizeString(req.body.type, 50);
  if (!name || !type) {
    req.session.flash = { error: 'Name and type are required.' };
    return res.redirect('/integrations');
  }
  let configObj = {};
  try { configObj = req.body.config_json ? JSON.parse(req.body.config_json) : {}; } catch { configObj = {}; }
  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO integrations (id,name,type,environment,enabled,config_json,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?)')
    .run(id, name, type, req.body.environment || 'sandbox', JSON.stringify(configObj), now, now);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.INTEGRATION_CREATED, resource_type: 'integration', resource_id: id, new_value: `name=${name} type=${type}` });
  req.session.flash = { success: `Integration "${name}" created.` };
  res.redirect('/integrations');
});

// Integration detail/edit
router.get('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.redirect('/integrations');

  const credentials = db.prepare('SELECT * FROM integration_credentials WHERE integration_id=? ORDER BY key_name').all(req.params.id)
    .map(c => ({ ...c, masked: maskValue(c.encrypted_value) }));
  const logs = db.prepare('SELECT * FROM integration_logs WHERE integration_id=? ORDER BY timestamp DESC LIMIT 50').all(req.params.id);
  const queue = db.prepare('SELECT * FROM sync_queue WHERE integration_id=? ORDER BY created_at DESC LIMIT 30').all(req.params.id);
  const mappings = db.prepare('SELECT * FROM field_mappings WHERE integration_id=? ORDER BY object_type, source_field').all(req.params.id);

  res.render('integration-detail', {
    title: `Integration: ${integration.name}`,
    integration,
    credentials, logs, queue, mappings,
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// Update integration
router.post('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, environment, enabled, config_json } = req.body;
  let configObj = {};
  try { configObj = config_json ? JSON.parse(config_json) : {}; } catch { configObj = {}; }
  const wasEnabled = db.prepare('SELECT enabled FROM integrations WHERE id=?').get(req.params.id)?.enabled;
  const nowEnabled = req.body.enabled === 'on' ? 1 : 0;
  db.prepare('UPDATE integrations SET name=?,environment=?,enabled=?,config_json=?,updated_at=? WHERE id=?')
    .run(req.body.name, req.body.environment || 'sandbox', nowEnabled, JSON.stringify(configObj), new Date().toISOString(), req.params.id);
  const action = wasEnabled !== nowEnabled
    ? (nowEnabled ? AUDIT_ACTIONS.INTEGRATION_ENABLED : AUDIT_ACTIONS.INTEGRATION_DISABLED)
    : AUDIT_ACTIONS.INTEGRATION_UPDATED;
  logAudit(db, { ...actorFromReq(req), action, resource_type: 'integration', resource_id: req.params.id });
  req.session.flash = { success: 'Integration updated.' };
  res.redirect(`/integrations/${req.params.id}`);
});

// Add credential — value is encrypted immediately, never stored in plaintext
router.post('/:id/credentials', requireAdmin, (req, res) => {
  const db       = getDb();
  const key_name = sanitizeString(req.body.key_name, 100);
  const value    = req.body.value ? String(req.body.value) : null;
  if (!key_name || !value) {
    req.session.flash = { error: 'Key name and value are required.' };
    return res.redirect(`/integrations/${req.params.id}`);
  }
  const now       = new Date().toISOString();
  const encrypted = encrypt(value);
  const existing  = db.prepare('SELECT id FROM integration_credentials WHERE integration_id=? AND key_name=?').get(req.params.id, key_name);
  if (existing) {
    db.prepare('UPDATE integration_credentials SET encrypted_value=?,expires_at=?,is_sandbox=?,updated_at=? WHERE id=?')
      .run(encrypted, req.body.expires_at || null, req.body.is_sandbox === 'on' ? 1 : 0, now, existing.id);
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CREDENTIAL_ROTATED, resource_type: 'integration_credential', resource_id: existing.id, new_value: `key=${key_name}` });
  } else {
    const id = uuidv4();
    db.prepare('INSERT INTO integration_credentials (id,integration_id,key_name,encrypted_value,expires_at,is_sandbox,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.params.id, key_name, encrypted, req.body.expires_at || null, req.body.is_sandbox === 'on' ? 1 : 0, now, now);
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CREDENTIAL_ADDED, resource_type: 'integration_credential', resource_id: id, new_value: `key=${key_name}` });
  }
  req.session.flash = { success: `Credential "${key_name}" saved.` };
  res.redirect(`/integrations/${req.params.id}`);
});

// Delete credential
router.post('/:id/credentials/:cid/delete', requireAdmin, (req, res) => {
  const db   = getDb();
  const cred = db.prepare('SELECT key_name FROM integration_credentials WHERE id=? AND integration_id=?').get(req.params.cid, req.params.id);
  db.prepare('DELETE FROM integration_credentials WHERE id=? AND integration_id=?').run(req.params.cid, req.params.id);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CREDENTIAL_DELETED, resource_type: 'integration_credential', resource_id: req.params.cid, old_value: cred ? `key=${cred.key_name}` : null });
  req.session.flash = { success: 'Credential removed.' };
  res.redirect(`/integrations/${req.params.id}`);
});

// Test connection
router.post('/:id/test', requireAdmin, async (req, res) => {
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.json({ ok: false, message: 'Integration not found.' });

  const credentials = db.prepare('SELECT * FROM integration_credentials WHERE integration_id=?').all(req.params.id);
  const fieldMaps = db.prepare('SELECT * FROM field_mappings WHERE integration_id=?').all(req.params.id);
  const ConnectorClass = registry.get(integration.type);

  if (!ConnectorClass) return res.json({ ok: false, message: `No connector for type: ${integration.type}` });

  try {
    const connector = new ConnectorClass(integration, credentials, fieldMaps);
    const result = await connector.testConnection();
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.INTEGRATION_TEST, resource_type: 'integration', resource_id: req.params.id, new_value: result.ok ? 'success' : result.message });
    return res.json(result);
  } catch (err) {
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.INTEGRATION_TEST, resource_type: 'integration', resource_id: req.params.id, new_value: `error: ${err.message}` });
    return res.json({ ok: false, message: err.message });
  }
});

// Manual sync
router.post('/:id/sync', requireAdmin, async (req, res) => {
  const { processSyncQueue, enqueueSync } = require('../services/sync-engine');
  const db = getDb();
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.json({ ok: false, message: 'Integration not found.' });

  // Enqueue all sync_objects from config
  let config = {};
  try { config = JSON.parse(integration.config_json || '{}'); } catch {}
  const objects = config.sync_objects || ['data'];
  for (const obj of objects) {
    enqueueSync(integration.id, obj, null, 'inbound');
  }

  const result = await processSyncQueue(integration.id);
  req.session.flash = { success: `Sync complete: ${result.succeeded} succeeded, ${result.failed} failed.` };
  res.redirect(`/integrations/${req.params.id}`);
});

// Reprocess queue item
router.post('/:id/queue/:qid/reprocess', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE sync_queue SET status='pending', retry_count=0, error=NULL, next_retry_at=NULL WHERE id=? AND integration_id=?")
    .run(req.params.qid, req.params.id);
  req.session.flash = { success: 'Queue item re-queued.' };
  res.redirect(`/integrations/${req.params.id}`);
});

// Save field mappings
router.post('/:id/mappings', requireAdmin, (req, res) => {
  const db = getDb();
  const { mappings } = req.body; // array of {object_type, source_field, target_field, transform_rule}
  if (!mappings) return res.redirect(`/integrations/${req.params.id}`);

  const rows = Array.isArray(mappings) ? mappings : [mappings];
  db.prepare('DELETE FROM field_mappings WHERE integration_id=?').run(req.params.id);
  const insert = db.prepare('INSERT INTO field_mappings (id,integration_id,object_type,source_field,target_field,transform_rule,is_required,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const m of rows) {
    if (m.source_field && m.target_field) {
      insert.run(uuidv4(), req.params.id, m.object_type || 'data', m.source_field, m.target_field, m.transform_rule || 'direct', m.is_required ? 1 : 0, new Date().toISOString());
    }
  }
  req.session.flash = { success: 'Field mappings saved.' };
  res.redirect(`/integrations/${req.params.id}`);
});

// ── Live data proxy routes (requireAuth, not admin) ─────────────────────────
// Used by the dashboard Integrations tab for real-time status cards.
const { requireAuth } = require('../middleware/authenticate');

function getConnector(db, type) {
  const integration = db.prepare('SELECT * FROM integrations WHERE type=? AND enabled=1').get(type);
  if (!integration) return null;
  const credentials = db.prepare('SELECT * FROM integration_credentials WHERE integration_id=?').all(integration.id);
  const fieldMaps   = db.prepare('SELECT * FROM field_mappings WHERE integration_id=?').all(integration.id);
  const ConnectorClass = registry.get(type);
  if (!ConnectorClass) return null;
  return new ConnectorClass(integration, credentials, fieldMaps);
}

// GET /integrations/live/enbase?type=alarms|assets|devices
router.get('/live/enbase', requireAuth, async (req, res) => {
  const db = getDb();
  const objectType = req.query.type || 'alarms';
  try {
    const connector = getConnector(db, 'enbase');
    if (!connector) return res.json({ ok: false, error: 'Enbase integration not found or disabled' });
    const records = await connector.syncInbound(objectType);
    res.json({ ok: true, objectType, count: records.length, records: records.slice(0, 50) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /integrations/live/mlink?type=telemetry
router.get('/live/mlink', requireAuth, async (req, res) => {
  const db = getDb();
  const objectType = req.query.type || 'telemetry';
  try {
    const connector = getConnector(db, 'mlink');
    if (!connector) return res.json({ ok: false, error: 'MLink integration not found or disabled' });
    const records = await connector.syncInbound(objectType);
    res.json({ ok: true, objectType, count: records.length, records: records.slice(0, 50) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /integrations/live/assets — combined asset list for ticket linking
router.get('/live/assets', requireAuth, async (req, res) => {
  const db = getDb();
  const assets = [];
  // Enbase assets
  try {
    const c = getConnector(db, 'enbase');
    if (c) {
      const records = await c.syncInbound('assets');
      for (const r of records.slice(0, 100)) {
        assets.push({
          source: 'enbase',
          id: r.AssetId || r.assetId || r.id,
          name: r.DisplayName || r.AssetNumber || r.AssetDescription || String(r.AssetId || r.id),
          type: r.AssetTypeName || 'Asset',
          customer: r.CustomerName || '',
          location: r.AssetLocationDescription || r.LocationName || '',
          status: r.MonitoringStatusName || '',
        });
      }
    }
  } catch (_) {}
  // MLink devices (from DeviceHierarchy — all 745+ devices)
  try {
    const c = getConnector(db, 'mlink');
    if (c) {
      const records = await c.syncInbound('devices');
      for (const r of records) {
        assets.push({
          source: 'mlink',
          id: r.id,
          name: r.name || r.id,
          type: 'MLink Device',
          group: r.group || '',
          path: r.path || '',
        });
      }
    }
  } catch (_) {}
  res.json({ ok: true, assets });
});

module.exports = router;
