'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const { sanitizeString, validateRole, validateEmail, validateUsername, validatePasswordStrength } = require('../middleware/validate');
const { logAudit, AUDIT_ACTIONS, actorFromReq } = require('../services/audit');
const router = express.Router();

// ── Admin panel ───────────────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, name, role, last_login_at, login_attempts, locked_until, created_at FROM users ORDER BY role, name').all();
  const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all();
  const changelog = db.prepare('SELECT cl.*, u.name as author_name FROM changelog cl LEFT JOIN users u ON u.id = cl.created_by ORDER BY cl.created_at DESC LIMIT 50').all();

  res.render('admin', {
    title: 'Admin Panel',
    users, auditLogs, changelog,
    user: req.session.user, unreadCount: res.locals.unreadCount,
    csrfToken: res.locals.csrfToken
  });
});

// ── Create user ───────────────────────────────────────────────────────────────
router.post('/users', requireAdmin, (req, res) => {
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
  db.prepare('INSERT INTO users (id, username, email, password_hash, name, role, login_attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)')
    .run(id, username, email, hash, name, role, now, now);

  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_CREATED, resource_type: 'user', resource_id: id, new_value: username });

  req.session.flash = { success: `User ${username} created.` };
  res.redirect('/admin');
});

// ── Update user ───────────────────────────────────────────────────────────────
router.post('/users/:id', requireAdmin, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) { req.session.flash = { error: 'User not found.' }; return res.redirect('/admin'); }

  const name  = sanitizeString(req.body.name, 100) || user.name;
  const email = validateEmail(req.body.email) || user.email;
  const role  = validateRole(req.body.role) || user.role;
  const now   = new Date().toISOString();

  // Prevent admin from demoting themselves
  if (user.id === req.session.user.id && role !== 'admin') {
    req.session.flash = { error: 'You cannot change your own role.' };
    return res.redirect('/admin');
  }

  db.prepare('UPDATE users SET name=?, email=?, role=?, updated_at=? WHERE id=?').run(name, email, role, now, user.id);

  const changes = [];
  if (role !== user.role)   changes.push(`role: ${user.role} → ${role}`);
  if (email !== user.email) changes.push(`email updated`);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_UPDATED, resource_type: 'user', resource_id: user.id, new_value: changes.join(', ') || 'name updated' });

  req.session.flash = { success: 'User updated.' };
  res.redirect('/admin');
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const db       = getDb();
  const password = req.body.password || '';
  if (!validatePasswordStrength(password)) {
    req.session.flash = { error: 'Password must be at least 8 characters with a letter and a number.' };
    return res.redirect('/admin');
  }

  const hash = bcrypt.hashSync(password, 12);
  const now  = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(hash, now, req.params.id);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_PW_RESET, resource_type: 'user', resource_id: req.params.id });

  req.session.flash = { success: 'Password reset.' };
  res.redirect('/admin');
});

// ── Unlock account ────────────────────────────────────────────────────────────
router.post('/users/:id/unlock', requireAdmin, (req, res) => {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET login_attempts=0, locked_until=NULL, updated_at=? WHERE id=?').run(now, req.params.id);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_UNLOCKED, resource_type: 'user', resource_id: req.params.id });
  req.session.flash = { success: 'Account unlocked.' };
  res.redirect('/admin');
});

// ── Delete user ───────────────────────────────────────────────────────────────
router.post('/users/:id/delete', requireAdmin, (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) { req.session.flash = { error: 'User not found.' }; return res.redirect('/admin'); }
  if (user.id === req.session.user.id) { req.session.flash = { error: 'Cannot delete your own account.' }; return res.redirect('/admin'); }

  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.USER_DELETED, resource_type: 'user', resource_id: req.params.id, old_value: user.username });

  req.session.flash = { success: `User ${user.username} deleted.` };
  res.redirect('/admin');
});

// ── Changelog CRUD (also used by community.js via admin routes) ───────────────
router.post('/changelog', requireAdmin, (req, res) => {
  const title       = sanitizeString(req.body.title, 200);
  const description = sanitizeString(req.body.description, 2000);
  const type        = ['new','feature','improvement','fix'].includes(req.body.type) ? req.body.type : 'feature';
  const version     = sanitizeString(req.body.version, 20);
  if (!title || !description) { req.session.flash = { error: 'Title and description required.' }; return res.redirect('/admin?tab=changelog'); }

  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO changelog (id, version, title, description, type, is_published, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)')
    .run(uuidv4(), version, title, description, type, req.session.user.id, now, now);

  req.session.flash = { success: 'Changelog entry added.' };
  res.redirect('/admin?tab=changelog');
});

router.post('/changelog/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM changelog WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Entry deleted.' };
  res.redirect('/admin?tab=changelog');
});

module.exports = router;
