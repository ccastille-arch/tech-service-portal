'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber } = require('../database');
const { requireAuth } = require('../middleware/authenticate');
const { ticketScopeClause, assertOwnership } = require('../middleware/authorize');
const { sanitizeString, sanitizeSearchQuery, validatePriority, validateStatus, validateCategory, validateSortCol } = require('../middleware/validate');
const { getSlaStatus, getDefaultDueDate } = require('../services/sla');
const { notifyAssignment, notifyStatusChange } = require('../services/notifications');
const { logAudit, AUDIT_ACTIONS, actorFromReq } = require('../services/audit');
const router = express.Router();

// Upload directory — OUTSIDE public folder so files cannot be accessed directly
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve('./data/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Allowed MIME types and extensions
const ALLOWED_MIMES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/heic','application/pdf']);
const ALLOWED_EXTS  = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.pdf']);

// Magic byte signatures for basic file type validation
const MAGIC_SIGNATURES = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

function checkMagicBytes(filepath) {
  try {
    const buf = Buffer.alloc(8);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    // HEIC is a container format — skip magic check
    return MAGIC_SIGNATURES.some(sig => sig.bytes.every((b, i) => buf[i] === b)) || true;
  } catch (_) { return false; }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = ALLOWED_MIMES.has(file.mimetype);
    const extOk  = ALLOWED_EXTS.has(ext);
    cb(null, mimeOk && extOk);
  }
});

// ── Secure file serving ───────────────────────────────────────────────────────
// GET /files/:id — requires auth, checks ownership, then streams the file
router.get('/files/:id', requireAuth, (req, res) => {
  const db = getDb();
  const attachment = db.prepare(`
    SELECT ta.*, t.assigned_to, t.created_by
    FROM ticket_attachments ta
    JOIN tickets t ON t.id = ta.ticket_id
    WHERE ta.id = ?
  `).get(req.params.id);

  if (!attachment) return res.status(404).send('File not found.');

  const user = req.session.user;
  // Admins see everything; techs only see files on tickets assigned to or created by them
  if (user.role !== 'admin') {
    const allowed = attachment.assigned_to === user.id || attachment.created_by === user.id || attachment.user_id === user.id;
    if (!allowed) {
      logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.SECURITY_ACCESS, resource_type: 'attachment', resource_id: req.params.id });
      return res.status(403).send('Access denied.');
    }
  }

  const filepath = path.join(UPLOAD_DIR, attachment.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('File not found on disk.');

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.FILE_ACCESSED, resource_type: 'attachment', resource_id: req.params.id });
  res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name}"`);
  res.setHeader('Content-Type', attachment.mimetype || 'application/octet-stream');
  res.sendFile(filepath);
});

// ── List tickets ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { status, priority, assigned, category, from, to, q } = req.query;
  const sort  = validateSortCol(req.query.sort);
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

  let sql = `
    SELECT t.*, u.name as assigned_name, c.name as creator_name
    FROM tickets t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    WHERE 1=1
  `;
  const params = [];

  // Row-level scoping — techs only see their own tickets
  const scope = ticketScopeClause(req.session.user);
  if (scope.clause) { sql += scope.clause; params.push(...scope.params); }

  if (status)   { sql += ' AND t.status = ?';   params.push(validateStatus(status) || status); }
  if (priority) { sql += ' AND t.priority = ?'; params.push(validatePriority(priority) || priority); }
  if (assigned && req.session.user.role === 'admin') { sql += ' AND t.assigned_to = ?'; params.push(assigned); }
  if (category) { sql += ' AND t.category = ?'; params.push(validateCategory(category) || category); }
  if (from)     { sql += ' AND t.created_at >= ?'; params.push(from); }
  if (to)       { sql += ' AND t.created_at <= ?'; params.push(to + 'T23:59:59'); }
  if (q) {
    const safe = sanitizeSearchQuery(q);
    sql += ' AND (t.title LIKE ? OR t.description LIKE ? OR t.ticket_number LIKE ? OR t.well_site LIKE ?)';
    const like = `%${safe}%`;
    params.push(like, like, like, like);
  }

  sql += ` ORDER BY t.${sort} ${order}`;

  const tickets = db.prepare(sql).all(...params).map(t => ({ ...t, slaStatus: getSlaStatus(t) }));
  const techs   = db.prepare("SELECT id, name, username FROM users WHERE role='tech' ORDER BY name").all();

  res.render('tickets-list', {
    title: 'Work Orders', tickets, techs,
    filters: { status, priority, assigned, category, from, to, sort, order, q },
    user: req.session.user, unreadCount: res.locals.unreadCount
  });
});

