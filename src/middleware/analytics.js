'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

// Map path prefixes to friendly feature names
function featureFromPath(method, path) {
  if (path.startsWith('/fleet'))        return 'Fleet Monitor';
  if (path.startsWith('/tickets/new'))  return 'New Work Order';
  if (path.startsWith('/tickets/') && method === 'POST') return 'Update Work Order';
  if (path.startsWith('/tickets/'))     return 'View Work Order';
  if (path.startsWith('/tickets'))      return 'Work Order List';
  if (path.startsWith('/dashboard'))    return 'Dashboard';
  if (path.startsWith('/reports'))      return 'Reports';
  if (path.startsWith('/integrations')) return 'Integrations';
  if (path.startsWith('/notifications'))return 'Notifications';
  if (path.startsWith('/calls'))        return 'Call Log';
  if (path.startsWith('/api/ai'))       return 'AI Features';
  if (path.startsWith('/api/'))         return 'API';
  if (path.startsWith('/login'))        return 'Login';
  if (path.startsWith('/logout'))       return 'Logout';
  if (path.startsWith('/public'))       return null; // skip static
  return 'Other';
}

function analyticsMiddleware(req, res, next) {
  // Skip static assets, health checks, and SSO token exchange
  if (req.path.startsWith('/public') || req.path === '/health' || req.path === '/favicon') {
    return next();
  }

  const start = Date.now();
  const originalEnd = res.end.bind(res);

  res.end = function(...args) {
    originalEnd(...args);
    try {
      const feature = featureFromPath(req.method, req.path);
      if (feature === null) return; // skip static

      const db = getDb();
      const userId = req.session?.user?.id || null;
      const username = req.session?.user?.username || req.session?.user?.name || null;

      db.prepare(`
        INSERT INTO page_views (id, user_id, username, path, method, feature, status_code, duration_ms, ip, user_agent, referrer, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        userId,
        username,
        req.path,
        req.method,
        feature || 'Other',
        res.statusCode,
        Date.now() - start,
        req.ip || null,
        (req.headers['user-agent'] || '').slice(0, 512),
        (req.headers['referer'] || '').slice(0, 512),
        new Date().toISOString()
      );
    } catch(e) {
      // Never crash the app due to analytics failure
    }
  };

  next();
}

module.exports = { analyticsMiddleware };
