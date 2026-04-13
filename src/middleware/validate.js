'use strict';

const ALLOWED_PRIORITIES  = ['P1','P2','P3','P4'];
const ALLOWED_STATUSES    = ['open','in-progress','on-hold','completed','closed'];
const ALLOWED_CATEGORIES  = ['electrical','mechanical','instrumentation','controls','general'];
const ALLOWED_ROLES       = ['admin','tech'];
const ALLOWED_SORT_COLS   = ['created_at','updated_at','priority','status','due_date','ticket_number'];

function sanitizeString(val, maxLen = 500) {
  if (val == null) return '';
  return String(val).trim().slice(0, maxLen);
}

function validateEnum(val, allowed, fallback) {
  return allowed.includes(val) ? val : fallback;
}

function validatePriority(val)  { return validateEnum(val, ALLOWED_PRIORITIES, 'P3'); }
function validateStatus(val)    { return validateEnum(val, ALLOWED_STATUSES, 'open'); }
function validateCategory(val)  { return validateEnum(val, ALLOWED_CATEGORIES, 'general'); }
function validateRole(val)      { return validateEnum(val, ALLOWED_ROLES, 'tech'); }
function validateSortCol(val)   { return validateEnum(val, ALLOWED_SORT_COLS, 'created_at'); }

function validateDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function validateEmail(val) {
  if (!val) return null;
  const clean = sanitizeString(val, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean.toLowerCase() : null;
}

function validateUsername(val) {
  const clean = sanitizeString(val, 50).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return clean.length >= 3 ? clean : null;
}

function validatePasswordStrength(val) {
  if (!val || val.length < 8) return false;
  if (!/[a-zA-Z]/.test(val)) return false;
  if (!/[0-9!@#$%^&*]/.test(val)) return false;
  return true;
}

function sanitizeSearchQuery(val, maxLen = 100) {
  // Escape LIKE wildcards to prevent injection
  return sanitizeString(val, maxLen).replace(/[%_\\]/g, '\\$&');
}

module.exports = {
  ALLOWED_PRIORITIES, ALLOWED_STATUSES, ALLOWED_CATEGORIES, ALLOWED_ROLES, ALLOWED_SORT_COLS,
  sanitizeString, validateEnum, validatePriority, validateStatus, validateCategory, validateRole,
  validateSortCol, validateDate, validateEmail, validateUsername, validatePasswordStrength,
  sanitizeSearchQuery
};
