'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/authenticate');
const callService = require('../services/call-service');
const { logAudit, actorFromReq, AUDIT_ACTIONS } = require('../services/audit');
const { sanitizeString, validatePriority, validateCategory, validateDate } = require('../middleware/validate');

const router = express.Router();

// Nexus audit actions (extend base set)
const NX = {
  CALL_CREATED:   'nexus.call.created',
  CALL_ASSIGNED:  'nexus.call.assigned',
  CALL_ESCALATED: 'nexus.call.escalated',
  CALL_ENDED:     'nexus.call.ended',
  TICKET_CREATED: 'nexus.ticket.created',
};

// ─── Call Dashboard ────────────────────────────────────────────────────────────

router.get('/calls', requireAuth, (req, res) => {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const activeCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id WHERE ce.status = 'active' ORDER BY ce.created_at ASC
  `).all();
  const onHoldCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id WHERE ce.status = 'on-hold' ORDER BY ce.created_at ASC
  `).all();
  const escalatingCalls = db.prepare(`
    SELECT ce.*, u.name as assigned_name FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id WHERE ce.status = 'escalating' ORDER BY ce.created_at ASC
  `).all();
  const completedToday = db.prepare(`
    SELECT ce.*, u.name as assigned_name FROM call_events ce
    LEFT JOIN users u ON u.id = ce.assigned_user_id
    WHERE ce.status = 'completed' AND ce.updated_at >= ? ORDER BY ce.updated_at DESC LIMIT 10
  `).all(todayStart.toISOString());
  const escalationList = db.prepare(`
    SELECT el.*, u.name, u.email, u.role FROM escalation_list el
    JOIN users u ON u.id = el.user_id ORDER BY el.priority_order ASC
  `).all();
  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  res.render('call-dashboard', {
    title: 'Call Operations Center',
    activeCalls, onHoldCalls, escalatingCalls, completedToday, escalationList, techs,
    user: req.session.user, unreadCount: res.locals.unreadCount, csrfToken: res.locals.csrfToken
  });
});

// ─── Create new call event ─────────────────────────────────────────────────────

router.post('/calls/create', requireAuth, (req, res) => {
  try {
    // Sanitize all inputs
    const callerPhone   = sanitizeString(req.body.callerPhone, 30);
    const callerName    = sanitizeString(req.body.callerName, 100);
    const unitNumber    = sanitizeString(req.body.unitNumber, 100);
    const site          = sanitizeString(req.body.site, 200);
    const issueSummary  = sanitizeString(req.body.issueSummary, 1000);
    const priority      = validatePriority(req.body.priority) || 'P3';
    const category      = validateCategory(req.body.category) || 'general';
    const createTicket  = req.body.createTicket === 'true' || req.body.createTicket === '1';

    const callEvent = callService.createCallEvent({ callerPhone, callerName, unitNumber, site, issueSummary, source: 'manual' });

    logAudit(getDb(), {
      ...actorFromReq(req),
      action: NX.CALL_CREATED,
      resource_type: 'call_event', resource_id: callEvent.id,
      new_value: `unit=${unitNumber || 'unknown'} site=${site || 'unknown'}`,
    });

    let ticket = null;
    let repeatIssue = null;

    if (createTicket) {
      const db = getDb();
      const now          = new Date().toISOString();
      const ticketId     = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      const dueDate      = new Date(Date.now() + 24 * 3600000).toISOString().slice(0, 10);

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
        issueSummary ? issueSummary.slice(0, 80) : 'Inbound Call Issue',
        issueSummary || '',
        priority, category, 'open',
        req.session.user.id,
        site, site, dueDate,
        callEvent.id, 'manual',
        callerName, callerPhone,
        unitNumber, site, transcript,
        repeatIssue ? 1 : 0,
        repeatIssue ? repeatIssue.id : null,
        'manual', now, now
      );
      callService.linkTicket(callEvent.id, ticketId);
      logAudit(db, {
        ...actorFromReq(req),
        action: NX.TICKET_CREATED,
        resource_type: 'ticket', resource_id: ticketId,
        new_value: `${ticketNumber} from call ${callEvent.id}`,
      });
      ticket = { id: ticketId, ticket_number: ticketNumber };
    } else {
      repeatIssue = callService.checkRepeatIssue(unitNumber, null);
    }

    return res.json({ ok: true, callEvent, ticket, repeatIssue });
  } catch (err) {
    console.error('[nexus/calls/create]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to create call event.' });
  }
});

