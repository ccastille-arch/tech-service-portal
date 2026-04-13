'use strict';

// Factory: require one of the specified roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Access Denied',
        message: 'You do not have permission to access this page.',
        user: req.session.user, unreadCount: 0
      });
    }
    next();
  };
}

// Row-level scoping for ticket queries.
// Returns { clause: string, params: [] } to append to WHERE 1=1
function ticketScopeClause(user) {
  if (!user || user.role === 'admin') return { clause: '', params: [] };
  return {
    clause: ' AND (t.assigned_to = ? OR t.created_by = ?)',
    params: [user.id, user.id]
  };
}

// Assert that the current user owns the resource or is admin
function assertOwnership(resource, actorId, actorRole, ownerField = 'user_id') {
  if (actorRole === 'admin') return true;
  return resource && resource[ownerField] === actorId;
}

// Strip sensitive fields before passing a user object to templates
function filterUserFields(user, viewerRole) {
  if (!user) return null;
  const { password_hash, encrypted_notes, ...safe } = user;
  if (viewerRole !== 'admin') {
    delete safe.locked_until;
    delete safe.login_attempts;
  }
  return safe;
}

module.exports = { requireRole, ticketScopeClause, assertOwnership, filterUserFields };
