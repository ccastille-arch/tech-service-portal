'use strict';
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

// ── Twilio signature verification ─────────────────────────────────────────────
function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return next(); // Skip in dev if not configured

  const signature = req.headers['x-twilio-signature'] || '';
  if (!signature) {
    return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
  }

  // Replay protection — reject requests older than 5 minutes
  const twilioTs = req.headers['x-twilio-timestamp'];
  if (twilioTs) {
    const age = Math.abs(Date.now() / 1000 - parseInt(twilioTs));
    if (age > 300) {
      return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
    }
  }

  const baseUrl = (process.env.WEBHOOK_BASE_URL || `https://${req.headers.host}`) + req.originalUrl.split('?')[0];
  const params  = req.body || {};
  const sortedStr = Object.keys(params).sort().reduce((s, k) => s + k + params[k], baseUrl);
  const expected  = crypto.createHmac('sha1', authToken).update(sortedStr).digest('base64');

  try {
    const sigBuf = Buffer.from(signature, 'base64');
    const expBuf = Buffer.from(expected,  'base64');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
    }
  } catch (_) {
    return res.status(403).type('text/xml').send('<Response><Reject/></Response>');
  }

  next();
}

// Apply signature verification to all voice routes
router.use(express.urlencoded({ extended: false }));
router.use(verifyTwilioSignature);

// ── Inbound call ──────────────────────────────────────────────────────────────
router.post('/inbound', (req, res) => {
  const from = req.body.From || 'Unknown';
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Tech Service. Please hold while we connect you.</Say>
  <Enqueue>tech-service-queue</Enqueue>
</Response>`);
});

// ── Call status callback ───────────────────────────────────────────────────────
router.post('/status', (req, res) => {
  res.type('text/xml').send('<Response/>');
});

// ── Active calls list (authenticated UI) ─────────────────────────────────────
const { requireAuth } = require('../middleware/authenticate');

router.get('/', requireAuth, (req, res) => {
  res.render('calls', {
    title: 'Call Queue',
    user: req.session.user,
    unreadCount: res.locals.unreadCount
  });
});

module.exports = router;