// ─── Assign call ──────────────────────────────────────────────────────────────

router.post('/calls/:id/assign', requireAuth, (req, res) => {
  try {
    const callId = sanitizeString(req.params.id, 36);
    const userId = sanitizeString(req.body.userId, 36);
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    const event = callService.assignCall(callId, userId);
    if (!event) return res.status(404).json({ ok: false, error: 'Call event not found' });
    logAudit(getDb(), { ...actorFromReq(req), action: NX.CALL_ASSIGNED, resource_type: 'call_event', resource_id: callId, new_value: `assigned to userId=${userId}` });
    return res.json({ ok: true, callEvent: event });
  } catch (err) {
    console.error('[nexus/calls/assign]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to assign call.' });
  }
});

// ─── Escalate call ────────────────────────────────────────────────────────────

router.post('/calls/:id/escalate', requireAuth, (req, res) => {
  try {
    const callId = sanitizeString(req.params.id, 36);
    const result = callService.escalateCall(callId);
    if (!result) return res.status(404).json({ ok: false, error: 'Call event not found' });
    logAudit(getDb(), { ...actorFromReq(req), action: NX.CALL_ESCALATED, resource_type: 'call_event', resource_id: callId });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[nexus/calls/escalate]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to escalate call.' });
  }
});

// ─── End call ─────────────────────────────────────────────────────────────────

router.post('/calls/:id/end', requireAuth, (req, res) => {
  try {
    const callId  = sanitizeString(req.params.id, 36);
    const duration = Math.max(0, Math.min(parseInt(req.body.durationSeconds) || 0, 86400)); // cap at 24h
    const transcript = sanitizeString(req.body.transcript, 5000);
    const event = callService.endCall(callId, duration, transcript);
    if (!event) return res.status(404).json({ ok: false, error: 'Call event not found' });
    logAudit(getDb(), { ...actorFromReq(req), action: NX.CALL_ENDED, resource_type: 'call_event', resource_id: callId, new_value: `duration=${duration}s` });
    return res.json({ ok: true, callEvent: event });
  } catch (err) {
    console.error('[nexus/calls/end]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to end call.' });
  }
});

// ─── Create ticket from existing call ────────────────────────────────────────

router.post('/calls/:id/create-ticket', requireAuth, (req, res) => {
  try {
    const db       = getDb();
    const callId   = sanitizeString(req.params.id, 36);
    const callEvent = db.prepare('SELECT * FROM call_events WHERE id=?').get(callId);
    if (!callEvent) return res.status(404).json({ ok: false, error: 'Call event not found' });

    const title       = sanitizeString(req.body.title, 300)       || callEvent.issue_summary || 'Call Issue';
    const description = sanitizeString(req.body.description, 5000) || callEvent.issue_summary || '';
    const priority    = validatePriority(req.body.priority)   || 'P3';
    const category    = validateCategory(req.body.category)   || 'general';
    const assignedTo  = sanitizeString(req.body.assignedTo, 36) || null;

    const now          = new Date().toISOString();
    const ticketId     = uuidv4();
    const ticketNumber = nextTicketNumber(db);
    const dueDate      = new Date(Date.now() + 24 * 3600000).toISOString().slice(0, 10);
    const repeatIssue  = callService.checkRepeatIssue(callEvent.unit_number, ticketId);
    const transcript   = callEvent.transcript || callService.generateSimulatedTranscript(callEvent.caller_name, callEvent.unit_number, callEvent.issue_summary);

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
      ticketId, ticketNumber, title, description, priority, category, 'open',
      assignedTo, req.session.user.id,
      callEvent.site, callEvent.site, dueDate,
      callEvent.id, callEvent.source || 'manual',
      callEvent.caller_name, callEvent.caller_phone,
      callEvent.unit_number, callEvent.site, transcript,
      repeatIssue ? 1 : 0, repeatIssue ? repeatIssue.id : null,
      'manual', now, now
    );
    callService.linkTicket(callEvent.id, ticketId);
    logAudit(db, { ...actorFromReq(req), action: NX.TICKET_CREATED, resource_type: 'ticket', resource_id: ticketId, new_value: `${ticketNumber} from call ${callEvent.id}` });

    return res.json({ ok: true, ticketId, ticketNumber });
  } catch (err) {
    console.error('[nexus/calls/create-ticket]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to create ticket.' });
  }
});

// ─── Live status polling ──────────────────────────────────────────────────────

