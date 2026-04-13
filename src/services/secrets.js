'use strict';
// Secrets provider — single point for all secret retrieval.
// Replace getSecret() body to read from Vault, AWS Secrets Manager, etc.
// App code must NEVER read process.env directly for sensitive values.

const REQUIRED_PRODUCTION = [
  'SESSION_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'ADMIN_PASSWORD',
];

function getSecret(name, defaultValue = undefined) {
  const val = process.env[name];
  if (val !== undefined) return val;
  return defaultValue;
}

function requireSecret(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Required secret "${name}" is not set.`);
  return val;
}

function validateSecretsOnStartup() {
  const env = process.env.NODE_ENV || 'development';
  const warnings = checkInsecureDefaults();

  if (env === 'production') {
    const missing = REQUIRED_PRODUCTION.filter(k => !process.env[k]);
    if (missing.length) {
      throw new Error(`STARTUP ABORT: Missing required secrets: ${missing.join(', ')}`);
    }
    const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
    if (!/^[0-9a-f]{64}$/i.test(encKey)) {
      throw new Error('STARTUP ABORT: CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars (32 bytes).');
    }
  }

  if (warnings.length) {
    console.warn('[SECURITY WARNINGS]');
    warnings.forEach(w => console.warn('  ⚠', w));
  }
}

function checkInsecureDefaults() {
  const warnings = [];
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (!sessionSecret || sessionSecret === 'dev-secret-change-me' || sessionSecret.length < 32) {
    warnings.push('SESSION_SECRET is weak or missing. Use 32+ random chars in production.');
  }
  const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (!encKey || encKey === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') {
    warnings.push('CREDENTIAL_ENCRYPTION_KEY is using the insecure default. Set a strong 64-hex-char key.');
  }
  if (!process.env.ADMIN_PASSWORD) {
    warnings.push('ADMIN_PASSWORD is not set. Using fallback — set this in production.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY is not set. AI features will be disabled.');
  }
  return warnings;
}

// Mask a secret for display/logging — show last 4 chars only
function maskSecret(val) {
  if (!val) return '[not set]';
  if (val.length <= 8) return '••••••••';
  return '•'.repeat(Math.min(val.length - 4, 16)) + val.slice(-4);
}

module.exports = { getSecret, requireSecret, validateSecretsOnStartup, maskSecret, checkInsecureDefaults };