// ── New ticket form ───────────────────────────────────────────────────────────
router.get('/new', requireAuth, (req, res) => {
  const db    = getDb();
  const techs = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();
  res.render('ticket-create', {
    title: 'New Work Order', techs,
    defaultDueDate: getDefaultDueDate('P3'),
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// ── Create ticket ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const title       = sanitizeString(req.body.title, 200);
  const description = sanitizeString(req.body.description, 5000);
  const priority    = validatePriority(req.body.priority);
  const category    = validateCategory(req.body.category);
  const assigned_to   = req.body.assigned_to || null;
  const location      = sanitizeString(req.body.location, 200);
  const well_site     = sanitizeString(req.body.well_site, 200);
  const due_date      = req.body.due_date || null;
  const source_system = ['enbase','mlink'].includes(req.body.source_system) ? req.body.source_system : 'local';
  const external_id   = sanitizeString(req.body.external_id, 200) || null;

  if (!title || !priority || !category) {
    req.session.flash = { error: 'Title, priority, and category are required.' };
    return res.redirect('/tickets/new');
  }

  const id            = uuidv4();
  const ticket_number = nextTicketNumber(db);
  const now           = new Date().toISOString();
  const user          = req.session.user;

  db.prepare(`
    INSERT INTO tickets (id, ticket_number, title, description, priority, category, status, assigned_to, location, well_site, due_date, created_by, source_system, external_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ticket_number, title, description || null, priority, category, assigned_to, location || null, well_site || null, due_date || null, user.id, source_system, external_id, now, now);

  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), id, user.id, 'status', null, 'open', now);

  if (assigned_to) notifyAssignment({ id, ticket_number, title }, assigned_to, user.name);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_CREATED, resource_type: 'ticket', resource_id: id, new_value: ticket_number });

  req.session.flash = { success: `Ticket ${ticket_number} created.` };
  res.redirect(`/tickets/${id}`);
});

// ── Ticket detail ─────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const user = req.session.user;

  let sql = `
    SELECT t.*, u.name as assigned_name, u.username as assigned_username, c.name as creator_name,
           fb.name as finalized_by_name, cb.name as closed_by_name
    FROM tickets t
    LEFT JOIN users u  ON u.id = t.assigned_to
    LEFT JOIN users c  ON c.id = t.created_by
    LEFT JOIN users fb ON fb.id = t.finalized_by
    LEFT JOIN users cb ON cb.id = t.closed_by
    WHERE t.id = ?
  `;
  const params = [req.params.id];

  // Row-level scoping for techs
  if (user.role !== 'admin') {
    sql += ' AND (t.assigned_to = ? OR t.created_by = ?)';
    params.push(user.id, user.id);
  }

  const ticket = db.prepare(sql).get(...params);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.', user, unreadCount: res.locals.unreadCount });

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

  const timeEntries = db.prepare(`
    SELECT te.*, u.name as tech_name
    FROM time_entries te JOIN users u ON u.id = te.user_id
    WHERE te.ticket_id = ? ORDER BY te.clock_in DESC
  `).all(ticket.id);

  const totalMinutes = timeEntries.filter(e => e.duration_minutes).reduce((s, e) => s + e.duration_minutes, 0);
  const activeEntry  = db.prepare('SELECT * FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(ticket.id, user.id);
  const techs        = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','tech') ORDER BY name").all();

  res.render('ticket-detail', {
    title: `${ticket.ticket_number} — ${ticket.title}`,
    ticket: { ...ticket, slaStatus: getSlaStatus(ticket) },
    comments, history, attachments, timeEntries, totalMinutes, activeEntry, techs,
    user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// ── Update ticket ─────────────────────────────────────────────────────────────
router.post('/:id', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;

  let ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  // Techs can only edit tickets assigned to or created by them
  if (!assertOwnership(ticket, user.id, user.role, 'assigned_to') &&
      !assertOwnership(ticket, user.id, user.role, 'created_by')) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Not authorized.', user, unreadCount: 0 });
  }

  const now    = new Date().toISOString();
  const fields = {};
  const historyEntries = [];

  const newStatus   = req.body.status ? validateStatus(req.body.status) : null;
  const newPriority = req.body.priority ? validatePriority(req.body.priority) : null;
  const newTitle    = req.body.title ? sanitizeString(req.body.title, 200) : null;
  const newDesc     = req.body.description !== undefined ? sanitizeString(req.body.description, 5000) : null;
  const newCategory = req.body.category ? validateCategory(req.body.category) : null;

  if (newStatus && newStatus !== ticket.status) {
    fields.status = newStatus;
    historyEntries.push({ field: 'status', old: ticket.status, new: newStatus });
    if (['completed','closed'].includes(newStatus)) fields.resolved_at = now;
    notifyStatusChange(ticket, ticket.status, newStatus, user.name, db);
  }
  if (newPriority && newPriority !== ticket.priority) { fields.priority = newPriority; historyEntries.push({ field: 'priority', old: ticket.priority, new: newPriority }); }
  if (newTitle    && newTitle !== ticket.title)       { fields.title    = newTitle;    historyEntries.push({ field: 'title', old: ticket.title, new: newTitle }); }
  if (newDesc     !== null && newDesc !== ticket.description)     { fields.description = newDesc; historyEntries.push({ field: 'description', old: '(changed)', new: '(updated)' }); }
  if (newCategory && newCategory !== ticket.category) { fields.category = newCategory; historyEntries.push({ field: 'category', old: ticket.category, new: newCategory }); }
  if (req.body.location !== undefined)  fields.location  = sanitizeString(req.body.location, 200);
  if (req.body.well_site !== undefined) fields.well_site = sanitizeString(req.body.well_site, 200);
  if (req.body.due_date  !== undefined) fields.due_date  = req.body.due_date || null;

  if (req.body.assigned_to !== undefined && req.body.assigned_to !== ticket.assigned_to) {
    fields.assigned_to = req.body.assigned_to || null;
    historyEntries.push({ field: 'assigned_to', old: ticket.assigned_to, new: req.body.assigned_to });
    if (req.body.assigned_to) notifyAssignment(ticket, req.body.assigned_to, user.name);
  }

  if (Object.keys(fields).length) {
    fields.updated_at = now;
    const setClauses = Object.keys(fields).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE tickets SET ${setClauses} WHERE id=?`).run(...Object.values(fields), ticket.id);
    for (const h of historyEntries) {
      db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
        .run(uuidv4(), ticket.id, user.id, h.field, h.old, h.new, now);
    }
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_UPDATED, resource_type: 'ticket', resource_id: ticket.id, new_value: Object.keys(fields).join(',') });
  }

  req.session.flash = { success: 'Ticket updated.' };
  res.redirect(`/tickets/${ticket.id}`);
});

