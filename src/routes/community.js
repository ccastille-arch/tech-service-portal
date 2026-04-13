'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/authenticate');
const router = express.Router();

// ── What's New (changelog) ────────────────────────────────────────────────────
router.get('/whats-new', requireAuth, (req, res) => {
  const db = getDb();
  const entries = db.prepare(`SELECT * FROM changelog WHERE is_published=1 ORDER BY created_at DESC`).all();
  res.render('whats-new', {
    title: "What's New",
    user: req.session.user,
    unreadCount: res.locals.unreadCount || 0,
    entries
  });
});

// ── Feature Requests ──────────────────────────────────────────────────────────
router.get('/feature-requests', requireAuth, (req, res) => {
  const db = getDb();
  const sort = req.query.sort || 'votes';
  const orderBy = sort === 'new' ? 'fr.created_at DESC' : 'fr.upvotes DESC, fr.created_at DESC';
  const requests = db.prepare(`
    SELECT fr.*, u.name as author_name_display,
           EXISTS(SELECT 1 FROM feature_request_votes v WHERE v.request_id=fr.id AND v.user_id=?) as user_voted
    FROM feature_requests fr
    LEFT JOIN users u ON u.id = fr.user_id
    ORDER BY ${orderBy}
  `).all(req.session.user.id);
  res.render('feature-requests', {
    title: 'Feature Requests',
    user: req.session.user,
    unreadCount: res.locals.unreadCount || 0,
    requests,
    sort
  });
});

router.post('/feature-requests', requireAuth, (req, res) => {
  const { title, description } = req.body;
  if (!title || !description) {
    req.session.flash = { error: 'Title and description are required.' };
    return res.redirect('/feature-requests');
  }
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO feature_requests (id, user_id, author_name, title, description, status, upvotes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'submitted', 0, ?, ?)`
  ).run(uuidv4(), req.session.user.id, req.session.user.name, title.trim(), description.trim(), now, now);
  req.session.flash = { success: 'Feature request submitted! Thank you.' };
  res.redirect('/feature-requests');
});

// ── Vote ──────────────────────────────────────────────────────────────────────
router.post('/feature-requests/:id/vote', requireAuth, (req, res) => {
  const db = getDb();
  const fr = db.prepare('SELECT id, upvotes FROM feature_requests WHERE id=?').get(req.params.id);
  if (!fr) return res.json({ ok: false });
  const existing = db.prepare('SELECT id FROM feature_request_votes WHERE request_id=? AND user_id=?').get(req.params.id, req.session.user.id);
  if (existing) {
    db.prepare('DELETE FROM feature_request_votes WHERE request_id=? AND user_id=?').run(req.params.id, req.session.user.id);
    db.prepare('UPDATE feature_requests SET upvotes=MAX(0,upvotes-1), updated_at=? WHERE id=?').run(new Date().toISOString(), req.params.id);
    return res.json({ ok: true, voted: false, votes: Math.max(0, fr.upvotes - 1) });
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO feature_request_votes (id, request_id, user_id, created_at) VALUES (?,?,?,?)').run(uuidv4(), req.params.id, req.session.user.id, now);
  db.prepare('UPDATE feature_requests SET upvotes=upvotes+1, updated_at=? WHERE id=?').run(now, req.params.id);
  return res.json({ ok: true, voted: true, votes: fr.upvotes + 1 });
});

// ── Admin: update feature request status ──────────────────────────────────────
router.post('/feature-requests/:id/status', requireAdmin, (req, res) => {
  const { status, admin_note, priority } = req.body;
  const db = getDb();
  db.prepare('UPDATE feature_requests SET status=?, admin_note=?, priority=?, updated_at=? WHERE id=?')
    .run(status, admin_note || null, priority || null, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

// ── Admin: delete feature request ─────────────────────────────────────────────
router.post('/feature-requests/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM feature_requests WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Request deleted.' };
  res.redirect('/feature-requests');
});

// ── Admin: changelog CRUD ─────────────────────────────────────────────────────
router.post('/admin/changelog', requireAdmin, (req, res) => {
  const { title, description, type, version } = req.body;
  if (!title || !description) return res.json({ ok: false, error: 'Title and description required.' });
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`INSERT INTO changelog (id, version, title, description, type, is_published, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?,?)`).run(id, version || null, title, description, type || 'feature', req.session.user.id, now, now);
  res.json({ ok: true, id });
});

router.post('/admin/changelog/:id/delete', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM changelog WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Changelog entry deleted.' };
  res.redirect('/admin?tab=changelog');
});

module.exports = router;
