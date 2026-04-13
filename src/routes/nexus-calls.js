'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/authenticate');
const callService = require('../services/call-service');

const router = express.Router();

// ─── Call Dashboard ────────────────────────────────────────────────────────────

router.get('/calls', requireAuth, (req, res) => {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const activeCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name
    FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id
    WHERE ce.status = 'active'
    ORDER BY ce.created_at ASC
  `).all();

  const onHoldCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name
    FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id
    WHERE ce.status = 'on-hold'
    ORDER BY ce.created_at ASC
  `).all();

  const escalatingCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name
    FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id
    WHERE ce.status = 'escalating'
    ORDER BY ce.created_at ASC
  `).all();

  const completedToday = db.prepare(`
    SELECT ce.*, u.name as assigned_name
    FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id
    WHERE ce.status = 'completed' AND ce.updated_at >= ?
    ORDER BY ce.updated_at DESC
    LIMIT 10
  `).all(todayStart.toISOString());

  const escalationList = db.prepare(`
    SELECT el.*, u.name, u.email, u.role
    FROM escalation_list el
    JOIN users u ON u.id = el.user_id
    ORDER BY el.priority_order ASC
  `).all();

  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  res.render('call-dashboard', {
    title: 'Call Operations Center',
    activeCalls, onHoldCalls, escalatingCalls, completedToday,
    escalationList, techs,
    user: req.session.user,
    unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// ─── Create new call event ─────────────────────────────────────────────────────

router.post('/calls/create', requireAuth, (req, res) => {
  try {
    const { callerPhone, callerName, unitNumber, site, issueSummary, createTicket, priority, category } = req.body;

    const callEvent = callService.createCallEvent({ callerPhone, callerName, unitNumber, site, issueSummary, source: 'manual' });

    let ticket = null;
    let repeatIssue = null;

    if (createTicket === 'true' || createTicket === '1' || createTicket === true) {
      const db = getDb();
      const now = new Date().toISOString();
      const ticketId = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      const dueDate = new Date(Date.now() + 24 * 3600000).toISOString().slice(0, 10);

      repeatIssue = callService.checkRepeatIssue(unitNumber, ticketId);

      const transcript = callService.generateSimulatedTranscript(callerName, unitNumber, issueSummary);

      db.prepare(`
        INSERT INTO tickets (
          id, ticket_number, title, description, priority, category, status,
          created_by, location, well_site, due_date,
          call_event_id, call_source, caller_name, caller_phone,
          unit_number, site, call_transcript,
          repeat_issue_flag, previous_ticket_id,
          assigned_via, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        ticketId, ticketNumber,
        issueSummary ? `${issueSummary.slice(0, 80)}` : 'Inbound Call Issue',
        issueSummary || '',
        priority || 'P3',
        category || 'general',
        'open',
        req.session.user.id,
        site || null, site || null,
        dueDate,
        callEvent.id, 'manual',
        callerName || null, callerPhone || null,
        unitNumber || null, site || null,
        transcript,
        repeatIssue ? 1 : 0,
        repeatIssue ? repeatIssue.id : null,
        'manual',
        now, now
      );

      callService.linkTicket(callEvent.id, ticketId);
      ticket = { id: ticketId, ticket_number: ticketNumber };
    } else {
      repeatIssue = callService.checkRepeatIssue(unitNumber, null);
    }

    return res.json({ ok: true, callEvent, ticket, repeatIssue });
  } catch (err) {
    console.error('[nexus/calls/create]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Assign call ──────────────────────────────────────────────────────────────

router.post('/calls/:id/assign', requireAuth, (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    const event = callService.assignCall(req.params.id, userId);
    if (!event) return res.status(404).json({ ok: false, error: 'Call event not found' });
    return res.json({ ok: true, callEvent: event });
  } catch (err) {
    console.error('[nexus/calls/assign]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Escalate call ────────────────────────────────────────────────────────────

router.post('/calls/:id/escalate', requireAuth, (req, res) => {
  try {
    const result = callService.escalateCall(req.params.id);
    if (!result) return res.status(404).json({ ok: false, error: 'Call event not found' });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[nexus/calls/escalate]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── End call ─────────────────────────────────────────────────────────────────

router.post('/calls/:id/end', requireAuth, (req, res) => {
  try {
    const { durationSeconds, transcript } = req.body;
    const event = callService.endCall(req.params.id, parseInt(durationSeconds) || 0, transcript || null);
    if (!event) return res.status(404).json({ ok: false, error: 'Call event not found' });
    return res.json({ ok: true, callEvent: event });
  } catch (err) {
    console.error('[nexus/calls/end]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Create ticket from existing call ────────────────────────────────────────

router.post('/calls/:id/create-ticket', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const callEvent = db.prepare('SELECT * FROM call_events WHERE id=?').get(req.params.id);
    if (!callEvent) return res.status(404).json({ ok: false, error: 'Call event not found' });

    const { title, description, priority, category, assignedTo } = req.body;
    const now = new Date().toISOString();
    const ticketId = uuidv4();
    const ticketNumber = nextTicketNumber(db);
    const dueDate = new Date(Date.now() + 24 * 3600000).toISOString().slice(0, 10);

    const repeatIssue = callService.checkRepeatIssue(callEvent.unit_number, ticketId);
    const transcript = callEvent.transcript || callService.generateSimulatedTranscript(callEvent.caller_name, callEvent.unit_number, callEvent.issue_summary);

    db.prepare(`
      INSERT INTO tickets (
        id, ticket_number, title, description, priority, category, status,
        assigned_to, created_by, location, well_site, due_date,
        call_event_id, call_source, caller_name, caller_phone,
        unit_number, site, call_transcript,
        repeat_issue_flag, previous_ticket_id,
        assigned_via, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      ticketId, ticketNumber,
      title || callEvent.issue_summary || 'Call Issue',
      description || callEvent.issue_summary || '',
      priority || 'P3',
      category || 'general',
      'open',
      assignedTo || null,
      req.session.user.id,
      callEvent.site || null, callEvent.site || null,
      dueDate,
      callEvent.id, callEvent.source || 'manual',
      callEvent.caller_name || null, callEvent.caller_phone || null,
      callEvent.unit_number || null, callEvent.site || null,
      transcript,
      repeatIssue ? 1 : 0,
      repeatIssue ? repeatIssue.id : null,
      'manual',
      now, now
    );

    callService.linkTicket(callEvent.id, ticketId);

    return res.json({ ok: true, ticketId, ticketNumber });
  } catch (err) {
    console.error('[nexus/calls/create-ticket]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Live status polling endpoint ─────────────────────────────────────────────

router.get('/calls/api/status', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const counts = {
      active: db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='active'").get().c,
      onHold: db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='on-hold'").get().c,
      escalating: db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='escalating'").get().c,
      completedToday: db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='completed' AND updated_at >= ?").get(todayStart.toISOString()).c,
    };

    const activeCalls = db.prepare(`
      SELECT ce.*, u.name as assigned_name
      FROM call_events ce
      LEFT JOIN users u ON u.id = ce.assigned_user_id
      WHERE ce.status IN ('active','on-hold','escalating')
      ORDER BY ce.created_at ASC
    `).all();

    return res.json({ ok: true, counts, activeCalls });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Escalation List ──────────────────────────────────────────────────────────

router.get('/escalation', requireAdmin, (req, res) => {
  const db = getDb();
  const escalationList = db.prepare(`
    SELECT el.*, u.name, u.email, u.role
    FROM escalation_list el
    JOIN users u ON u.id = el.user_id
    ORDER BY el.priority_order ASC
  `).all();

  res.render('escalation', {
    title: 'Escalation Order',
    escalationList,
    user: req.session.user,
    unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

router.post('/escalation/reorder', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'order must be array' });
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE escalation_list SET priority_order=?, availability=?, updated_at=? WHERE user_id=?');
    for (const item of order) {
      stmt.run(item.priorityOrder, item.availability, now, item.userId);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/escalation/reorder]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/escalation/availability', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { userId, availability } = req.body;
    if (!userId || !availability) return res.status(400).json({ ok: false, error: 'userId and availability required' });
    const now = new Date().toISOString();
    db.prepare('UPDATE escalation_list SET availability=?, updated_at=? WHERE user_id=?').run(availability, now, userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/escalation/availability]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Tech Scheduler ───────────────────────────────────────────────────────────

router.get('/scheduler', requireAdmin, (req, res) => {
  const db = getDb();

  // Build 7 dates starting today
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const techs = db.prepare("SELECT id, name, role FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  // Get all schedule entries for the 7-day window
  const scheduleRows = db.prepare(`
    SELECT * FROM tech_schedule WHERE date >= ? AND date <= ?
  `).all(dates[0], dates[6]);

  // Build lookup: scheduleMap[userId][date] = row
  const scheduleMap = {};
  for (const row of scheduleRows) {
    if (!scheduleMap[row.user_id]) scheduleMap[row.user_id] = {};
    scheduleMap[row.user_id][row.date] = row;
  }

  const escalationList = db.prepare(`
    SELECT el.*, u.name FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order ASC
  `).all();

  res.render('scheduler', {
    title: 'Tech Scheduler',
    dates, techs, scheduleMap, escalationList,
    user: req.session.user,
    unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

router.post('/scheduler/save', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const { userId, date, shiftStart, shiftEnd, onCall, notes } = req.body;
    if (!userId || !date) return res.status(400).json({ ok: false, error: 'userId and date required' });
    const now = new Date().toISOString();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO tech_schedule (id, user_id, date, shift_start, shift_end, on_call, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        shift_start=excluded.shift_start,
        shift_end=excluded.shift_end,
        on_call=excluded.on_call,
        notes=excluded.notes,
        updated_at=excluded.updated_at
    `).run(id, userId, date, shiftStart || null, shiftEnd || null, onCall === 'true' || onCall === '1' || onCall === true ? 1 : 0, notes || null, now, now);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/scheduler/save]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