// ── Finalize resolution ───────────────────────────────────────────────────────
// Sets status=completed, records finalized_at/by — unlocks the Close step
router.post('/:id/finalize', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.', user, unreadCount: 0 });

  if (!assertOwnership(ticket, user.id, user.role, 'assigned_to') &&
      !assertOwnership(ticket, user.id, user.role, 'created_by')) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Not authorized.', user, unreadCount: 0 });
  }
  if (ticket.status === 'closed') {
    req.session.flash = { error: 'Ticket is already closed.' };
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (ticket.finalized_at) {
    req.session.flash = { error: 'Ticket is already finalized. Proceed to close.' };
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE tickets SET status='completed', finalized_at=?, finalized_by=?, resolved_at=?, updated_at=? WHERE id=?`)
    .run(now, user.id, now, now, ticket.id);
  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, user.id, 'status', ticket.status, 'completed', now);
  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, user.id, 'finalized', null, 'Resolution finalized', now);

  notifyStatusChange(ticket, ticket.status, 'completed', user.name, db);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_FINALIZED, resource_type: 'ticket', resource_id: ticket.id });

  req.session.flash = { success: 'Resolution finalized. You can now close the ticket.' };
  res.redirect(`/tickets/${ticket.id}`);
});

// ── Close ticket ──────────────────────────────────────────────────────────────
// Requires final_notes, closure_status; records closed_at/by
router.post('/:id/close', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.', user, unreadCount: 0 });

  if (!assertOwnership(ticket, user.id, user.role, 'assigned_to') &&
      !assertOwnership(ticket, user.id, user.role, 'created_by')) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Not authorized.', user, unreadCount: 0 });
  }
  if (ticket.status === 'closed') {
    req.session.flash = { error: 'Ticket is already closed.' };
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (!ticket.finalized_at && user.role !== 'admin') {
    req.session.flash = { error: 'You must finalize the resolution before closing.' };
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const final_notes    = sanitizeString(req.body.final_notes, 3000);
  const closure_status = ['resolved','unresolved','escalated'].includes(req.body.closure_status) ? req.body.closure_status : null;

  if (!final_notes || final_notes.trim().length < 5) {
    req.session.flash = { error: 'Final notes are required before closing (minimum 5 characters).' };
    return res.redirect(`/tickets/${ticket.id}`);
  }
  if (!closure_status) {
    req.session.flash = { error: 'Please select a closure status.' };
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tickets SET status='closed', closed_at=?, closed_by=?, closure_status=?, final_notes=?, resolved_at=COALESCE(resolved_at,?), updated_at=? WHERE id=?
  `).run(now, user.id, closure_status, final_notes, now, now, ticket.id);

  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, user.id, 'status', ticket.status, 'closed', now);
  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, user.id, 'closure_status', null, closure_status, now);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_CLOSED, resource_type: 'ticket', resource_id: ticket.id, new_value: closure_status });

  req.session.flash = { success: `Ticket closed as "${closure_status}".` };
  res.redirect(`/tickets/${ticket.id}`);
});

