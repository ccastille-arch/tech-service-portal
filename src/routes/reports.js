'use strict';
const express = require('express');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/authenticate');
const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
  res.render('reports', {
    title: 'Reports & Analytics',
    user: req.session.user,
    unreadCount: res.locals.unreadCount || 0
  });
});

router.get('/data', requireAdmin, (req, res) => {
  const db = getDb();
  const days = parseInt(req.query.range) || 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // ── Ticket analytics ────────────────────────────────────────────────────────

  // 1. Open vs Closed per day
  const dailyCounts = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const open   = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE DATE(created_at)=? AND status NOT IN ('completed','closed')").get(dateStr).c;
    const closed = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE DATE(updated_at)=? AND status IN ('completed','closed')").get(dateStr).c;
    dailyCounts.push({ date: dateStr, open, closed });
  }

  // 2. Avg resolution time by category
  const resolutionByCategory = db.prepare(`
    SELECT category,
           AVG((JULIANDAY(resolved_at) - JULIANDAY(created_at)) * 24) as avg_hours,
           COUNT(*) as cnt
    FROM tickets WHERE resolved_at IS NOT NULL AND created_at >= ?
    GROUP BY category
  `).all(since);

  // 3. Tickets per tech
  const ticketsPerTech = db.prepare(`
    SELECT u.name, COUNT(t.id) as cnt
    FROM users u LEFT JOIN tickets t ON t.assigned_to = u.id AND t.created_at >= ?
    WHERE u.role = 'tech' GROUP BY u.id
  `).all(since);

  // 4. By priority
  const byPriority = db.prepare(`
    SELECT priority, COUNT(*) as cnt FROM tickets
    WHERE created_at >= ? GROUP BY priority ORDER BY priority
  `).all(since);

  // 5. SLA compliance
  const now = new Date().toISOString();
  const slaBreach = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('completed','closed') AND due_date < ?").get(now).c;
  const slaMet    = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('completed','closed') AND (due_date IS NULL OR resolved_at <= due_date)").get().c;
  const slaMissed = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('completed','closed') AND due_date IS NOT NULL AND resolved_at > due_date").get().c;

  // 6. Busiest sites
  const busiestSites = db.prepare(`
    SELECT COALESCE(well_site, location, 'Unknown') as site, COUNT(*) as cnt
    FROM tickets WHERE created_at >= ?
    GROUP BY site ORDER BY cnt DESC LIMIT 10
  `).all(since);

  // 7. Hours per tech
  const hoursPerTech = db.prepare(`
    SELECT u.name, ROUND(SUM(te.duration_minutes)/60.0, 1) as hours
    FROM users u JOIN time_entries te ON te.user_id = u.id
    WHERE te.created_at >= ? GROUP BY u.id ORDER BY hours DESC
  `).all(since);

  // Ticket totals
  const totalTickets = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE created_at >= ?").get(since).c;
  const openTickets  = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('completed','closed')").get().c;

  // Avg resolution time overall
  const avgResRow = db.prepare(`
    SELECT AVG((JULIANDAY(resolved_at) - JULIANDAY(created_at)) * 24) as avg_hours
    FROM tickets WHERE resolved_at IS NOT NULL AND created_at >= ?
  `).get(since);
  const avgResolutionHours = avgResRow?.avg_hours ? parseFloat(avgResRow.avg_hours).toFixed(1) : null;

  // ── User & session analytics ────────────────────────────────────────────────

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekAgo  = new Date(Date.now() - 7  * 86400000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  const hasPageViews = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='page_views'").get();

  let activeUsersToday = 0, activeUsersWeek = 0, activeUsersMonth = 0;
  let featureUsage = [], topPaths = [], userActivity = [], hourlyTraffic = [], dailyTraffic = [];
  let userDrilldown = [];

  if (hasPageViews) {
    activeUsersToday = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM page_views WHERE DATE(created_at)=? AND user_id IS NOT NULL").get(todayStr).c;
    activeUsersWeek  = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM page_views WHERE created_at >= ? AND user_id IS NOT NULL").get(weekAgo).c;
    activeUsersMonth = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM page_views WHERE created_at >= ? AND user_id IS NOT NULL").get(monthAgo).c;

    // 9. Feature usage breakdown
    featureUsage = db.prepare(`
      SELECT feature, COUNT(*) as views, COUNT(DISTINCT user_id) as unique_users
      FROM page_views WHERE created_at >= ? AND feature IS NOT NULL AND feature != 'Other'
      GROUP BY feature ORDER BY views DESC
    `).all(since);

    // 10. Top paths
    topPaths = db.prepare(`
      SELECT path, COUNT(*) as hits, COUNT(DISTINCT user_id) as unique_users,
             ROUND(AVG(duration_ms)) as avg_ms
      FROM page_views WHERE created_at >= ?
      GROUP BY path ORDER BY hits DESC LIMIT 20
    `).all(since);

    // 11. Per-user activity summary
    userActivity = db.prepare(`
      SELECT u.name, u.username, u.role,
             COUNT(pv.id) as total_views,
             COUNT(DISTINCT DATE(pv.created_at)) as active_days,
             MAX(pv.created_at) as last_seen,
             GROUP_CONCAT(DISTINCT pv.feature) as features_used
      FROM users u
      LEFT JOIN page_views pv ON pv.user_id = u.id AND pv.created_at >= ?
      GROUP BY u.id ORDER BY total_views DESC
    `).all(since);

    // 12. Hourly traffic heatmap (0-23)
    hourlyTraffic = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as hits
      FROM page_views WHERE created_at >= ?
      GROUP BY hour ORDER BY hour
    `).all(since);

    // 13. Daily traffic
    dailyTraffic = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as hits, COUNT(DISTINCT user_id) as unique_users
      FROM page_views WHERE created_at >= ?
      GROUP BY date ORDER BY date
    `).all(since);

    // 14. User drilldown — per user per feature
    userDrilldown = db.prepare(`
      SELECT username, feature, COUNT(*) as cnt, MAX(created_at) as last_at
      FROM page_views WHERE created_at >= ? AND user_id IS NOT NULL
      GROUP BY username, feature ORDER BY username, cnt DESC
    `).all(since);
  }

  // ── Call analytics ──────────────────────────────────────────────────────────
  const callStats = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status='voicemail' THEN 1 ELSE 0 END) as voicemails,
           SUM(CASE WHEN ticket_id IS NOT NULL THEN 1 ELSE 0 END) as tickets_created,
           ROUND(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds END)) as avg_duration
    FROM call_sessions WHERE created_at >= ?
  `).get(since);

  res.json({
    // Ticket analytics
    dailyCounts, resolutionByCategory, ticketsPerTech, byPriority,
    sla: { met: slaMet, missed: slaMissed, breached: slaBreach },
    busiestSites, hoursPerTech,
    totalTickets, openTickets, avgResolutionHours,
    // User analytics
    activeUsers: { today: activeUsersToday, week: activeUsersWeek, month: activeUsersMonth },
    featureUsage, topPaths, userActivity, hourlyTraffic, dailyTraffic, userDrilldown,
    // Call analytics
    callStats,
    // Meta
    range: days, generatedAt: new Date().toISOString()
  });
});

module.exports = router;
