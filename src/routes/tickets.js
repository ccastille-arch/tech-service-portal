'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber } = require('../database');
const { requireAuth } = require('../middleware/authenticate');
const { getSlaStatus, getDefaultDueDate } = require('../services/sla');
const { notifyAssignment, notifyStatusChange } = require('../services/notifications');
const router = express.Router();

// Multer setup
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf|heic/i;
    cb(null, allowed.test(file.mimetype) || allowed.test(path.extname(file.originalname)));
  }
});

// List tickets
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { status, priority, assigned, category, from, to, sort = 'created_at', order = 'desc', q } = req.query;

  let sql = `
    SELECT t.*, u.name as assigned_name, c.name as creator_name
    FROM tickets t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    WHERE 1=1
  `;
  const params = [];

  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (priority) { sql += ' AND t.priority = ?'; params.push(priority); }
  if (assigned) { sql += ' AND t.assigned_to = ?'; params.push(assigned); }
  if (category) { sql += ' AND t.category = ?'; params.push(category); }
  if (from) { sql += ' AND t.created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND t.created_at <= ?'; params.push(to + 'T23:59:59'); }
  if (q) { sql += ' AND (t.title LIKE ? OR t.description LIKE ? OR t.ticket_number LIKE ? OR t.well_site LIKE ?)'; const like = `%${q}%`; params.push(like, like, like, like); }

  const validCols = ['created_at', 'updated_at', 'priority', 'status', 'due_date', 'ticket_number'];
  const sortCol = validCols.includes(sort) ? sort : 'created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY t.${sortCol} ${sortDir}`;

  const tickets = db.prepare(sql).all(...params).map(t => ({ ...t, slaStatus: getSlaStatus(t) }));
  const techs = db.prepare("SELECT id, name, username FROM users WHERE role='tech' ORDER BY name").all();

  res.render('tickets-list', {
    title: 'Work Orders',
    tickets, techs,
    filters: { status, priority, assigned, category, from, to, sort, order, q },
    user: req.session.user, unreadCount: res.locals.unreadCount
  });
});

