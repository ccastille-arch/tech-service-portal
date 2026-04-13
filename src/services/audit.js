'use strict';
const { v4: uuidv4 } = require('uuid');

const AUDIT_ACTIONS = {
  LOGIN_SUCCESS:       'login.success',
  LOGIN_FAILED:        'login.failed',
  LOGIN_LOCKED:        'login.locked',
  LOGOUT:              'logout',
  USER_CREATED:        'user.created',
  USER_UPDATED:        'user.updated',
  USER_DELETED:        'user.deleted',
  USER_ROLE_CHANGED:   'user.role_changed',
  USER_PW_RESET:       'user.password_reset',
  USER_UNLOCKED:       'user.unlocked',
  TICKET_CREATED:      'ticket.created',
  TICKET_UPDATED:      'ticket.updated',
  TICKET_FINALIZED:    'ticket.finalized',
  TICKET_CLOSED:       'ticket.closed',
  TICKET_ESCALATED:    'ticket.escalated',
  CREDENTIAL_ADDED:    'credential.added',
  CREDENTIAL_ROTATED:  'credential.rotated',
  CREDENTIAL_DELETED:  'credential.deleted',
  INTEGRATION_TEST:    'integration.test',
  INTEGRATION_ENABLED: 'integration.enabled',
  INTEGRATION_DISABLED:'integration.disabled',
  CALL_CREATED:        'call.created',
  CALL_ASSIGNED:       'call.assigned',
  CALL_ENDED:          'call.ended',
  CALL_ESCALATED:      'call.escalated',
  SECURITY_CSRF:       'security.csrf_failure',
  SECURITY_ACCESS:     'security.access_denied',
  FILE_ACCESSED:       'file.accessed',
};

const SECRET_PATTERNS = [
  /password["\s:=]+[^\s"]+/gi,
  /token["\s:=]+[^\s"]+/gi,
  /api_key["\s:=]+[^\s"]+/gi,
  /secret["\s:=]+[^\s"]+/gi,
  /encrypted_value["\s:=]+[^\s"]+/gi,
];

function redact(str) {
  if (!str) return str;
  let s = String(str);
  for (const p of SECRET_PATTERNS) s = s.replace(p, '[REDACTED]');
  return s;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.socket?.remoteAddress ||
         'unknown';
}

function actorFromReq(req) {
  const u = req.session?.user;
  return {
    actor_id:   u?.id   || null,
    actor_name: u?.name || 'anonymous',
    ip:         getClientIp(req),
    user_agent: (req.headers['user-agent'] || '').slice(0, 255),
  };
}

function logAudit(db, { actor_id, actor_name, action, resource_type, resource_id, old_value, new_value, ip, user_agent, meta } = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, actor_id, actor_name, action, resource_type, resource_id, old_value, new_value, ip, user_agent, meta, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      uuidv4(),
      actor_id  || null,
      actor_name || 'system',
      action    || 'unknown',
      resource_type || null,
      resource_id   || null,
      redact(old_value != null ? String(old_value) : null),
      redact(new_value != null ? String(new_value) : null),
      ip        || null,
      user_agent || null,
      meta ? JSON.stringify(meta) : null,
      new Date().toISOString()
    );
  } catch (_) { /* never crash the app */ }
}

module.exports = { logAudit, actorFromReq, getClientIp, AUDIT_ACTIONS };
