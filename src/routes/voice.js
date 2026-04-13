'use strict';
/**
 * Twilio Voice webhook handler
 * POST /voice/inbound   — new call arrives
 * POST /voice/gather    — speech turn processed by Claude
 * POST /voice/recording — voicemail transcription received
 * POST /voice/status    — call completed callback
 */
const express   = require('express');
const crypto    = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, nextTicketNumber } = require('../database');
const { notifyAssignment } = require('../services/notifications');
const router = express.Router();

// ── Twilio webhook signature verification ─────────────────────────────────────
// Validates X-Twilio-Signature to ensure requests genuinely come from Twilio.
// If TWILIO_AUTH_TOKEN is not set, validation is skipped with a warning (dev mode).
function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[SECURITY] TWILIO_AUTH_TOKEN not set — webhook signature verification disabled in production!');
    }
    return next(); // skip in dev / when not yet configured
  }

  const signature = req.headers['x-twilio-signature'] || '';
  const baseUrl   = (process.env.WEBHOOK_BASE_URL || `https://${req.headers.host}`) + req.originalUrl.split('?')[0];

  // Build the string to sign: URL + sorted POST params concatenated
  const params    = req.body || {};
  const sortedStr = Object.keys(params).sort().reduce((s, k) => s + k + params[k], baseUrl);
  const expected  = crypto.createHmac('sha1', authToken).update(sortedStr).digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    const { logAudit, getClientIp, AUDIT_ACTIONS } = require('../services/audit');
    try {
      logAudit(getDb(), {
        action: AUDIT_ACTIONS.SECURITY_UNAUTH,
        resource_type: 'webhook',
        new_value: `invalid Twilio signature on ${req.method} ${req.path}`,
        ip: getClientIp(req),
        user_agent: req.headers['user-agent'],
      });
    } catch (_) {}
    return res.status(403).type('text/xml').send('<?xml version="1.0"?><Response><Reject/></Response>');
  }
  next();
}

// Apply to all voice webhook routes
router.use(verifyTwilioSignature);

