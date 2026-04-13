'use strict';
const crypto = require('crypto');

function csrfMiddleware(req, res, next) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
  }
  const token = crypto.createHmac('sha256', req.session.csrfSecret)
    .update(req.session.id || 'no-session')
    .digest('hex');
  res.locals.csrfToken = token;

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const bodyToken   = req.body && req.body._csrf;
    const headerToken = req.headers['x-csrf-token'];
    const provided    = bodyToken || headerToken;
    if (provided !== token) {
      // Log CSRF failure to audit log
      try {
        const { getDb } = require('../database');
        const { logAudit, getClientIp, AUDIT_ACTIONS } = require('../services/audit');
        logAudit(getDb(), {
          actor_id:   req.session?.user?.id   || null,
          actor_name: req.session?.user?.name || null,
          action:     AUDIT_ACTIONS.SECURITY_CSRF,
          resource_type: 'request',
          new_value:  `${req.method} ${req.path}`,
          ip:         getClientIp(req),
          user_agent: req.headers['user-agent'],
        });
      } catch (_) { /* never let audit failure affect the response */ }

      return res.status(403).render('error', {
        title:      'CSRF Error',
        message:    'Invalid or missing CSRF token. Please go back and try again.',
        user:       req.session?.user,
        unreadCount: 0,
      });
    }
  }
  next();
}

module.exports = { csrfMiddleware };
