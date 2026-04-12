'use strict';
const express = require('express');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
  res.render('reports', {
    title: 'Reports & Analytics',
    user: req.session.user, unreadCount: res.locals.unreadCount
  });
});

router.get('/data', requireAdmin, (req, res) => {
  const db = getDb();
  const days = parseInt(req.query.range) || 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // 1. Open vs Closed per day (last N days)
  const dailyCounts = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const open = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE DATE(created_at)=? AND status NOT IN ('completed','closed')").get(dateStr).c;
    const closed = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE DATE(updated_at)=? AND status IN ('completed','closed')").get(dateStr).c;
    dailyCounts.push({ date: dateStr, open, closed });
  }

  // 2. Avg resolution time by category (hours)
  const resolutionByCategory = db.prepare(`
    SELECT category,
           AVG((JULIANDAY(resolved_at) - JULIANDAY(created_at)) * 24) as avg_hours,
           COUNT(*) as cnt
    FROM tickets
    WHERE resolved_at IS NOT NULL AND created_at >= ?
    GROUP BY category
  `).all(since);

  // 3. Tickets per tech
  const ticketsPerTech = db.prepare(`
    SELECT u.name, COUNT(t.id) as cnt
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id AND t.created_at >= ?
    WHERE u.role = 'tech'
    GROUP BY u.id
  `).all(since);

  // 4. By priority
  const byPriority = db.prepare(`
    SELECT priority, COUNT(*) as cnt FROM tickets
    WHERE created_at >= ? GROUP BY priority ORDER BY priority
  `).all(since);

  // 5. SLA compliance
  const allResolved = db.prepare("SELECT * FROM tickets WHERE resolved_at IS NOT NULL AND created_at >= ?").all(since);
  const allActive = db.prepare("SELECT * FROM tickets WHERE status NOT IN ('completed','closed') AND due_date IS NOT NULL").all();
  const now = new Date().toISOString();
  const slaBreach = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('completed','closed') AND due_date < ?").get(now).c;
  const slaMet = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('completed','closed') AND (due_date IS NULL OR resolved_at <= due_date)").get().c;
  const slaMissed = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('completed','closed') AND due_date IS NOT NULL AND resolved_at > due_date").get().c;

  // 6. Busiest sites
  const busiestSites = db.prepare(`
    SELECT COALESCE(well_site, location, 'Unknown') as site, COUNT(*) as cnt
    FROM tickets WHERE created_at >= ?
    GROUP BY site ORDER BY cnt DESC LIMIT 10
  `).all(since);

  // 7. Hours per tech
  const hoursPerTech = db.prepare(`
    SELECT u.name, SUM(te.duration_minutes)/60.0 as hours
    FROM users u
    JOIN time_entries te ON te.user_id = u.id
    WHERE te.created_at >= ?
    GROUP BY u.id ORDER BY hours DESC
  `).all(since);

  res.json({
    dailyCounts,
    resolutionByCategory,
    ticketsPerTech,
    byPriority,
    sla: { met: slaMet, missed: slaMissed, breached: slaBreach },
    busiestSites,
    hoursPerTech
  });
});

module.exports = router;