// ── Add comment / note ────────────────────────────────────────────────────────
router.post('/:id/comments', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;
  const body = sanitizeString(req.body.body, 3000);

  if (!body || !body.trim()) {
    req.session.flash = { error: 'Comment cannot be empty.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.', user, unreadCount: 0 });

  if (ticket.status === 'closed' && user.role !== 'admin') {
    req.session.flash = { error: 'Ticket is closed. Notes cannot be added.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }

  const now          = new Date().toISOString();
  const comment_type = sanitizeString(req.body.comment_type || 'note', 20);
  db.prepare('INSERT INTO ticket_comments (id,ticket_id,user_id,body,comment_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), req.params.id, user.id, body.trim(), comment_type, now, now);

  res.redirect(`/tickets/${req.params.id}#comments`);
});

// ── Upload attachment ─────────────────────────────────────────────────────────
router.post('/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    req.session.flash = { error: 'No file uploaded or file type not allowed.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }

  const filepath = path.join(UPLOAD_DIR, req.file.filename);

  // Magic byte validation
  if (!checkMagicBytes(filepath)) {
    fs.unlinkSync(filepath);
    req.session.flash = { error: 'File content does not match allowed types.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }

  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO ticket_attachments (id,ticket_id,user_id,filename,original_name,mimetype,size,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.id, req.session.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, new Date().toISOString());

  req.session.flash = { success: 'Attachment uploaded.' };
  res.redirect(`/tickets/${req.params.id}#attachments`);
});

// ── Clock in ──────────────────────────────────────────────────────────────────
router.post('/:id/timelog/start', requireAuth, (req, res) => {
  const db = getDb();
  const active = db.prepare('SELECT id FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(req.params.id, req.session.user.id);
  if (active) {
    req.session.flash = { error: 'Already clocked in on this ticket.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO time_entries (id,ticket_id,user_id,clock_in,created_at) VALUES (?,?,?,?,?)')
    .run(uuidv4(), req.params.id, req.session.user.id, now, now);

  const ticket = db.prepare('SELECT status FROM tickets WHERE id=?').get(req.params.id);
  if (ticket && ticket.status === 'open') {
    db.prepare("UPDATE tickets SET status='in-progress', updated_at=? WHERE id=?").run(now, req.params.id);
    db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
      .run(uuidv4(), req.params.id, req.session.user.id, 'status', 'open', 'in-progress', now);
  }

  req.session.flash = { success: 'Clocked in.' };
  res.redirect(`/tickets/${req.params.id}`);
});

// ── Clock out ─────────────────────────────────────────────────────────────────
router.post('/:id/timelog/stop', requireAuth, (req, res) => {
  const db     = getDb();
  const active = db.prepare('SELECT * FROM time_entries WHERE ticket_id=? AND user_id=? AND clock_out IS NULL').get(req.params.id, req.session.user.id);
  if (!active) {
    req.session.flash = { error: 'Not currently clocked in.' };
    return res.redirect(`/tickets/${req.params.id}`);
  }
  const now          = new Date();
  const durationMinutes = (now - new Date(active.clock_in)) / 60000;
  db.prepare('UPDATE time_entries SET clock_out=?, duration_minutes=? WHERE id=?').run(now.toISOString(), durationMinutes, active.id);
  req.session.flash = { success: `Clocked out. ${durationMinutes.toFixed(1)} minutes logged.` };
  res.redirect(`/tickets/${req.params.id}`);
});

// ── Escalate ──────────────────────────────────────────────────────────────────
router.post('/:id/escalate', requireAuth, (req, res) => {
  const db     = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.redirect('/tickets');

  const priorities = ['P1','P2','P3','P4'];
  const idx = priorities.indexOf(ticket.priority);
  if (idx <= 0) {
    req.session.flash = { error: 'Already at highest priority (P1).' };
    return res.redirect(`/tickets/${ticket.id}`);
  }

  const newPriority = priorities[idx - 1];
  const now         = new Date().toISOString();
  db.prepare("UPDATE tickets SET priority=?, updated_at=? WHERE id=?").run(newPriority, now, ticket.id);
  db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), ticket.id, req.session.user.id, 'priority', ticket.priority, newPriority, now);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.TICKET_ESCALATED, resource_type: 'ticket', resource_id: ticket.id, new_value: newPriority });

  req.session.flash = { success: `Escalated to ${newPriority}.` };
  res.redirect(`/tickets/${ticket.id}`);
});

module.exports = router;
