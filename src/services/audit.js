'use strict';
// Audit logging service.
// NEVER pass raw secrets, tokens, or password values to logAudit().
// All values are sanitized automatically before storage.

const { v4: uuidv4 } = require('uuid');

const AUDIT_ACTIONS = {
  // Auth
  LOGIN_SUCCESS:        'auth.login.success',
  LOGIN_FAILED:         'auth.login.failed',
  LOGOUT:               'auth.logout',
  ACCOUNT_LOCKED:       'auth.account.locked',
  PASSWORD_RESET:       'auth.password.reset',
  // Admin
  USER_CREATED:         'admin.user.created',
  USER_UPDATED:         'admin.user.updated',
  USER_DELETED:         'admin.user.deleted',
  ROLE_CHANGED:         'admin.role.changed',
  // Tickets
  TICKET_CREATED:       'ticket.created',
  TICKET_UPDATED:       'ticket.updated',
  TICKET_ESCALATED:     'ticket.escalated',
  // Integrations
  INTEGRATION_CREATED:  'integration.created',
  INTEGRATION_UPDATED:  'integration.updated',
  INTEGRATION_ENABLED:  'integration.enabled',
  INTEGRATION_DISABLED: 'integration.disabled',
  CREDENTIAL_ADDED:     'integration.credential.added',
  CREDENTIAL_DELETED:   'integration.credential.deleted',
  CREDENTIAL_ROTATED:   'integration.credential.rotated',
  INTEGRATION_TEST:     'integration.test',
  INTEGRATION_SYNC:     'integration.sync',
  // Security events
  SECURITY_CSRF:        'security.csrf.failure',
  SECURITY_UNAUTH:      'security.unauthorized',
};

// Patterns that look like secrets — redact before storing
const SECRET_PATTERNS = [
  /password[^"'\s]{0,20}["'\s:=]+[^\s,}"']{4,}/gi,
  /token[^"'\s]{0,10}["'\s:=]+[^\s,}"']{8,}/gi,
  /secret[^"'\s]{0,10}["'\s:=]+[^\s,}"']{8,}/gi,
  /api_key[^"'\s]{0,10}["'\s:=]+[^\s,}"']{8,}/gi,
  /sk-ant-[a-z0-9\-_]+/gi,
  /Bearer\s+[a-z0-9\-_.]{8,}/gi,
];

function sanitizeValue(val) {
  if (val === null || val === undefined) return val;
  let s = typeof val === 'string' ? val : JSON.stringify(val);
  for (const p of SECRET_PATTERNS) s = s.replace(p, '[REDACTED]');
  return s.substring(0, 2000);
}

function sanitizeMeta(meta) {
  if (!meta) return null;
  const SENSITIVE_KEYS = ['password', 'password_hash', 'token', 'secret', 'api_key', 'encrypted_value', 'auth_token'];
  const clean = { ...meta };
  for (const key of Object.keys(clean)) {
    if (SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s))) clean[key] = '[REDACTED]';
  }
  return clean;
}

function logAudit(db, {
  actor_id, actor_name, action,
  resource_type, resource_id,
  old_value, new_value,
  ip, user_agent, meta
} = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs
        (id, actor_id, actor_name, action, resource_type, resource_id,
         old_value, new_value, ip, user_agent, meta, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      uuidv4(),
      actor_id   || null,
      actor_name || null,
      action,
      resource_type || null,
      resource_id   || null,
      sanitizeValue(old_value),
      sanitizeValue(new_value),
      ip || null,
      user_agent ? String(user_agent).substring(0, 200) : null,
      meta ? JSON.stringify(sanitizeMeta(meta)) : null,
      new Date().toISOString()
    );
  } catch (e) {
    // Audit failure must never crash the app
    console.error('[AUDIT ERROR]', e.message);
  }
}

function getClientIp(req) {
  return req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection?.remoteAddress ||
    null;
}

// Helper to build actor context from a request session
function actorFromReq(req) {
  const u = req.session?.user;
  return {
    actor_id:   u?.id   || null,
    actor_name: u?.name || null,
    ip:         getClientIp(req),
    user_agent: req.headers['user-agent'],
  };
}

module.exports = { logAudit, getClientIp, actorFromReq, AUDIT_ACTIONS };