router.get('/calls/api/status', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const counts = {
      active:         db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='active'").get().c,
      onHold:         db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='on-hold'").get().c,
      escalating:     db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='escalating'").get().c,
      completedToday: db.prepare("SELECT COUNT(*) as c FROM call_events WHERE status='completed' AND updated_at >= ?").get(todayStart.toISOString()).c,
    };
    const activeCalls = db.prepare(`
      SELECT ce.*, u.name as assigned_name FROM call_events ce
      LEFT JOIN users u ON u.id = ce.assigned_user_id
      WHERE ce.status IN ('active','on-hold','escalating') ORDER BY ce.created_at ASC
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
    SELECT el.*, u.name, u.email, u.role FROM escalation_list el
    JOIN users u ON u.id = el.user_id ORDER BY el.priority_order ASC
  `).all();
  res.render('escalation', { title: 'Escalation Order', escalationList, user: req.session.user, unreadCount: res.locals.unreadCount, csrfToken: res.locals.csrfToken });
});

router.post('/escalation/reorder', requireAdmin, (req, res) => {
  try {
    const db    = getDb();
    const order = req.body.order;
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'order must be array' });
    const now  = new Date().toISOString();
    const stmt = db.prepare('UPDATE escalation_list SET priority_order=?, availability=?, updated_at=? WHERE user_id=?');
    for (const item of order) {
      const uid   = sanitizeString(String(item.userId), 36);
      const avail = ['on-shift','on-call','unavailable','out-of-service'].includes(item.availability) ? item.availability : 'unavailable';
      stmt.run(parseInt(item.priorityOrder) || 0, avail, now, uid);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/escalation/reorder]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to reorder.' });
  }
});

router.post('/escalation/availability', requireAdmin, (req, res) => {
  try {
    const db           = getDb();
    const userId       = sanitizeString(req.body.userId, 36);
    const availability = ['on-shift','on-call','unavailable','out-of-service'].includes(req.body.availability) ? req.body.availability : null;
    if (!userId || !availability) return res.status(400).json({ ok: false, error: 'userId and valid availability required' });
    db.prepare('UPDATE escalation_list SET availability=?, updated_at=? WHERE user_id=?').run(availability, new Date().toISOString(), userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/escalation/availability]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to update availability.' });
  }
});

// ─── Tech Scheduler ───────────────────────────────────────────────────────────

router.get('/scheduler', requireAdmin, (req, res) => {
  const db    = getDb();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const techs        = db.prepare("SELECT id, name, role FROM users WHERE role IN ('admin','tech') ORDER BY name").all();
  const scheduleRows = db.prepare('SELECT * FROM tech_schedule WHERE date >= ? AND date <= ?').all(dates[0], dates[6]);
  const scheduleMap  = {};
  for (const row of scheduleRows) {
    if (!scheduleMap[row.user_id]) scheduleMap[row.user_id] = {};
    scheduleMap[row.user_id][row.date] = row;
  }
  const escalationList = db.prepare('SELECT el.*, u.name FROM escalation_list el JOIN users u ON u.id = el.user_id ORDER BY el.priority_order ASC').all();
  res.render('scheduler', { title: 'Tech Scheduler', dates, techs, scheduleMap, escalationList, user: req.session.user, unreadCount: res.locals.unreadCount, csrfToken: res.locals.csrfToken });
});

router.post('/scheduler/save', requireAdmin, (req, res) => {
  try {
    const db      = getDb();
    const userId  = sanitizeString(req.body.userId, 36);
    const date    = validateDate(req.body.date);
    if (!userId || !date) return res.status(400).json({ ok: false, error: 'Valid userId and date required' });
    const shiftStart = sanitizeString(req.body.shiftStart, 10);
    const shiftEnd   = sanitizeString(req.body.shiftEnd, 10);
    const onCall     = req.body.onCall === 'true' || req.body.onCall === '1' || req.body.onCall === true ? 1 : 0;
    const notes      = sanitizeString(req.body.notes, 500);
    const now        = new Date().toISOString();
    db.prepare(`
      INSERT INTO tech_schedule (id, user_id, date, shift_start, shift_end, on_call, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        shift_start=excluded.shift_start, shift_end=excluded.shift_end,
        on_call=excluded.on_call, notes=excluded.notes, updated_at=excluded.updated_at
    `).run(uuidv4(), userId, date, shiftStart, shiftEnd, onCall, notes, now, now);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[nexus/scheduler/save]', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save schedule.' });
  }
});

module.exports = router;
