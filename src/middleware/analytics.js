'use strict';
const { getDb } = require('../database');

function analyticsMiddleware(req, res, next) {
  // Only track GET page views, skip static assets and API calls
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/public/') || req.path.startsWith('/files/')) return next();
  if (req.path === '/health') return next();

  try {
    const db = getDb();
    const userId = req.session?.user?.id || null;
    db.prepare(`
      INSERT INTO page_views (id, user_id, path, method, ip, user_agent, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      require('crypto').randomUUID(),
      userId,
      req.path.slice(0, 255),
      req.method,
      (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').slice(0, 45),
      (req.headers['user-agent'] || '').slice(0, 255),
      new Date().toISOString()
    );
  } catch (_) { /* non-fatal */ }

  next();
}

module.exports = { analyticsMiddleware };
