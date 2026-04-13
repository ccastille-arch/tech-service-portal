'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber, nextCallNumber } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const { sanitizeString, validateRole, validateEmail, validateUsername, validatePasswordStrength } = require('../middleware/validate');
const { logAudit, AUDIT_ACTIONS, actorFromReq } = require('../services/audit');
const router = express.Router();

// ── Admin panel ───────────────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res, next) => {
  try {
    const db = getDb();

    let users = [];
    let auditLogs = [];
    let recentActivity = [];
    let ticketStats = { total: 0, open: 0, in_progress: 0, closed: 0 };

    try {
      users = db.prepare(
        'SELECT id, username, email, name, role, last_login_at, login_attempts, locked_until, created_at FROM users ORDER BY role, name'
      ).all();
    } catch (e) { console.error('[admin] users query failed:', e.message); }

    try {
      auditLogs = db.prepare(
        'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200'
      ).all();
    } catch (e) { console.error('[admin] audit_logs query failed:', e.message); }

    try {
      recentActivity = db.prepare(
        'SELECT * FROM page_views ORDER BY created_at DESC LIMIT 50'
      ).all();
    } catch (e) { console.error('[admin] page_views query failed:', e.message); }

    try {
      const ts = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'open'        THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN status IN ('completed','closed') THEN 1 ELSE 0 END) AS closed
        FROM tickets
      `).get();
      if (ts) ticketStats = {
        total:       ts.total       || 0,
        open:        ts.open        || 0,
        in_progress: ts.in_progress || 0,
        closed:      ts.closed      || 0
      };
    } catch (e) { console.error('[admin] ticketStats query failed:', e.message); }

    res.render('admin', {
      title: 'Admin Panel',
      users,
      auditLogs,
      recentActivity,
      ticketStats,
      tab: req.query.tab || 'users',
      user: req.session.user,
      unreadCount: res.locals.unreadCount || 0,
      csrfToken: res.locals.csrfToken || ''
    });
  } catch (err) {
    console.error('[ADMIN PANEL ERROR]', err.message, err.stack);
    next(err);
  }
});

// ── Changelog API (used by admin.ejs AJAX fetch at /api/admin/changelog) ─────
router.get('/changelog', requireAdmin, (req, res, next) => {
  try {
    const db = getDb();
    const entries = db.prepare(
      'SELECT cl.*, u.name AS author_name FROM changelog cl LEFT JOIN users u ON u.id = cl.created_by ORDER BY cl.created_at DESC LIMIT 50'
    ).all();
    res.json({ ok: true, entries });
  } catch (err) {
    console.error('[admin] changelog GET failed:', err.message);
    res.json({ ok: true, entries: [] });
  }
});

// ── Create user ───────────────────────────────────────────────────────────────
router.post('/users/create', requireAdmin, (req, res) => {
  try {
    const db       = getDb();
    const username = validateUsername(req.body.username);
    const email    = validateEmail(req.body.email);
    const name     = sanitizeString(req.body.name, 100);
    const role     = validateRole(req.body.role);
    const password = req.body.password || '';

    if (!username || !email || !name) {
      req.session.flash = { error: 'Username, email, and name are required.' };
      return res.redirect('/admin');
    }
    if (!validatePasswordStrength(password)) {
      req.session.flash = { error: 'Password must be at least 8 characters with a letter and a number.' };
      return res.redirect('/admin');
    }

    const existing = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email);
    if (existing) {
      req.session.flash = { error: 'Username or email already exists.' };
      return res.redirect('/admin');
    }

    const now  = new Date().toISOString();
    const id   = uuidv4();
    const hash = bcrypt.hashSync(password, 12);
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, name, role, login_attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)'
    ).run(id, username, email, hash, name, role, now, now);

    try { logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_CREATED, resource_type: 'user', resource_id: id, new_value: username }); } catch (_) {}

    req.session.flash = { success: `User ${username} created.` };
    res.redirect('/admin');
  } catch (err) {
    console.error('[admin] create user failed:', err.message);
    req.session.flash = { error: 'Failed to create user: ' + err.message };
    res.redirect('/admin');
  }
});

// ── Update user ───────────────────────────────────────────────────────────────
router.post('/users/:id/edit', requireAdmin, (req, res) => {
  try {
    const db   = getDb();
    const u    = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/admin'); }

    const name  = sanitizeString(req.body.name, 100) || u.name;
    const email = validateEmail(req.body.email) || u.email;
    const role  = validateRole(req.body.role) || u.role;
    const now   = new Date().toISOString();

    if (u.id === req.session.user.id && role !== 'admin') {
      req.session.flash = { error: 'You cannot change your own role.' };
      return res.redirect('/admin');
    }

    db.prepare('UPDATE users SET name=?, email=?, role=?, updated_at=? WHERE id=?').run(name, email, role, now, u.id);
    try { logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_UPDATED, resource_type: 'user', resource_id: u.id, new_value: 'updated' }); } catch (_) {}

    req.session.flash = { success: 'User updated.' };
    res.redirect('/admin');
  } catch (err) {
    console.error('[admin] update user failed:', err.message);
    req.session.flash = { error: 'Failed to update user: ' + err.message };
    res.redirect('/admin');
  }
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  try {
    const db       = getDb();
    const password = req.body.newPassword || req.body.password || '';
    if (!validatePasswordStrength(password)) {
      req.session.flash = { error: 'Password must be at least 8 characters with a letter and a number.' };
      return res.redirect('/admin');
    }
    const hash = bcrypt.hashSync(password, 12);
    const now  = new Date().toISOString();
    db.prepare('UPDATE users SET password_hash=?, login_attempts=0, locked_until=NULL, updated_at=? WHERE id=?').run(hash, now, req.params.id);
    try { logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_PW_RESET, resource_type: 'user', resource_id: req.params.id }); } catch (_) {}
    req.session.flash = { success: 'Password reset.' };
    res.redirect('/admin');
  } catch (err) {
    console.error('[admin] reset password failed:', err.message);
    req.session.flash = { error: 'Failed to reset password: ' + err.message };
    res.redirect('/admin');
  }
});

// ── Unlock account ────────────────────────────────────────────────────────────
router.post('/users/:id/unlock', requireAdmin, (req, res) => {
  try {
    const db  = getDb();
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET login_attempts=0, locked_until=NULL, updated_at=? WHERE id=?').run(now, req.params.id);
    try { logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_UNLOCKED, resource_type: 'user', resource_id: req.params.id }); } catch (_) {}
    req.session.flash = { success: 'Account unlocked.' };
    res.redirect('/admin');
  } catch (err) {
    req.session.flash = { error: 'Failed to unlock: ' + err.message };
    res.redirect('/admin');
  }
});

// ── Delete user ───────────────────────────────────────────────────────────────
router.post('/users/:id/delete', requireAdmin, (req, res) => {
  try {
    const db   = getDb();
    const u    = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) { req.session.flash = { error: 'User not found.' }; return res.redirect('/admin'); }
    if (u.id === req.session.user.id) { req.session.flash = { error: 'Cannot delete your own account.' }; return res.redirect('/admin'); }
    db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
    try { logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_DELETED, resource_type: 'user', resource_id: req.params.id, old_value: u.username }); } catch (_) {}
    req.session.flash = { success: `User ${u.username} deleted.` };
    res.redirect('/admin');
  } catch (err) {
    req.session.flash = { error: 'Failed to delete user: ' + err.message };
    res.redirect('/admin');
  }
});

// ── Changelog CRUD ────────────────────────────────────────────────────────────
router.post('/changelog', requireAdmin, (req, res) => {
  try {
    const title       = sanitizeString(req.body.title, 200);
    const description = sanitizeString(req.body.description, 2000);
    const type        = ['new','feature','improvement','fix'].includes(req.body.type) ? req.body.type : 'feature';
    const version     = sanitizeString(req.body.version, 20) || null;

    if (!title || !description) {
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        return res.json({ ok: false, error: 'Title and description required.' });
      }
      req.session.flash = { error: 'Title and description required.' };
      return res.redirect('/admin?tab=changelog');
    }

    const db  = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO changelog (id, version, title, description, type, is_published, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)'
    ).run(uuidv4(), version, title, description, type, req.session.user.id, now, now);

    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
      return res.json({ ok: true });
    }
    req.session.flash = { success: 'Changelog entry added.' };
    res.redirect('/admin?tab=changelog');
  } catch (err) {
    console.error('[admin] changelog POST failed:', err.message);
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
      return res.json({ ok: false, error: err.message });
    }
    req.session.flash = { error: 'Failed to add entry: ' + err.message };
    res.redirect('/admin?tab=changelog');
  }
});

router.post('/changelog/:id/delete', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM changelog WHERE id=?').run(req.params.id);
    req.session.flash = { success: 'Entry deleted.' };
    res.redirect('/admin?tab=changelog');
  } catch (err) {
    req.session.flash = { error: 'Failed to delete: ' + err.message };
    res.redirect('/admin?tab=changelog');
  }
});

// ── Function Test runner ──────────────────────────────────────────────────────
router.post('/test/run', requireAdmin, (req, res) => {
  const db       = getDb();
  const user     = req.session.user;
  const scenario = req.body.scenario;
  const steps    = [];
  const now      = new Date().toISOString();

  try {
    // ── Full Ticket Workflow ───────────────────────────────────────────────
    if (scenario === 'full_ticket_workflow') {
      const ticketId     = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      db.prepare(`INSERT INTO tickets (id,ticket_number,title,description,priority,category,status,assigned_to,location,well_site,due_date,created_by,source_system,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ticketId, ticketNumber, '[TEST] Compressor A — High Discharge Temp', 'Simulated test: discharge temperature reading 285°F, threshold 270°F.', 'P2', 'mechanical', 'open', user.id, 'Pad A', 'Test Well #1', new Date(Date.now() + 24*3600000).toISOString(), user.id, 'test', now, now);
      steps.push({ ok: true, msg: `Created ${ticketNumber} (P2 / open)` });

      db.prepare(`INSERT INTO ticket_comments (id,ticket_id,user_id,body,comment_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(uuidv4(), ticketId, user.id, 'On-site: Confirmed high temp. Replacing thermocouple. ETA 2 hours.', 'note', now, now);
      steps.push({ ok: true, msg: 'Added field note comment' });

      db.prepare(`UPDATE tickets SET status='in-progress', updated_at=? WHERE id=?`).run(now, ticketId);
      steps.push({ ok: true, msg: 'Status → in-progress' });

      const clockIn = new Date(Date.now() - 90*60000).toISOString();
      db.prepare(`INSERT INTO time_entries (id,ticket_id,user_id,clock_in,clock_out,duration_minutes,notes,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(uuidv4(), ticketId, user.id, clockIn, now, 90, 'Replaced thermocouple, tested operation', now);
      steps.push({ ok: true, msg: 'Logged 90 min time entry' });

      db.prepare(`UPDATE tickets SET status='completed',finalized_at=?,finalized_by=?,updated_at=? WHERE id=?`).run(now, user.id, now, ticketId);
      steps.push({ ok: true, msg: 'Finalized (status → completed)' });

      db.prepare(`UPDATE tickets SET status='closed',closed_at=?,closed_by=?,closure_status=?,final_notes=?,resolved_at=?,updated_at=? WHERE id=?`)
        .run(now, user.id, 'resolved', 'Thermocouple replaced. Temp normalized to 245°F. Unit running normally.', now, now, ticketId);
      steps.push({ ok: true, msg: 'Closed (resolved) — full workflow complete ✓' });

      return res.json({ ok: true, scenario, steps, ticketId, ticketNumber });
    }

    // ── Inbound Call Simulation ───────────────────────────────────────────
    if (scenario === 'inbound_call') {
      const callId     = uuidv4();
      const callNumber = nextCallNumber(db);
      const names      = ['Jake Morrison','Maria Santos','Derek Fontenot','Lisa Tran'];
      const callerName = names[Math.floor(Math.random() * names.length)];
      db.prepare(`INSERT INTO nexus_calls (id,call_number,caller_name,caller_phone,caller_company,subject,description,priority,status,assigned_to,created_by,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(callId, callNumber, callerName, '(337) 555-' + String(1000 + Math.floor(Math.random()*9000)), 'Midstream Energy LLC', '[TEST] Compressor B shutdown alarm', 'Compressor B protective shutdown. Fault code E-14. Suction pressure low.', 'P2', 'queued', null, user.id, now, now, now);
      steps.push({ ok: true, msg: `Created ${callNumber} from ${callerName} (queued)` });

      db.prepare(`UPDATE nexus_calls SET assigned_to=?,status='active',updated_at=? WHERE id=?`).run(user.id, now, callId);
      steps.push({ ok: true, msg: `Assigned to ${user.name} (active)` });

      const ticketId     = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      db.prepare(`INSERT INTO tickets (id,ticket_number,title,description,priority,category,status,assigned_to,created_by,source_system,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ticketId, ticketNumber, `[TEST] Compressor B — Protective Shutdown (E-14)`, `Escalated from ${callNumber}. Caller: ${callerName}. Fault E-14, low suction pressure.`, 'P2', 'mechanical', 'open', user.id, user.id, 'test', now, now);
      steps.push({ ok: true, msg: `Created ticket ${ticketNumber} from call` });

      db.prepare(`UPDATE nexus_calls SET ticket_id=?,status='ended',ended_at=?,duration_seconds=480,notes=?,updated_at=? WHERE id=?`)
        .run(ticketId, now, 'Walked caller through fault reset. Ticket created for on-site inspection.', now, callId);
      steps.push({ ok: true, msg: `Call ended (8 min), linked to ${ticketNumber} ✓` });

      return res.json({ ok: true, scenario, steps, callId, callNumber, ticketId, ticketNumber });
    }

    // ── Fleet Alert → Ticket ─────────────────────────────────────────────
    if (scenario === 'fleet_alert') {
      const devices = [
        { id: '2504-504495', label: 'Panel',        alert: 'Low battery voltage (11.2V)',       category: 'electrical' },
        { id: '2504-505561', label: 'Compressor A', alert: 'High discharge temperature (288°F)', category: 'mechanical' },
        { id: '2504-505472', label: 'Compressor B', alert: 'Low suction pressure (42 PSI)',      category: 'mechanical' },
      ];
      const device       = devices[Math.floor(Math.random() * devices.length)];
      const ticketId     = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      db.prepare(`INSERT INTO tickets (id,ticket_number,title,description,priority,category,status,created_by,source_system,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ticketId, ticketNumber, `[TEST] Fleet Alert: ${device.label} — ${device.alert}`, `Auto-generated from MLink telemetry simulation.\nDevice: ${device.id} (${device.label})\nAlert: ${device.alert}\nTimestamp: ${now}`, 'P2', device.category, 'open', user.id, 'test', now, now);
      steps.push({ ok: true, msg: `Simulated MLink alert: ${device.label} — ${device.alert}` });
      steps.push({ ok: true, msg: `Auto-created ticket ${ticketNumber} (${device.category} / P2)` });
      db.prepare(`INSERT INTO notifications (id,user_id,ticket_id,type,message,is_read,created_at) VALUES (?,?,?,?,?,0,?)`)
        .run(uuidv4(), user.id, ticketId, 'fleet_alert', `⚠ Fleet alert: ${device.label} — ${device.alert}`, now);
      steps.push({ ok: true, msg: 'Notification sent to admin ✓' });
      return res.json({ ok: true, scenario, steps, ticketId, ticketNumber });
    }

    // ── Notification Test ────────────────────────────────────────────────
    if (scenario === 'notification_test') {
      const types = [
        { type: 'assigned',       msg: '[TEST] You have been assigned ticket TKT-TEST: Compressor B inspection' },
        { type: 'status_changed', msg: '[TEST] TKT-TEST status changed: open → in-progress' },
        { type: 'overdue',        msg: '[TEST] ⚠ Ticket TKT-TEST is overdue: Check gas pressure sensors' },
        { type: 'fleet_alert',    msg: '[TEST] Fleet alert: Panel — Low battery voltage (11.2V)' },
      ];
      for (const n of types) {
        db.prepare(`INSERT INTO notifications (id,user_id,ticket_id,type,message,is_read,created_at) VALUES (?,?,NULL,?,?,0,?)`)
          .run(uuidv4(), user.id, n.type, n.msg, now);
        steps.push({ ok: true, msg: `Sent: ${n.type}` });
      }
      return res.json({ ok: true, scenario, steps });
    }

    // ── Health Check ─────────────────────────────────────────────────────
    if (scenario === 'health_check') {
      const tables = ['users','tickets','ticket_comments','time_entries','notifications','nexus_calls','audit_logs','page_views','integrations','changelog','tech_schedules','escalation_list'];
      for (const t of tables) {
        try {
          const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get();
          steps.push({ ok: true, msg: `${t}: ${row.cnt} rows ✓` });
        } catch (e) {
          steps.push({ ok: false, msg: `${t}: MISSING — ${e.message}` });
        }
      }
      return res.json({ ok: true, scenario, steps });
    }

    // ── Cleanup ──────────────────────────────────────────────────────────
    if (scenario === 'cleanup') {
      const testTickets = db.prepare(`SELECT id FROM tickets WHERE source_system='test' OR title LIKE '[TEST]%'`).all();
      for (const t of testTickets) db.prepare('DELETE FROM tickets WHERE id=?').run(t.id);
      steps.push({ ok: true, msg: `Deleted ${testTickets.length} test tickets` });

      const testCalls = db.prepare(`SELECT id FROM nexus_calls WHERE subject LIKE '[TEST]%'`).all();
      for (const c of testCalls) db.prepare('DELETE FROM nexus_calls WHERE id=?').run(c.id);
      steps.push({ ok: true, msg: `Deleted ${testCalls.length} test calls` });

      const notifResult = db.prepare(`DELETE FROM notifications WHERE message LIKE '[TEST]%'`).run();
      steps.push({ ok: true, msg: `Cleared ${notifResult.changes} test notifications` });

      return res.json({ ok: true, scenario, steps });
    }

    return res.json({ ok: false, error: 'Unknown scenario: ' + scenario });
  } catch (err) {
    console.error('[admin/test]', err.message);
    return res.json({ ok: false, error: err.message, steps });
  }
});

module.exports = router;