// New ticket form
router.get('/new', requireAuth, (req, res) => {
  const db = getDb();
  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();
  res.render('ticket-create', {
    title: 'New Work Order',
    techs,
    defaultDueDate: getDefaultDueDate('P3'),
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// Create ticket
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { title, description, priority, category, assigned_to, location, well_site, due_date } = req.body;

  if (!title || !priority || !category) {
    req.session.flash = { error: 'Title, priority, and category are required.' };
    return res.redirect('/tickets/new');
  }

  const id = uuidv4();
  const ticket_number = nextTicketNumber(db);
  const now = new Date().toISOString();
  const user = req.session.user;

  db.prepare(`
    INSERT INTO tickets (id, ticket_number, title, description, priority, category, status, assigned_to, location, well_site, due_date, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ticket_number, title, description || null, priority, category, assigned_to || null, location || null, well_site || null, due_date || null, user.id, now, now);

  // History
  db.prepare('INSERT INTO ticket_history (id, ticket_id, user_id, field_changed, old_value, new_value, changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), id, user.id, 'status', null, 'open', now);

  // Notify assignee
  if (assigned_to) {
    notifyAssignment({ id, ticket_number, title }, assigned_to, user.name);
  }

  req.session.flash = { success: `Ticket ${ticket_number} created.` };
  res.redirect(`/tickets/${id}`);
});

// Ticket detail
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const ticket = db.prepare(`
    SELECT t.*, u.name as assigned_name, u.username as assigned_username,
           c.name as creator_name
    FROM tickets t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    WHERE t.id = ?
  `).get(req.params.id);

  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.', user: req.session.user, unreadCount: res.locals.unreadCount });

  const comments = db.prepare(`
    SELECT tc.*, u.name as author_name, u.username as author_username
    FROM ticket_comments tc JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ? ORDER BY tc.created_at ASC
  `).all(ticket.id);

  const history = db.prepare(`
    SELECT th.*, u.name as actor_name
    FROM ticket_history th JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ? ORDER BY th.changed_at ASC
  `).all(ticket.id);

  const attachments = db.prepare(`
    SELECT ta.*, u.name as uploader_name
    FROM ticket_attachments ta JOIN users u ON u.id = ta.user_id
    WHERE ta.ticket_id = ? ORDER BY ta.created_at DESC
  `).all(ticket.id);

  // Time entries
  const timeEntries = db.prepare(`
    SELECT te.*, u.name as tech_name
    FROM time_entries te JOIN users u ON u.id = te.user_id
    WHERE te.ticket_id = ? ORDER BY te.clock_in DESC
  `).all(ticket.id);

  const totalMinutes = timeEntries.filter(e => e.duration_minutes).reduce((s, e) => s + e.duration_minutes, 0);

  // Active time entry for current user
  const activeEntry = db.prepare('SELECT * FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(ticket.id, req.session.user.id);

  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  res.render('ticket-detail', {
    title: `${ticket.ticket_number} — ${ticket.title}`,
    ticket: { ...ticket, slaStatus: getSlaStatus(ticket) },
    comments, history, attachments, timeEntries, totalMinutes, activeEntry, techs,
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// Update ticket
router.post('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  const { status, priority, assigned_to, title, description, category, location, well_site, due_date } = req.body;
  const now = new Date().toISOString();
  const fields = {};
  const historyEntries = [];

  if (status && status !== ticket.status) {
    fields.status = status;
    historyEntries.push({ field: 'status', old: ticket.status, new: status });
    if (['completed', 'closed'].includes(status)) fields.resolved_at = now;
    notifyStatusChange(ticket, ticket.status, status, user.name, db);
  }
  if (priority && priority !== ticket.priority) { fields.priority = priority; historyEntries.push({ field: 'priority', old: ticket.priority, new: priority }); }
  if (title && title !== ticket.title) { fields.title = title; historyEntries.push({ field: 'title', old: ticket.title, new: title }); }
  if (description !== undefined && description !== ticket.description) { fields.description = description; historyEntries.push({ field: 'description', old: ticket.description, new: description }); }
  if (category && category !== ticket.category) { fields.category = category; historyEntries.push({ field: 'category', old: ticket.category, new: category }); }
  if (location !== undefined) fields.location = location;
  if (well_site !== undefined) fields.well_site = well_site;
  if (due_date !== undefined) fields.due_date = due_date;

  const newAssignee = req.body.assigned_to;
  if (newAssignee !== undefined && newAssignee !== ticket.assigned_to) {
    fields.assigned_to = newAssignee || null;
    historyEntries.push({ field: 'assigned_to', old: ticket.assigned_to, new: newAssignee });
    if (newAssignee) notifyAssignment(ticket, newAssignee, user.name);
  }

  if (Object.keys(fields).length) {
    fields.updated_at = now;
    const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE tickets SET ${setClauses} WHERE id=?`).run(...Object.values(fields), ticket.id);
    for (const h of historyEntries) {
      db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
        .run(uuidv4(), ticket.id, user.id, h.field, h.old, h.new, now);
    }
  }

  req.session.flash = { success: 'Ticket updated.' };
  res.redirect(`/tickets/${ticket.id}`);
});

// Add comment
router.post('/:id/comments', requireAuth, (req, res) => {
  const db = getDb();
  const { body } = req.body;
  if (!body || !body.trim()) {
    req.session.flash = { error: 'Comment cannot be empty.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ticket_comments (id,ticket_id,user_id,body,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(uuidv4(), req.params.id, req.session.user.id, body.trim(), now, now);
  res.redirect(`/tickets/${req.params.id}#comments`);
});

// Upload attachment
router.post('/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    req.session.flash = { error: 'No file uploaded or file type not allowed.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const db = getDb();
  db.prepare('INSERT INTO ticket_attachments (id,ticket_id,user_id,filename,original_name,mimetype,size,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uuidv4(), req.params.id, req.session.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, new Date().toISOString());
  req.session.flash = { success: 'Attachment uploaded.' };
  res.redirect(`/tickets/${req.params.id}#attachments`);
});

// Clock in
router.post('/:id/timelog/start', requireAuth, (req, res) => {
  const db = getDb();
  const active = db.prepare('SELECT id FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(req.params.id, req.session.user.id);
  if (active) {
    req.session.flash = { error: 'Already clocked in on this ticket.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  db.prepare('INSERT INTO time_entries (id,ticket_id,user_id,clock_in,created_at) VALUES (?,?,?,?,?)')
    .run(uuidv4(), req.params.id, req.session.user.id, new Date().toISOString(), new Date().toISOString());

  // Auto-set status to in-progress if open
  const ticket = db.prepare('SELECT status FROM tickets WHERE id=?').get(req.params.id);
  if (ticket && ticket.status === 'open') {
    db.prepare("UPDATE tickets SET status='in-progress', updated_at=? WHERE id=?").run(new Date().toISOString(), req.params.id);
    db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
      .run(uuidv4(), req.params.id, req.session.user.id, 'status', 'open', 'in-progress', new Date().toISOString());
  }

  req.session.flash = { success: 'Clocked in.' };
  res.redirect(`/tickets/${req.params.id}`);
});

// Clock out
router.post('/:id/timelog/stop', requireAuth, (req, res) => {
  const db = getDb();
  const active = db.prepare('SELECT * FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(req.params.id, req.session.user.id);
  if (!active) {
    req.session.flash = { error: 'Not currently clocked in.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const now = new Date();
  const clockIn = new Date(active.clock_in);
  const durationMinutes = (now - clockIn) / 60000;
  db.prepare('UPDATE time_entries SET clock_out=?, duration_minutes=? WHERE id=?').run(now.toISOString(), durationMinutes, active.id);
  req.session.flash = { success: `Clocked out. ${durationMinutes.toFixed(1)} minutes logged.` };
  res.redirect(`/tickets/${req.params.id}`);
});

// Escalate (bump priority)
router.post('/:id/escalate', requireAuth, (req, res) => {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.redirect('/tickets');

  const priorities = ['P1', 'P2', 'P3', 'P4'];
  const idx = priorities.indexOf(ticket.priority);
  if (idx <= 0) {
    req.session.flash = { error: 'Already at highest priority (P1).' };
    return res.redirect(`/tickets/${ticket.id}`);
  }
  const newPriority = priorities[idx - 1];
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET priority=?, updated_at=? WHERE id=?").run(newPriority, now, ticket.id);
  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, req.session.user.id, 'priority', ticket.priority, newPriority, now);

  req.session.flash = { success: `Escalated to ${newPriority}.` };
  res.redirect(`/tickets/${ticket.id}`);
});

module.exports = router;
