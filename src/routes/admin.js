'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const router = express.Router();

// ── Admin dashboard ───────────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, name, role, created_at, updated_at FROM users ORDER BY role, name').all();
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

  res.render('admin', {
    title: 'Admin Panel',
    user: req.session.user,
    unreadCount: res.locals.unreadCount || 0,
    users,
    ticketStats,
    recentActivity,
    flash: req.session.flash || {},
    tab: req.query.tab || 'users'
  });
  delete req.session.flash;
});

// ── Create user ───────────────────────────────────────────────────────────────
router.post('/users/create', requireAdmin, (req, res) => {
  const { username, email, name, role, password } = req.body;
  if (!username || !email || !name || !role || !password) {
    req.session.flash = { error: 'All fields are required.' };
    return res.redirect('/admin?tab=users');
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username.toLowerCase(), email.toLowerCase());
  if (existing) {
    req.session.flash = { error: 'Username or email already exists.' };
    return res.redirect('/admin?tab=users');
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), username.toLowerCase(), email.toLowerCase(), hash, name, role, new Date().toISOString(), new Date().toISOString());
  req.session.flash = { success: `User ${name} created successfully.` };
  res.redirect('/admin?tab=users');
});

// ── Edit user ─────────────────────────────────────────────────────────────────
router.post('/users/:id/edit', requireAdmin, (req, res) => {
  const { name, email, role } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET name=?, email=?, role=?, updated_at=? WHERE id=?')
    .run(name, email.toLowerCase(), role, new Date().toISOString(), req.params.id);
  req.session.flash = { success: 'User updated.' };
  res.redirect('/admin?tab=users');
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    req.session.flash = { error: 'Password must be at least 6 characters.' };
    return res.redirect('/admin?tab=users');
  }
  const db = getDb();
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?')
    .run(hash, new Date().toISOString(), req.params.id);
  req.session.flash = { success: 'Password reset successfully.' };
  res.redirect('/admin?tab=users');
});

// ── Delete user ───────────────────────────────────────────────────────────────
router.post('/users/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT username FROM users WHERE id=?').get(req.params.id);
  if (target?.username === 'cody') {
    req.session.flash = { error: 'Cannot delete the admin account.' };
    return res.redirect('/admin?tab=users');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'User deleted.' };
  res.redirect('/admin?tab=users');
});

// ── API: changelog list for admin panel ───────────────────────────────────────
router.get('/changelog', requireAdmin, (req, res) => {
  const db = getDb();
  const entries = db.prepare('SELECT * FROM changelog ORDER BY created_at DESC').all();
  res.json({ ok: true, entries });
});

// Route alias so admin panel can POST to /admin/changelog
router.post('/changelog', requireAdmin, (req, res) => {
  const { title, description, type, version } = req.body;
  if (!title || !description) return res.json({ ok: false, error: 'Title and description required.' });
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`INSERT INTO changelog (id, version, title, description, type, is_published, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?,?)`).run(id, version || null, title, description, type || 'feature', req.session.user.id, now, now);
  res.json({ ok: true, id });
});

router.post('/changelog/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM changelog WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Entry deleted.' };
  res.redirect('/admin?tab=changelog');
});

module.exports = router;
