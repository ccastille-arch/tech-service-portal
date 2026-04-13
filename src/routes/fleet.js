'use strict';
const express = require('express');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/authenticate');
const { ticketScopeClause } = require('../middleware/authorize');
const router = express.Router();

// Fleet dashboard — shows open tickets by well site / location
router.get('/', requireAuth, (req, res) => {
  const db   = getDb();
  const user = req.session.user;

  // Build scoped query
  let sql = `
    SELECT t.well_site, t.location,
           COUNT(*) as total,
           SUM(CASE WHEN t.status='open' THEN 1 ELSE 0 END) as open,
           SUM(CASE WHEN t.status='in-progress' THEN 1 ELSE 0 END) as in_progress,
           SUM(CASE WHEN t.priority='P1' THEN 1 ELSE 0 END) as p1_count
    FROM tickets t
    WHERE t.status NOT IN ('closed','completed') AND (t.well_site IS NOT NULL OR t.location IS NOT NULL)
  `;
  const params = [];

  const scope = ticketScopeClause(user);
  if (scope.clause) {
    // ticketScopeClause adds 't.' prefix — works with this query
    sql += scope.clause;
    params.push(...scope.params);
  }

  sql += ' GROUP BY COALESCE(t.well_site, t.location) ORDER BY p1_count DESC, open DESC';

  const sites        = db.prepare(sql).all(...params);
  const recentAlerts = db.prepare(`
    SELECT t.ticket_number, t.title, t.priority, t.status, t.well_site, t.location, t.created_at, u.name as assigned_name
    FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.priority IN ('P1','P2') AND t.status NOT IN ('closed','completed')
    ${scope.clause.replace(/t\./g, 't.')}
    ORDER BY t.priority ASC, t.created_at DESC LIMIT 20
  `).all(...scope.params);

  res.render('fleet', {
    title: 'Fleet / Asset View',
    sites, recentAlerts,
    user, unreadCount: res.locals.unreadCount
  });
});

module.exports = router;
