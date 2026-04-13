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

module.exports = router;
