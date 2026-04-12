'use strict';
const express = require('express');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/authenticate');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const notifs = db.prepare(`
    SELECT n.*, t.ticket_number, t.title as ticket_title
    FROM notifications n
    LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 50
  `).all(req.session.user.id);

  // Mark all as read on view
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.user.id);

  res.render('notifications', {
    title: 'Notifications',
    notifs,
    user: req.session.user,
    unreadCount: 0
  });
});

router.post('/:id/read', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

router.post('/read-all', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
