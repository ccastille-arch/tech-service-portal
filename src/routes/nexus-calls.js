'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextCallNumber } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/authenticate');
const { ticketScopeClause } = require('../middleware/authorize');
const { sanitizeString, validatePriority, validateSortCol } = require('../middleware/validate');
const { logAudit, AUDIT_ACTIONS, actorFromReq } = require('../services/audit');
const router = express.Router();

const ALLOWED_CALL_STATUSES = ['queued','active','on-hold','transferred','ended','escalated'];
const ALLOWED_AVAILABILITY  = ['on-shift','on-call','unavailable','out-of-service'];

// ── Call list / dashboard ─────────────────────────────────────────────────────
router.get('/calls', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;

  let sql = `
    SELECT nc.*, u.name as assigned_name, t.ticket_number
    FROM nexus_calls nc
    LEFT JOIN users u ON u.id = nc.assigned_to
    LEFT JOIN tickets t ON t.id = nc.ticket_id
    WHERE 1=1
  `;
  const params = [];

  // Techs only see calls assigned to them or created by them
  if (user.role !== 'admin') {
    sql += ' AND (nc.assigned_to = ? OR nc.created_by = ?)';
    params.push(user.id, user.id);
  }

  sql += ' ORDER BY nc.created_at DESC LIMIT 100';

  const calls = db.prepare(sql).all(...params);
  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  res.render('calls', {
    title: 'Call Operations',
    calls, techs,
    user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// ── Create call ───────────────────────────────────────────────────────────────
router.post('/calls/create', requireAuth, (req, res) => {
  const db           = getDb();
  const user         = req.session.user;
  const subject      = sanitizeString(req.body.subject, 200);
  const description  = sanitizeString(req.body.description, 2000);
  const caller_name  = sanitizeString(req.body.caller_name, 100);
  const caller_phone = sanitizeString(req.body.caller_phone, 30);
  const caller_company = sanitizeString(req.body.caller_company, 100);
  const priority     = validatePriority(req.body.priority);
  const assigned_to  = req.body.assigned_to || null;

  if (!subject) {
    req.session.flash = { error: 'Subject is required.' };
    return res.redirect('/nexus/calls');
  }

  const now         = new Date().toISOString();
  const id          = uuidv4();
  const call_number = nextCallNumber(db);

  db.prepare(`
    INSERT INTO nexus_calls (id, call_number, caller_name, caller_phone, caller_company, subject, description, priority, status, assigned_to, started_at, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)
  `).run(id, call_number, caller_name || null, caller_phone || null, caller_company || null, subject, description || null, priority, assigned_to, now, user.id, now, now);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CALL_CREATED, resource_type: 'nexus_call', resource_id: id, new_value: call_number });

  req.session.flash = { success: `Call ${call_number} created.` };
  res.redirect('/nexus/calls');
});

// ── Assign call ───────────────────────────────────────────────────────────────
router.post('/calls/:id/assign', requireAuth, (req, res) => {
  const db          = getDb();
  const call        = db.prepare('SELECT * FROM nexus_calls WHERE id=?').get(req.params.id);
  if (!call) return res.redirect('/nexus/calls');

  const assigned_to = req.body.assigned_to || null;
  const now         = new Date().toISOString();
  db.prepare('UPDATE nexus_calls SET assigned_to=?, status=?, updated_at=? WHERE id=?')
    .run(assigned_to, 'active', now, call.id);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CALL_ASSIGNED, resource_type: 'nexus_call', resource_id: call.id });
  req.session.flash = { success: 'Call assigned.' };
  res.redirect('/nexus/calls');
});

// ── End call ──────────────────────────────────────────────────────────────────
router.post('/calls/:id/end', requireAuth, (req, res) => {
  const db   = getDb();
  const call = db.prepare('SELECT * FROM nexus_calls WHERE id=?').get(req.params.id);
  if (!call) return res.redirect('/nexus/calls');

  const notes   = sanitizeString(req.body.notes, 2000);
  const rawSecs = parseInt(req.body.durationSeconds) || 0;
  const duration = Math.max(0, Math.min(rawSecs, 86400));
  const now     = new Date().toISOString();

  db.prepare('UPDATE nexus_calls SET status=?, ended_at=?, duration_seconds=?, notes=?, updated_at=? WHERE id=?')
    .run('ended', now, duration || null, notes || null, now, call.id);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CALL_ENDED, resource_type: 'nexus_call', resource_id: call.id, new_value: `${duration}s` });
  req.session.flash = { success: 'Call ended.' };
  res.redirect('/nexus/calls');
});

// ── Escalate call ─────────────────────────────────────────────────────────────
router.post('/calls/:id/escalate', requireAuth, (req, res) => {
  const db   = getDb();
  const call = db.prepare('SELECT * FROM nexus_calls WHERE id=?').get(req.params.id);
  if (!call) return res.redirect('/nexus/calls');

  const now = new Date().toISOString();
  db.prepare('UPDATE nexus_calls SET status=?, updated_at=? WHERE id=?').run('escalated', now, call.id);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.CALL_ESCALATED, resource_type: 'nexus_call', resource_id: call.id });
  req.session.flash = { success: 'Call escalated.' };
  res.redirect('/nexus/calls');
});

