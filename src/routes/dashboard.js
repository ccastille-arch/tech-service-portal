'use strict';
const express = require('express');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/authenticate');
const { getSlaStatus } = require('../services/sla');
const router = express.Router();

router.get('/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  const user = req.session.user;

  // Stats
  const stats = {
    open: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='open'").get().c,
    inProgress: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='in-progress'").get().c,
    onHold: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='on-hold'").get().c,
    completedToday: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('completed','closed') AND DATE(updated_at)=DATE('now')").get().c,
    total: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('closed')").get().c,
  };

  // Overdue tickets
  const now = new Date().toISOString();
  stats.overdue = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('completed','closed') AND due_date < ?").get(now).c;

  // Priority breakdown
  const priorityCounts = {};
  for (const p of ['P1','P2','P3','P4']) {
    priorityCounts[p] = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE priority=? AND status NOT IN ('closed')").get(p).c;
  }

  // Assigned breakdown
  const techBreakdown = db.prepare(`
    SELECT u.name, u.username, COUNT(t.id) as cnt
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id AND t.status NOT IN ('completed','closed')
    WHERE u.role = 'tech'
    GROUP BY u.id
  `).all();

  // Recent activity (last 10 ticket changes)
  const activity = db.prepare(`
    SELECT th.*, t.ticket_number, t.title, u.name as actor_name
    FROM ticket_history th
    JOIN tickets t ON t.id = th.ticket_id
    JOIN users u ON u.id = th.user_id
    ORDER BY th.changed_at DESC
    LIMIT 10
  `).all();

  // My tickets (if tech)
  let myTickets = [];
  if (user.role === 'tech') {
    myTickets = db.prepare(`
      SELECT t.*, u.name as assigned_name
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.assigned_to = ? AND t.status NOT IN ('completed','closed')
      ORDER BY t.priority ASC, t.due_date ASC
      LIMIT 10
    `).all(user.id);
    myTickets = myTickets.map(t => ({ ...t, slaStatus: getSlaStatus(t) }));
  }

  // Recent open tickets (admin)
  let recentTickets = [];
  if (user.role === 'admin') {
    recentTickets = db.prepare(`
      SELECT t.*, u.name as assigned_name
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.status NOT IN ('closed')
      ORDER BY t.created_at DESC
      LIMIT 8
    `).all();
    recentTickets = recentTickets.map(t => ({ ...t, slaStatus: getSlaStatus(t) }));
  }

  // SLA compliance
  const allActive = db.prepare("SELECT * FROM tickets WHERE status NOT IN ('completed','closed') AND due_date IS NOT NULL").all();
  const slaBreach = allActive.filter(t => getSlaStatus(t) === 'breached').length;
  const slaTotal = allActive.length;
  const slaCompliance = slaTotal > 0 ? Math.round(((slaTotal - slaBreach) / slaTotal) * 100) : 100;

  // What's New — latest 3 published entries
  const whatsNew = db.prepare("SELECT * FROM changelog WHERE is_published=1 ORDER BY created_at DESC LIMIT 3").all();

  res.render('dashboard', {
    title: 'Dashboard — Tech Service Portal',
    stats, priorityCounts, techBreakdown, activity, myTickets, recentTickets,
    slaCompliance, slaBreach, slaTotal, whatsNew,
    user, unreadCount: res.locals.unreadCount
  });
});

module.exports = router;
