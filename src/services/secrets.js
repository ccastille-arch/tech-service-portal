'use strict';

const REQUIRED_PRODUCTION = ['SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'ADMIN_PASSWORD'];

function validateSecretsOnStartup() {
  const env = process.env.NODE_ENV;
  if (env === 'production') {
    const missing = REQUIRED_PRODUCTION.filter(k => !process.env[k]);
    if (missing.length) {
      throw new Error(`STARTUP ABORT: Missing required production secrets: ${missing.join(', ')}`);
    }
  }
  // Warn on insecure defaults
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
    console.warn('[SECURITY] SESSION_SECRET is too short — use 32+ random characters in production.');
  }
  const defaultKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  if (process.env.CREDENTIAL_ENCRYPTION_KEY === defaultKey && env === 'production') {
    throw new Error('STARTUP ABORT: CREDENTIAL_ENCRYPTION_KEY is set to the insecure default in production.');
  }
}

function getSecret(name, fallback) {
  return process.env[name] || fallback;
}

function requireSecret(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Required secret ${name} is not set.`);
  return val;
}

function maskSecret(val) {
  if (!val || val.length < 4) return '••••••••';
  return '••••••••' + val.slice(-4);
}

module.exports = { validateSecretsOnStartup, getSecret, requireSecret, maskSecret };