// ── TwiML helpers ──────────────────────────────────────────────────────────
function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
function say(text) {
  // Polly.Joanna is natural-sounding; fallback to alice
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<Say voice="Polly.Joanna">${escaped}</Say>`;
}
function gather(action, prompt = '') {
  return `<Gather input="speech" speechTimeout="3" timeout="6" action="${action}" method="POST">${prompt ? say(prompt) : ''}</Gather>`;
}
function hangup() { return '<Hangup/>'; }
function record(action, transcribeAction) {
  return `<Say voice="Polly.Joanna">Please leave a message after the tone and we will create a work order from your voicemail.</Say><Record maxLength="120" transcribe="true" transcribeCallback="${transcribeAction}" action="${action}"/>`;
}

// ── Twilio SMS helper (no SDK — raw HTTPS) ──────────────────────────────────
const https = require('https');
function sendSms(accountSid, authToken, from, to, body) {
  return new Promise((resolve, reject) => {
    const params = `To=${encodeURIComponent(to)}&From=${encodeURIComponent(from)}&Body=${encodeURIComponent(body)}`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(params)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(params); req.end();
  });
}

// ── Load Twilio integration creds ────────────────────────────────────────────
function getTwilioCreds() {
  const db = getDb();
  const { decrypt } = require('../services/crypto');
  const integration = db.prepare("SELECT * FROM integrations WHERE type='telephony' AND enabled=1 ORDER BY created_at ASC LIMIT 1").get();
  if (!integration) return null;
  const creds = db.prepare('SELECT * FROM integration_credentials WHERE integration_id=?').all(integration.id);
  const get = key => { const c = creds.find(c => c.key_name === key); return c ? decrypt(c.encrypted_value) : null; };
  let config = {};
  try { config = JSON.parse(integration.config_json || '{}'); } catch {}
  return {
    accountSid: get('account_sid'),
    authToken: get('auth_token'),
    fromNumber: get('from_number') || config.from_number,
    techNumbers: config.tech_sms_numbers || [],   // array of { name, phone }
    greeting: config.greeting || 'Thank you for calling Tech Services.',
    companyName: config.company_name || 'Tech Services'
  };
}

// ── Claude voice conversation ─────────────────────────────────────────────────
let anthropicClient;
function getAI() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

const VOICE_TOOLS = [
  {
    name: 'speak_and_continue',
    description: 'Say something to the caller and wait for their next response. Use to ask follow-up questions.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What to say to the caller (1-2 sentences max)' } },
      required: ['message']
    }
  },
  {
    name: 'create_ticket',
    description: 'Create a work order ticket and tell the caller. Use once you have enough info.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['P1','P2','P3','P4'] },
        category: { type: 'string', enum: ['electrical','mechanical','instrumentation','controls','general'] },
        location: { type: 'string' },
        well_site: { type: 'string' },
        caller_name: { type: 'string' },
        caller_phone: { type: 'string' },
        response: { type: 'string', description: 'What to say to the caller after creating the ticket (mention ticket number placeholder [TICKET])' }
      },
      required: ['title', 'priority', 'category', 'response']
    }
  },
  {
    name: 'lookup_ticket',
    description: 'Look up an existing work order by ticket number.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_number: { type: 'string' },
        response: { type: 'string', description: 'What to say after looking up (use [STATUS], [ASSIGNED], [PRIORITY] as placeholders)' }
      },
      required: ['ticket_number', 'response']
    }
  },
  {
    name: 'end_call',
    description: 'End the call after saying goodbye.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message']
    }
  },
  {
    name: 'transfer_voicemail',
    description: 'Caller wants to leave a voicemail. Transfer to recording.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

async function processWithClaude(callSid, newUtterance, baseUrl) {
  const db = getDb();
  // Load or create session
  let session = db.prepare('SELECT * FROM call_sessions WHERE call_sid=?').get(callSid);
  let messages = session ? JSON.parse(session.messages) : [];

  messages.push({ role: 'user', content: newUtterance });

  const systemPrompt = `You are the automated phone answering service for Tech Services. Answer calls, create work orders, and look up ticket status.

CRITICAL RULES:
- Keep all responses VERY SHORT (1-2 sentences). This is a phone call.
- Never ask more than one question at a time.
- If they're reporting a problem, gather: what it is, where it is, then create the ticket.
- Don't ask for priority — you determine it from the description.
- Priority guide: P1=safety/fire/gas/production down, P2=major equipment failure, P3=equipment issue, P4=minor/planned.
- Once you have a title and location, create the ticket immediately — don't over-question.
- Be warm but efficient.

Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} (Central Time)`;

  const response = await getAI().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    tools: VOICE_TOOLS,
    messages
  });

  // Process tool use
  let twimlResponse = '';
  let assistantText = '';

  if (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const toolName = toolUse.name;
    const input = toolUse.input;

    if (toolName === 'speak_and_continue') {
      assistantText = input.message;
      twimlResponse = gather(`${baseUrl}/voice/gather`, '') + say(input.message) + gather(`${baseUrl}/voice/gather`);
      // Actually: say first, then gather
      twimlResponse = say(input.message) + gather(`${baseUrl}/voice/gather`);
    }
    else if (toolName === 'create_ticket') {
      // Create the ticket
      const ticketId = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      const now = new Date().toISOString();
      // Find created_by = first admin user
      const adminUser = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
      db.prepare(`
        INSERT INTO tickets (id, ticket_number, title, description, priority, category, status, location, well_site, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `).run(ticketId, ticketNumber, input.title, input.description || '', input.priority, input.category,
        input.location || null, input.well_site || null, adminUser?.id || null, now, now);

      // Record history
      db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
        .run(uuidv4(), ticketId, adminUser?.id || null, 'status', null, 'open', now);

      // Update call session with ticket_id
      db.prepare('UPDATE call_sessions SET ticket_id=? WHERE call_sid=?').run(ticketId, callSid);

      // SMS alert for P1 or P2
      if (['P1','P2'].includes(input.priority)) {
        const creds = getTwilioCreds();
        if (creds && creds.accountSid && creds.authToken && creds.fromNumber && creds.techNumbers?.length) {
          const smsBody = `🚨 ${input.priority} TICKET ${ticketNumber}: ${input.title}\nLocation: ${input.location || input.well_site || 'Unknown'}\nCaller: ${input.caller_name || 'Unknown'} ${input.caller_phone || ''}\nhttps://tech-service-portal.vercel.app/tickets/${ticketId}`;
          for (const tech of creds.techNumbers) {
            sendSms(creds.accountSid, creds.authToken, creds.fromNumber, tech.phone || tech, smsBody).catch(console.error);
          }
        }
      }

      assistantText = input.response.replace('[TICKET]', ticketNumber);
      twimlResponse = say(assistantText) + say('Is there anything else I can help you with?') + gather(`${baseUrl}/voice/gather`);
    }
    else if (toolName === 'lookup_ticket') {
      const t = db.prepare("SELECT t.*, u.name as assigned_name FROM tickets t LEFT JOIN users u ON u.id=t.assigned_to WHERE UPPER(t.ticket_number)=UPPER(?)").get(input.ticket_number);
      let responseText;
      if (!t) {
        responseText = `I couldn't find ticket number ${input.ticket_number}. Please double-check the number and try again.`;
      } else {
        responseText = input.response
          .replace('[STATUS]', t.status)
          .replace('[ASSIGNED]', t.assigned_name || 'Unassigned')
          .replace('[PRIORITY]', t.priority);
      }
      assistantText = responseText;
      twimlResponse = say(responseText) + say('Is there anything else I can help with?') + gather(`${baseUrl}/voice/gather`);
    }
    else if (toolName === 'end_call') {
      assistantText = input.message;
      twimlResponse = say(input.message) + hangup();
    }
    else if (toolName === 'transfer_voicemail') {
      twimlResponse = record(`${baseUrl}/voice/recording-done`, `${baseUrl}/voice/recording`);
      assistantText = '[transferred to voicemail]';
    }
  } else {
    // Text response (shouldn't happen with tool_use, but handle gracefully)
    const textBlock = response.content.find(b => b.type === 'text');
    assistantText = textBlock?.text || 'I apologize, could you repeat that?';
    twimlResponse = say(assistantText) + gather(`${baseUrl}/voice/gather`);
  }

  // Save conversation turn
  messages.push({ role: 'assistant', content: response.content });
  const sessionData = { messages: JSON.stringify(messages), updated_at: new Date().toISOString() };
  if (session) {
    db.prepare('UPDATE call_sessions SET messages=?, updated_at=? WHERE call_sid=?').run(sessionData.messages, sessionData.updated_at, callSid);
  } else {
    db.prepare('INSERT INTO call_sessions (id,call_sid,caller_number,messages,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(uuidv4(), callSid, '', sessionData.messages, 'active', new Date().toISOString(), sessionData.updated_at);
  }

  return twiml(twimlResponse);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Inbound call — greet and start gathering
router.post('/inbound', (req, res) => {
  res.type('text/xml');
  const callSid = req.body.CallSid || 'unknown';
  const callerNumber = req.body.From || 'Unknown';
  const db = getDb();
  const baseUrl = `https://${req.headers.host}`;

  // Create session record
  db.prepare('INSERT OR IGNORE INTO call_sessions (id,call_sid,caller_number,messages,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), callSid, callerNumber, '[]', 'active', new Date().toISOString(), new Date().toISOString());

  const creds = getTwilioCreds();
  const greeting = creds?.greeting || 'Thank you for calling Tech Services.';
  const prompt = `${greeting} How can I help you today?`;

  res.send(twiml(
    say(prompt) + gather(`${baseUrl}/voice/gather`)
    + say('I didn\'t catch that.') + gather(`${baseUrl}/voice/gather`)
    // If still no speech, offer voicemail
    + say('I\'m having trouble hearing you. Let me transfer you to leave a voicemail.')
    + record(`${baseUrl}/voice/recording-done`, `${baseUrl}/voice/recording`)
  ));
});

// Each speech turn — route through Claude
router.post('/gather', async (req, res) => {
  res.type('text/xml');
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult;
  const baseUrl = `https://${req.headers.host}`;

  if (!speech || !speech.trim()) {
    // No speech detected — offer voicemail
    return res.send(twiml(
      say('I\'m sorry, I didn\'t catch that. Would you like to leave a voicemail, or try again?')
      + gather(`${baseUrl}/voice/gather`)
      + record(`${baseUrl}/voice/recording-done`, `${baseUrl}/voice/recording`)
    ));
  }

  // Update caller number if missing
  const callerNumber = req.body.From;
  if (callerNumber) {
    getDb().prepare('UPDATE call_sessions SET caller_number=? WHERE call_sid=? AND caller_number=""').run(callerNumber, callSid);
  }

  try {
    const response = await processWithClaude(callSid, speech, baseUrl);
    res.send(response);
  } catch (err) {
    console.error('Voice Claude error:', err);
    res.send(twiml(
      say('I\'m sorry, I\'m having a technical issue. Please leave a voicemail and someone will call you back.')
      + record(`${baseUrl}/voice/recording-done`, `${baseUrl}/voice/recording`)
    ));
  }
});

// Voicemail transcription callback (async — Twilio calls this after transcribing)
router.post('/recording', async (req, res) => {
  res.type('text/xml').send(twiml(''));  // Acknowledge immediately

  const callSid = req.body.CallSid;
  const transcript = req.body.TranscriptionText;
  const recordingUrl = req.body.RecordingUrl;

  if (!transcript && !recordingUrl) return;

  try {
    const db = getDb();
    const session = db.prepare('SELECT * FROM call_sessions WHERE call_sid=?').get(callSid);
    const callerNumber = session?.caller_number || req.body.From || 'Unknown';
    const adminUser = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();

    // Use Claude to extract ticket info from transcript
    if (transcript && transcript.trim()) {
      let title = `Voicemail from ${callerNumber}`;
      let description = transcript;
      let priority = 'P3';
      let category = 'general';

      try {
        const ai = getAI();
        const msg = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Extract work order info from this voicemail transcript. Respond with JSON only.
Transcript: "${transcript}"
JSON: {"title":"...", "priority":"P1|P2|P3|P4", "category":"electrical|mechanical|instrumentation|controls|general", "description":"..."}`
          }]
        });
        const parsed = JSON.parse(msg.content[0].text.trim().replace(/```json\n?|\n?```/g, ''));
        title = parsed.title || title;
        description = parsed.description || transcript;
        priority = parsed.priority || 'P3';
        category = parsed.category || 'general';
      } catch {}

      const ticketId = uuidv4();
      const ticketNumber = nextTicketNumber(db);
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tickets (id, ticket_number, title, description, priority, category, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(ticketId, ticketNumber, title, `Voicemail from ${callerNumber}:\n\n${description}`, priority, category, adminUser?.id || null, now, now);

      db.prepare('INSERT INTO ticket_history (id,ticket_id,user_id,field_changed,old_value,new_value,changed_at) VALUES (?,?,?,?,?,?,?)')
        .run(uuidv4(), ticketId, adminUser?.id || null, 'status', null, 'open', now);

      db.prepare('UPDATE call_sessions SET ticket_id=?, status=? WHERE call_sid=?').run(ticketId, 'voicemail', callSid);

      // Alert techs for P1/P2
      if (['P1','P2'].includes(priority)) {
        const creds = getTwilioCreds();
        if (creds?.accountSid && creds?.techNumbers?.length) {
          const smsBody = `🚨 ${priority} VOICEMAIL TICKET ${ticketNumber}: ${title}\nCaller: ${callerNumber}\nhttps://tech-service-portal.vercel.app/tickets/${ticketId}`;
          for (const tech of creds.techNumbers) {
            sendSms(creds.accountSid, creds.authToken, creds.fromNumber, tech.phone || tech, smsBody).catch(console.error);
          }
        }
      }
    }
  } catch (err) {
    console.error('Voicemail processing error:', err);
  }
});

// Recording done (not transcription — just confirm recording saved)
router.post('/recording-done', (req, res) => {
  res.type('text/xml').send(twiml(say('Thank you for your message. We will follow up shortly. Goodbye.') + hangup()));
});

// Call status callback — mark session complete
router.post('/status', (req, res) => {
  res.sendStatus(204);
  const { CallSid, CallStatus, CallDuration } = req.body;
  try {
    getDb().prepare('UPDATE call_sessions SET status=?, duration_seconds=?, ended_at=? WHERE call_sid=?')
      .run(CallStatus || 'completed', parseInt(CallDuration) || 0, new Date().toISOString(), CallSid);
  } catch {}
});

// Call log view (admin)
router.get('/', (req, res) => {
  if (!req.session?.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
  const db = getDb();
  const calls = db.prepare(`
    SELECT cs.*, t.ticket_number, t.title as ticket_title, t.priority
    FROM call_sessions cs
    LEFT JOIN tickets t ON t.id = cs.ticket_id
    ORDER BY cs.created_at DESC LIMIT 100
  `).all();
  res.render('calls', { title: 'Call Log', calls, user: req.session.user, unreadCount: res.locals?.unreadCount || 0 });
});

module.exports = router;
