'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const INSECURE_DEFAULT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Validate and load the encryption key at module startup — fail fast.
function loadKey() {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!keyHex) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set in production.');
    }
    console.warn('[SECURITY] CREDENTIAL_ENCRYPTION_KEY not set — using insecure default. Never use in production.');
    return Buffer.from(INSECURE_DEFAULT, 'hex');
  }

  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }

  if (keyHex.toLowerCase() === INSECURE_DEFAULT && process.env.NODE_ENV === 'production') {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is set to the insecure default in production. Rotate it immediately.');
  }

  return Buffer.from(keyHex.slice(0, 64), 'hex');
}

const KEY = loadKey();

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(ciphertext) {
  const parts = (ciphertext || '').split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format.');
  const [ivB64, authTagB64, encB64] = parts;
  const iv        = Buffer.from(ivB64, 'base64');
  const authTag   = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encB64, 'base64');
  const decipher  = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// Safe for display and logs — shows only last 4 chars
function maskValue(val) {
  if (!val) return '••••••••';
  const s = String(val);
  if (s.length <= 8) return '••••••••';
  return '•'.repeat(Math.min(s.length - 4, 16)) + s.slice(-4);
}

// Encrypt only if non-empty
function encryptIfPresent(val) {
  if (val === null || val === undefined || val === '') return null;
  return encrypt(val);
}

module.exports = { encrypt, decrypt, maskValue, encryptIfPresent };
