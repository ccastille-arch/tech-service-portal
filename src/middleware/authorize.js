'use strict';
// Role-based authorization helpers beyond basic requireAuth/requireAdmin.

const { getUnreadCount } = require('../services/notifications');

// Factory: requireRole('admin') or requireRole('admin', 'tech')
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.session?.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!allowed.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Access Denied',
        message: `This page requires role: ${allowed.join(' or ')}.`,
        user: req.session.user,
        unreadCount: res.locals.unreadCount || 0,
      });
    }
    res.locals.user       = req.session.user;
    res.locals.unreadCount = getUnreadCount(req.session.user.id);
    next();
  };
}

// Build a SQL WHERE fragment that scopes ticket queries by user (non-admins
// can only see tickets they created or are assigned to).
function ticketScopeClause(user) {
  if (user.role === 'admin') return { clause: '', params: [] };
  return { clause: ' AND (t.assigned_to = ? OR t.created_by = ?)', params: [user.id, user.id] };
}

// Strip sensitive fields from user objects before sending to views/API
function filterUserFields(user, viewerRole) {
  if (!user) return user;
  // eslint-disable-next-line no-unused-vars
  const { password_hash, ...safe } = user;
  if (viewerRole !== 'admin') {
    // eslint-disable-next-line no-unused-vars
    const { external_id, sync_status, last_synced_at, source_system, login_attempts, locked_until, ...minimal } = safe;
    return minimal;
  }
  return safe;
}

// Verify resource ownership — admins bypass, others must own it
function assertOwnership(resource, actorId, actorRole, ownerField = 'user_id') {
  if (actorRole === 'admin') return true;
  return resource?.[ownerField] === actorId;
}

module.exports = { requireRole, ticketScopeClause, filterUserFields, assertOwnership };
