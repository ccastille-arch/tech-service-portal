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
    const bodyToken = req.body && req.body._csrf;
    const headerToken = req.headers['x-csrf-token'];
    const provided = bodyToken || headerToken;
    if (provided !== token) {
      return res.status(403).render('error', {
        title: 'CSRF Error',
        message: 'Invalid or missing CSRF token. Please go back and try again.',
        user: req.session && req.session.user,
        unreadCount: 0
      });
    }
  }
  next();
}

module.exports = { csrfMiddleware };
