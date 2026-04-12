'use strict';
const { getUnreadCount } = require('../services/notifications');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  // Attach unread notification count to res.locals for all views
  res.locals.user = req.session.user;
  res.locals.unreadCount = getUnreadCount(req.session.user.id);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Admin access required.', user: req.session.user, unreadCount: 0 });
  }
  res.locals.user = req.session.user;
  res.locals.unreadCount = getUnreadCount(req.session.user.id);
  next();
}

module.exports = { requireAuth, requireAdmin };
