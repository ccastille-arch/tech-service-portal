'use strict';
// Input validation and sanitization helpers.
// Call these at the top of route handlers before touching the DB.

const ALLOWED_PRIORITIES  = ['P1', 'P2', 'P3', 'P4'];
const ALLOWED_STATUSES    = ['open', 'in-progress', 'on-hold', 'completed', 'closed'];
const ALLOWED_CATEGORIES  = ['electrical', 'mechanical', 'instrumentation', 'controls', 'general'];
const ALLOWED_ROLES       = ['admin', 'tech'];
const ALLOWED_SORT_COLS   = ['created_at', 'updated_at', 'priority', 'status', 'due_date', 'ticket_number'];

function sanitizeString(val, maxLen = 1000) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s.length === 0 ? null : s.substring(0, maxLen);
}

function validateEnum(val, allowed, defaultVal = null) {
  if (!val) return defaultVal;
  const match = allowed.find(a => a.toLowerCase() === String(val).trim().toLowerCase());
  return match || defaultVal;
}

function validatePriority(val) {
  if (!val) return null;
  const u = String(val).trim().toUpperCase();
  return ALLOWED_PRIORITIES.includes(u) ? u : null;
}

function validateStatus(val) {
  return validateEnum(val, ALLOWED_STATUSES);
}

function validateCategory(val) {
  return validateEnum(val, ALLOWED_CATEGORIES);
}

function validateRole(val) {
  return validateEnum(val, ALLOWED_ROLES);
}

function validateSortCol(val) {
  return ALLOWED_SORT_COLS.includes(val) ? val : 'created_at';
}

function validateDate(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() < 2000 || d.getFullYear() > new Date().getFullYear() + 10) return null;
  return d.toISOString().split('T')[0];
}

function validateEmail(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

function validateUsername(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();
  return /^[a-z0-9._-]{2,50}$/.test(s) ? s : null;
}

// Minimum 8 chars, at least 1 letter, 1 number
function validatePasswordStrength(val) {
  if (!val || val.length < 8) return { ok: false, reason: 'Password must be at least 8 characters.' };
  if (!/[a-zA-Z]/.test(val))  return { ok: false, reason: 'Password must contain at least one letter.' };
  if (!/[0-9]/.test(val))     return { ok: false, reason: 'Password must contain at least one number.' };
  return { ok: true };
}

// Escape LIKE wildcards to prevent wildcard injection in search
function sanitizeSearchQuery(val) {
  if (!val) return null;
  return String(val).trim().substring(0, 100).replace(/[%_\\]/g, c => '\\' + c);
}

module.exports = {
  sanitizeString,
  validateEnum,
  validatePriority,
  validateStatus,
  validateCategory,
  validateRole,
  validateSortCol,
  validateDate,
  validateEmail,
  validateUsername,
  validatePasswordStrength,
  sanitizeSearchQuery,
  ALLOWED_PRIORITIES,
  ALLOWED_STATUSES,
  ALLOWED_CATEGORIES,
  ALLOWED_ROLES,
};
