'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const { encrypt, maskValue, decrypt } = require('../services/crypto');
const registry = require('../connectors/connector-registry');
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

// Add new integration form (modal-based, handled via redirect)
router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, type, environment, config_json } = req.body;
  if (!name || !type) {
    req.session.flash = { error: 'Name and type are required.' };
    return res.redirect('/integrations');
  }
  let configObj = {};
  try { configObj = config_json ? JSON.parse(config_json) : {}; } catch { configObj = {}; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO integrations (id,name,type,environment,enabled,config_json,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?)')
    .run(uuidv4(), name, type, environment || 'sandbox', JSON.stringify(configObj), now, now);
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
  db.prepare('UPDATE integrations SET name=?,environment=?,enabled=?,config_json=?,updated_at=? WHERE id=?')
    .run(name, environment || 'sandbox', enabled === 'on' ? 1 : 0, JSON.stringify(configObj), new Date().toISOString(), req.params.id);
  req.session.flash = { success: 'Integration updated.' };
  res.redirect(`/integrations/${req.params.id}`);
});

// Add credential
router.post('/:id/credentials', requireAdmin, (req, res) => {
  const db = getDb();
  const { key_name, value, expires_at, is_sandbox } = req.body;
  if (!key_name || !value) {
    req.session.flash = { error: 'Key name and value are required.' };
    return res.redirect(`/integrations/${req.params.id}`);
  }
  const now = new Date().toISOString();
  const encrypted = encrypt(value);
  // Replace existing key if present
  const existing = db.prepare('SELECT id FROM integration_credentials WHERE integration_id=? AND key_name=?').get(req.params.id, key_name);
  if (existing) {
    db.prepare('UPDATE integration_credentials SET encrypted_value=?,expires_at=?,is_sandbox=?,updated_at=? WHERE id=?')
      .run(encrypted, expires_at || null, is_sandbox === 'on' ? 1 : 0, now, existing.id);
  } else {
    db.prepare('INSERT INTO integration_credentials (id,integration_id,key_name,encrypted_value,expires_at,is_sandbox,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuidv4(), req.params.id, key_name, encrypted, expires_at || null, is_sandbox === 'on' ? 1 : 0, now, now);
  }
  req.session.flash = { success: `Credential "${key_name}" saved.` };
  res.redirect(`/integrations/${req.params.id}`);
});

// Delete credential
router.post('/:id/credentials/:cid/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM integration_credentials WHERE id=? AND integration_id=?').run(req.params.cid, req.params.id);
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
    return res.json(result);
  } catch (err) {
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

module.exports = router;