// ── Convert call to ticket ────────────────────────────────────────────────────
router.post('/calls/:id/to-ticket', requireAuth, (req, res) => {
  const db   = getDb();
  const call = db.prepare('SELECT * FROM nexus_calls WHERE id=?').get(req.params.id);
  if (!call) return res.redirect('/nexus/calls');

  const { nextTicketNumber } = require('../database');
  const { validateCategory, validatePriority: vp } = require('../middleware/validate');

  const ticket_id     = uuidv4();
  const ticket_number = nextTicketNumber(db);
  const now           = new Date().toISOString();
  const user          = req.session.user;
  const priority      = vp(call.priority) || 'P3';
  const category      = validateCategory(req.body.category) || 'general';

  db.prepare(`
    INSERT INTO tickets (id, ticket_number, title, description, priority, category, status, assigned_to, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'open',?,?,?,?)
  `).run(ticket_id, ticket_number, call.subject, call.description || null, priority, category, call.assigned_to, user.id, now, now);

  db.prepare('UPDATE nexus_calls SET ticket_id=?, updated_at=? WHERE id=?').run(ticket_id, now, call.id);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_CREATED, resource_type: 'ticket', resource_id: ticket_id, new_value: `from call ${call.call_number}` });
  req.session.flash = { success: `Ticket ${ticket_number} created from call.` };
  res.redirect(`/tickets/${ticket_id}`);
});

// ── Scheduler page ─────────────────────────────────────────────────────────────
router.get('/scheduler', requireAdmin, (req, res) => {
  try {
    const db   = getDb();
    const user = req.session.user;

    // Build 7-day date array starting today
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const techs = db.prepare("SELECT id, name, role FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

    // Build schedule map: { user_id: { date: entry } }
    const entries = db.prepare(
      `SELECT * FROM tech_schedules WHERE date >= ? AND date <= ?`
    ).all(dates[0], dates[6]);
    const scheduleMap = {};
    for (const e of entries) {
      if (!scheduleMap[e.user_id]) scheduleMap[e.user_id] = {};
      scheduleMap[e.user_id][e.date] = e;
    }

    // Escalation list for sidebar
    let escalationList = db.prepare(
      'SELECT el.*, u.name, u.role FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order'
    ).all();
    // Auto-seed if empty
    if (escalationList.length === 0) {
      const now = new Date().toISOString();
      const allUsers = db.prepare("SELECT id FROM users WHERE role IN ('admin','tech') ORDER BY name").all();
      for (let i = 0; i < allUsers.length; i++) {
        try { db.prepare('INSERT OR IGNORE INTO escalation_list (id, user_id, availability, priority_order, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(require('crypto').randomUUID(), allUsers[i].id, 'on-shift', i, now, now); } catch (_) {}
      }
      escalationList = db.prepare('SELECT el.*, u.name, u.role FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order').all();
    }

    res.render('scheduler', {
      title: 'Tech Scheduler',
      dates, techs, scheduleMap, escalationList,
      user, unreadCount: res.locals.unreadCount,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    console.error('[scheduler]', err.message);
    req.session.flash = { error: err.message };
    res.redirect('/dashboard');
  }
});

// ── Save schedule entry ────────────────────────────────────────────────────────
router.post('/scheduler/save', requireAdmin, (req, res) => {
  try {
    const db        = getDb();
    const { userId, date, shiftStart, shiftEnd, onCall, notes } = req.body;
    if (!userId || !date) return res.json({ ok: false, error: 'userId and date required' });
    const now = new Date().toISOString();
    const onCallBit = (onCall === 'true' || onCall === true) ? 1 : 0;
    db.prepare(`
      INSERT INTO tech_schedules (id, user_id, date, shift_start, shift_end, on_call, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        shift_start=excluded.shift_start, shift_end=excluded.shift_end,
        on_call=excluded.on_call, notes=excluded.notes, updated_at=excluded.updated_at
    `).run(require('crypto').randomUUID(), userId, date, shiftStart || null, shiftEnd || null, onCallBit, notes || null, now, now);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Escalation page ────────────────────────────────────────────────────────────
router.get('/escalation', requireAdmin, (req, res) => {
  try {
    const db   = getDb();
    const user = req.session.user;
    const now  = new Date().toISOString();

    let escalationList = db.prepare(
      'SELECT el.*, u.name, u.role, u.email FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order'
    ).all();

    // Auto-seed if empty
    if (escalationList.length === 0) {
      const allUsers = db.prepare("SELECT id FROM users WHERE role IN ('admin','tech') ORDER BY name").all();
      for (let i = 0; i < allUsers.length; i++) {
        try { db.prepare('INSERT OR IGNORE INTO escalation_list (id, user_id, availability, priority_order, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(require('crypto').randomUUID(), allUsers[i].id, 'on-shift', i, now, now); } catch (_) {}
      }
      escalationList = db.prepare('SELECT el.*, u.name, u.role, u.email FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order').all();
    }

    res.render('escalation', {
      title: 'Escalation Order',
      escalationList,
      user, unreadCount: res.locals.unreadCount,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    console.error('[escalation]', err.message);
    req.session.flash = { error: err.message };
    res.redirect('/dashboard');
  }
});

// ── Save escalation order ─────────────────────────────────────────────────────
router.post('/escalation/reorder', requireAdmin, (req, res) => {
  try {
    const db    = getDb();
    const order = req.body.order;
    if (!Array.isArray(order)) return res.json({ ok: false, error: 'order must be array' });
    const now = new Date().toISOString();
    for (const item of order) {
      db.prepare('UPDATE escalation_list SET priority_order=?, availability=?, updated_at=? WHERE user_id=?')
        .run(item.priorityOrder, item.availability || 'on-shift', now, item.userId);
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Update availability ────────────────────────────────────────────────────────
router.post('/escalation/availability', requireAdmin, (req, res) => {
  try {
    const db  = getDb();
    const { userId, availability } = req.body;
    const allowed = ['on-shift','on-call','unavailable','out-of-service'];
    if (!userId || !allowed.includes(availability)) return res.json({ ok: false, error: 'Invalid' });
    db.prepare('UPDATE escalation_list SET availability=?, updated_at=? WHERE user_id=?')
      .run(availability, new Date().toISOString(), userId);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
