'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const { logAudit, actorFromReq, AUDIT_ACTIONS } = require('../services/audit');
const { sanitizeString, validateEmail, validateUsername, validateRole, validatePasswordStrength } = require('../middleware/validate');
const router = express.Router();

// ── Admin dashboard ───────────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, username, email, name, role, last_login_at, login_attempts, locked_until, created_at, updated_at
    FROM users ORDER BY role, name
  `).all();

  const ticketStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status='in-progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status='completed' OR status='closed' THEN 1 ELSE 0 END) as closed
    FROM tickets
  `).get();

  const recentActivity = db.prepare(`
    SELECT pv.username, pv.feature, pv.path, pv.created_at, pv.status_code
    FROM page_views pv
    WHERE pv.user_id IS NOT NULL
    ORDER BY pv.created_at DESC LIMIT 50
  `).all();

  // Recent audit log entries for the security tab
  const auditLogs = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100
  `).all();

  res.render('admin', {
    title: 'Admin Panel',
    user: req.session.user,
    unreadCount: res.locals.unreadCount || 0,
    users,
    ticketStats,
    recentActivity,
    auditLogs,
    flash: req.session.flash || {},
    tab: req.query.tab || 'users',
    csrfToken: res.locals.csrfToken,
  });
  delete req.session.flash;
});

// ── Create user ───────────────────────────────────────────────────────────────
router.post('/users/create', requireAdmin, (req, res) => {
  const username = validateUsername(req.body.username);
  const email    = validateEmail(req.body.email);
  const name     = sanitizeString(req.body.name, 100);
  const role     = validateRole(req.body.role);
  const password = req.body.password ? String(req.body.password) : null;

  if (!username || !email || !name || !role || !password) {
    req.session.flash = { error: 'All fields are required. Username must be 2–50 alphanumeric/dot/dash chars.' };
    return res.redirect('/admin?tab=users');
  }

  const pwCheck = validatePasswordStrength(password);
  if (!pwCheck.ok) {
    req.session.flash = { error: pwCheck.reason };
    return res.redirect('/admin?tab=users');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email);
  if (existing) {
    req.session.flash = { error: 'Username or email already exists.' };
    return res.redirect('/admin?tab=users');
  }

  const id   = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const now  = new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, email, password_hash, name, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, username, email, hash, name, role, now, now);

  logAudit(db, {
    ...actorFromReq(req),
    action: AUDIT_ACTIONS.USER_CREATED,
    resource_type: 'user', resource_id: id,
    new_value: `username=${username} role=${role}`,
  });

  req.session.flash = { success: `User "${name}" created successfully.` };
  res.redirect('/admin?tab=users');
});

// ── Edit user ─────────────────────────────────────────────────────────────────
router.post('/users/:id/edit', requireAdmin, (req, res) => {
  const name  = sanitizeString(req.body.name, 100);
  const email = validateEmail(req.body.email);
  const role  = validateRole(req.body.role);
  const db    = getDb();

  if (!name || !email || !role) {
    req.session.flash = { error: 'Name, valid email, and role are required.' };
    return res.redirect('/admin?tab=users');
  }

  const before = db.prepare('SELECT name, email, role FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET name=?, email=?, role=?, updated_at=? WHERE id=?')
    .run(name, email, role, new Date().toISOString(), req.params.id);

  const changes = [];
  if (before?.role !== role) changes.push(`role: ${before?.role} → ${role}`);
  if (before?.email !== email) changes.push(`email changed`);
  if (before?.name !== name) changes.push(`name: ${before?.name} → ${name}`);

  logAudit(db, {
    ...actorFromReq(req),
    action: before?.role !== role ? AUDIT_ACTIONS.ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED,
    resource_type: 'user', resource_id: req.params.id,
    old_value: before ? `role=${before.role}` : null,
    new_value: changes.join('; '),
  });

  req.session.flash = { success: 'User updated.' };
  res.redirect('/admin?tab=users');
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const newPassword = req.body.newPassword ? String(req.body.newPassword) : null;

  const pwCheck = validatePasswordStrength(newPassword);
  if (!pwCheck.ok) {
    req.session.flash = { error: pwCheck.reason };
    return res.redirect('/admin?tab=users');
  }

  const db   = getDb();
  const hash = bcrypt.hashSync(newPassword, 10);
  const now  = new Date().toISOString();
  // Also clear lockout on admin-initiated reset
  db.prepare('UPDATE users SET password_hash=?, login_attempts=0, locked_until=NULL, updated_at=? WHERE id=?')
    .run(hash, now, req.params.id);

  logAudit(db, {
    ...actorFromReq(req),
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    resource_type: 'user', resource_id: req.params.id,
    new_value: 'password reset by admin',
  });

  req.session.flash = { success: 'Password reset successfully.' };
  res.redirect('/admin?tab=users');
});

// ── Unlock account ────────────────────────────────────────────────────────────
router.post('/users/:id/unlock', requireAdmin, (req, res) => {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET login_attempts=0, locked_until=NULL, updated_at=? WHERE id=?').run(now, req.params.id);

  logAudit(db, {
    ...actorFromReq(req),
    action: AUDIT_ACTIONS.USER_UPDATED,
    resource_type: 'user', resource_id: req.params.id,
    new_value: 'account unlocked by admin',
  });

  req.session.flash = { success: 'Account unlocked.' };
  res.redirect('/admin?tab=users');
});

// ── Delete user ───────────────────────────────────────────────────────────────
router.post('/users/:id/delete', requireAdmin, (req, res) => {
  const db     = getDb();
  const target = db.prepare('SELECT username, name FROM users WHERE id=?').get(req.params.id);
  if (target?.username === 'cody') {
    req.session.flash = { error: 'Cannot delete the primary admin account.' };
    return res.redirect('/admin?tab=users');
  }
  // Prevent self-deletion
  if (req.params.id === req.session.user.id) {
    req.session.flash = { error: 'Cannot delete your own account.' };
    return res.redirect('/admin?tab=users');
  }

  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);

  logAudit(db, {
    ...actorFromReq(req),
    action: AUDIT_ACTIONS.USER_DELETED,
    resource_type: 'user', resource_id: req.params.id,
    old_value: target ? `username=${target.username} name=${target.name}` : null,
  });

  req.session.flash = { success: 'User deleted.' };
  res.redirect('/admin?tab=users');
});

// ── Changelog API ─────────────────────────────────────────────────────────────
router.get('/changelog', requireAdmin, (req, res) => {
  const db = getDb();
  res.json({ ok: true, entries: db.prepare('SELECT * FROM changelog ORDER BY created_at DESC').all() });
});

router.post('/changelog', requireAdmin, (req, res) => {
  const title       = sanitizeString(req.body.title, 200);
  const description = sanitizeString(req.body.description, 2000);
  const type        = req.body.type || 'feature';
  const version     = sanitizeString(req.body.version, 20);

  if (!title || !description) return res.json({ ok: false, error: 'Title and description required.' });

  const db  = getDb();
  const now = new Date().toISOString();
  const id  = uuidv4();
  db.prepare('INSERT INTO changelog (id, version, title, description, type, is_published, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)')
    .run(id, version || null, title, description, type, req.session.user.id, now, now);
  res.json({ ok: true, id });
});

router.post('/changelog/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM changelog WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Entry deleted.' };
  res.redirect('/admin?tab=changelog');
});

// ── Audit log API (admin only) ────────────────────────────────────────────────
router.get('/audit', requireAdmin, (req, res) => {
  const db    = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs  = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ ok: true, logs });
});

module.exports = router;
