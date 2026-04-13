'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

// Provider abstraction — swap Twilio/other here later
const provider = {
  name: 'simulated',
  async initiateCall(to, from, callbackUrl) {
    // Simulate: return a fake call SID
    return { success: true, sid: 'SIM-' + uuidv4().slice(0, 8).toUpperCase(), simulated: true };
  },
  async sendSms(to, from, body) {
    console.log(`[SMS SIMULATED] To: ${to} | ${body}`);
    return { success: true, simulated: true };
  }
};

function createCallEvent({ callerPhone, callerName, unitNumber, site, issueSummary, source = 'manual' }) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO call_events (id, caller_phone, caller_name, unit_number, site, issue_summary, status, source, escalation_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, '[]', ?, ?)
  `).run(id, callerPhone || null, callerName || null, unitNumber || null, site || null, issueSummary || null, source, now, now);
  return db.prepare('SELECT * FROM call_events WHERE id=?').get(id);
}

function assignCall(callEventId, userId, via = 'manual') {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE call_events SET assigned_user_id=?, answered_by=?, status='connected', updated_at=? WHERE id=?")
    .run(userId, userId, now, callEventId);
  // Log attempt as answered
  db.prepare("INSERT INTO call_attempts (id, call_event_id, user_id, attempted_at, result) VALUES (?,?,?,?,'answered')")
    .run(uuidv4(), callEventId, userId, now);
  return db.prepare('SELECT * FROM call_events WHERE id=?').get(callEventId);
}

function escalateCall(callEventId) {
  const db = getDb();
  const event = db.prepare('SELECT * FROM call_events WHERE id=?').get(callEventId);
  if (!event) return null;

  // Get escalation list ordered by priority, only on-shift or on-call
  const list = db.prepare(`
    SELECT el.*, u.name, u.email FROM escalation_list el
    JOIN users u ON u.id = el.user_id
    WHERE el.availability IN ('on-shift','on-call')
    ORDER BY el.priority_order ASC
  `).all();

  const path = JSON.parse(event.escalation_path || '[]');
  // Find next person not already attempted
  const attempted = db.prepare('SELECT user_id FROM call_attempts WHERE call_event_id=?').all(callEventId).map(a => a.user_id);
  const next = list.find(u => !attempted.includes(u.user_id));

  const now = new Date().toISOString();
  if (!next) {
    // Nobody left — put on hold
    db.prepare("UPDATE call_events SET status='on-hold', updated_at=? WHERE id=?").run(now, callEventId);
    return { escalated: false, reason: 'No available techs' };
  }

  // Log attempt
  db.prepare("INSERT INTO call_attempts (id, call_event_id, user_id, attempted_at, result) VALUES (?,?,?,?,'no-answer')")
    .run(uuidv4(), callEventId, next.user_id, now);

  path.push({ userId: next.user_id, name: next.name, at: now });
  db.prepare("UPDATE call_events SET status='escalating', escalation_path=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(path), now, callEventId);

  return { escalated: true, assignedTo: next };
}

function endCall(callEventId, durationSeconds, transcript = null) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE call_events SET status='completed', duration_seconds=?, transcript=?, updated_at=? WHERE id=?")
    .run(durationSeconds || 0, transcript || null, now, callEventId);
  return db.prepare('SELECT * FROM call_events WHERE id=?').get(callEventId);
}

function linkTicket(callEventId, ticketId) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE call_events SET linked_ticket_id=?, updated_at=? WHERE id=?').run(ticketId, now, callEventId);
  db.prepare('UPDATE tickets SET call_event_id=?, updated_at=? WHERE id=?').run(callEventId, now, ticketId);
}

function checkRepeatIssue(unitNumber, excludeTicketId) {
  if (!unitNumber) return null;
  const db = getDb();
  const since = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
  return db.prepare(`
    SELECT * FROM tickets WHERE unit_number=? AND id!=? AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(unitNumber, excludeTicketId || '', since);
}

function generateSimulatedTranscript(callerName, unitNumber, issueSummary) {
  const name = callerName || 'Caller';
  const unit = unitNumber || 'the unit';
  const issue = issueSummary || 'an issue';
  return [
    `AI: Thank you for calling Tech Service. How can I help you today?`,
    `${name}: Hi, I'm calling about ${unit}. ${issue}`,
    `AI: I understand. Can you describe when this started and any warning lights or alarms?`,
    `${name}: It started earlier today. There's a high temp alarm showing on the panel.`,
    `AI: Got it. I'm creating a work order for this now and routing to the next available technician.`,
    `${name}: How long will it take?`,
    `AI: A technician will be in contact within the hour. Your ticket number will be sent by text. Is there anything else?`,
    `${name}: No that's it, thank you.`,
    `AI: Thank you for calling. Have a good day.`,
  ].join('\n');
}

module.exports = { createCallEvent, assignCall, escalateCall, endCall, linkTicket, checkRepeatIssue, generateSimulatedTranscript, provider };
