'use strict';
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || './data/tech.db';
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;
function getDb() {
  if (!db) {
    db = new DatabaseSync(path.resolve(DB_PATH));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','tech')) DEFAULT 'tech',
      external_id TEXT,
      sync_status TEXT DEFAULT 'local',
      last_synced_at TEXT,
      source_system TEXT DEFAULT 'local',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      ticket_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL CHECK(priority IN ('P1','P2','P3','P4')) DEFAULT 'P3',
      category TEXT NOT NULL CHECK(category IN ('electrical','mechanical','instrumentation','controls','general')) DEFAULT 'general',
      status TEXT NOT NULL CHECK(status IN ('open','in-progress','on-hold','completed','closed')) DEFAULT 'open',
      assigned_to TEXT REFERENCES users(id),
      location TEXT,
      well_site TEXT,
      due_date TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      ai_category_suggestion TEXT,
      ai_priority_suggestion TEXT,
      external_id TEXT,
      sync_status TEXT DEFAULT 'local',
      last_synced_at TEXT,
      source_system TEXT DEFAULT 'local',
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT,
      size INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_history (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      field_changed TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      clock_in TEXT NOT NULL,
      clock_out TEXT,
      duration_minutes REAL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Integration Hub Tables
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('mlink','enbase','netsuite','fieldaware','email','sms','telephony','twilio','documents')),
      environment TEXT NOT NULL DEFAULT 'sandbox',
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_credentials (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      key_name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      expires_at TEXT,
      is_sandbox INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_logs (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      request_summary TEXT,
      response_summary TEXT,
      error TEXT,
      duration_ms INTEGER,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      object_type TEXT NOT NULL,
      object_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','bidirectional')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','conflict')),
      payload_json TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS field_mappings (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      object_type TEXT NOT NULL,
      source_field TEXT NOT NULL,
      target_field TEXT NOT NULL,
      transform_rule TEXT NOT NULL DEFAULT 'direct',
      is_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_time_entries_ticket ON time_entries(ticket_id);
    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      call_sid TEXT UNIQUE NOT NULL,
      caller_number TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      duration_seconds INTEGER,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      username TEXT,
      path TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      feature TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_views_user ON page_views(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path, created_at);
    CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);

    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under-review','planned','in-progress','completed','declined')),
      priority TEXT DEFAULT NULL,
      admin_note TEXT,
      upvotes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feature_request_votes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(request_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS changelog (
      id TEXT PRIMARY KEY,
      version TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'feature' CHECK(type IN ('feature','improvement','fix','new')),
      is_published INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_integration_logs_integration ON integration_logs(integration_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_call_sessions_created ON call_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_changelog_created ON changelog(created_at);
  `);

  seedUsers(db);
  seedIntegrations(db);
  seedChangelog(db);
  initNexusSchema(db);
}

function initNexusSchema(db) {
  // ALTER TABLE tickets — wrapped individually so they fail silently if column exists
  const alterCols = [
    'ALTER TABLE tickets ADD COLUMN call_event_id TEXT',
    'ALTER TABLE tickets ADD COLUMN call_source TEXT',
    'ALTER TABLE tickets ADD COLUMN caller_name TEXT',
    'ALTER TABLE tickets ADD COLUMN caller_phone TEXT',
    'ALTER TABLE tickets ADD COLUMN unit_number TEXT',
    'ALTER TABLE tickets ADD COLUMN site TEXT',
    'ALTER TABLE tickets ADD COLUMN repeat_issue_flag INTEGER DEFAULT 0',
    'ALTER TABLE tickets ADD COLUMN previous_ticket_id TEXT',
    'ALTER TABLE tickets ADD COLUMN call_transcript TEXT',
    'ALTER TABLE tickets ADD COLUMN escalation_level INTEGER DEFAULT 0',
    "ALTER TABLE tickets ADD COLUMN assigned_via TEXT DEFAULT 'manual'",
  ];
  for (const sql of alterCols) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY,
      caller_phone TEXT,
      caller_name TEXT,
      unit_number TEXT,
      site TEXT,
      issue_summary TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','on-hold','escalating','connected','completed','abandoned')),
      assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      answered_by TEXT,
      escalation_path TEXT DEFAULT '[]',
      duration_seconds INTEGER,
      linked_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      transcript TEXT,
      source TEXT DEFAULT 'manual' CHECK(source IN ('manual','twilio','ai','inbound')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalation_list (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      priority_order INTEGER NOT NULL DEFAULT 0,
      availability TEXT NOT NULL DEFAULT 'on-shift' CHECK(availability IN ('on-shift','on-call','unavailable','out-of-service')),
      phone TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS call_attempts (
      id TEXT PRIMARY KEY,
      call_event_id TEXT NOT NULL REFERENCES call_events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      attempted_at TEXT NOT NULL,
      result TEXT DEFAULT 'no-answer' CHECK(result IN ('answered','no-answer','busy','declined','voicemail')),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS tech_schedule (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      shift_start TEXT,
      shift_end TEXT,
      on_call INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_call_events_status ON call_events(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_escalation_list_order ON escalation_list(priority_order);
  `);

  seedEscalationList(db);
}

function seedEscalationList(db) {
  const count = db.prepare('SELECT COUNT(*) as c FROM escalation_list').get().c;
  if (count > 0) return;
  const techs = db.prepare("SELECT id FROM users WHERE role='tech' ORDER BY created_at").all();
  const now = new Date().toISOString();
  techs.forEach((u, i) => {
    db.prepare('INSERT OR IGNORE INTO escalation_list (id, user_id, priority_order, availability, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), u.id, i, 'on-shift', now, now);
  });
}

function seedChangelog(db) {
  const count = db.prepare('SELECT COUNT(*) as c FROM changelog').get().c;
  if (count > 0) return; // already seeded
  const now = new Date().toISOString();
  const entries = [
    { title: 'Fleet Monitor', description: 'Live SCADA-style monitoring for all field units — Panel, Compressor A, and Compressor B. View real-time sensor readings, alarm highlights, and 24h trend charts for every data point. Click any reading to see sparkline history.', type: 'new' },
    { title: 'AI-Powered Work Order Assistant', description: 'New work orders now include AI category suggestion and priority recommendation buttons. Describe the issue and let AI pre-fill the category and priority for you.', type: 'feature' },
    { title: 'Automated Phone Answering', description: 'Incoming tech service calls are now answered by an AI assistant that collects issue details and automatically creates a work order. High-priority calls trigger instant SMS alerts to technicians.', type: 'new' },
    { title: 'Time Tracking', description: 'Technicians can clock in and out per work order directly from the ticket detail page. Total hours are tracked per ticket and per technician.', type: 'feature' },
    { title: 'Work Order History Timeline', description: 'Every status change, assignment, and update on a work order is recorded in a timeline so you can see exactly what happened and when.', type: 'improvement' },
    { title: 'Photo Attachments', description: 'Attach photos directly to work orders from the field. Supports JPEG, PNG, and other image formats.', type: 'feature' },
    { title: 'Notifications', description: 'Real-time in-app notifications when work orders are assigned to you, comments are added, or status changes.', type: 'feature' },
    { title: 'SLA Tracking', description: 'Work orders now show SLA status — on track, at risk, or breached — based on priority. P1 = 4 hours, P2 = 24 hours, P3 = 72 hours, P4 = 168 hours.', type: 'improvement' },
  ];
  const insert = db.prepare(`INSERT OR IGNORE INTO changelog (id, title, description, type, is_published, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`);
  for (const e of entries) {
    insert.run(uuidv4(), e.title, e.description, e.type, now, now);
  }
}

function seedUsers(db) {
  const now = new Date().toISOString();
  const adminPw = process.env.ADMIN_PASSWORD || 'Brayden25!';
  const users = [
    { username: 'cody', email: 'cody@localhost', name: 'Cody Castille', role: 'admin', password: adminPw },
    { username: 'austin.whitehurst', email: 'austin.whitehurst@techservices.local', name: 'Austin Whitehurst', role: 'tech', password: 'AustinTech#2025' },
    { username: 'clint.webb', email: 'clint.webb@techservices.local', name: 'Clint Webb', role: 'tech', password: 'ClintTech#2025' }
  ];

  for (const u of users) {
    const existing = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(u.username);
    // Use 10 rounds — fast enough for serverless cold starts, still secure
    const hash = bcrypt.hashSync(u.password, 10);
    if (!existing) {
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), u.username, u.email, hash, u.name, u.role, now, now);
    } else {
      // Always sync password hash so env var changes take effect on redeploy
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
        .run(hash, now, u.username);
    }
  }
}

function seedIntegrations(db) {
  const now = new Date().toISOString();
  const integrations = [
    {
      name: 'FW Murphy MLink',
      type: 'mlink',
      config_json: JSON.stringify({
        base_url: process.env.MLINK_API_URL || 'https://mlink-datastore.up.railway.app',
        sync_objects: ['telemetry', 'devices'],
        poll_interval_minutes: 5
      })
    },
    {
      name: 'Detechtion Enbase',
      type: 'enbase',
      config_json: JSON.stringify({
        base_url: process.env.ENBASE_API_URL || 'https://api.detechtion.com/enbase',
        sync_objects: ['compression_data', 'alarms'],
        poll_interval_minutes: 10
      })
    },
    {
      name: 'NetSuite ERP',
      type: 'netsuite',
      config_json: JSON.stringify({
        sync_objects: ['customers', 'assets', 'work_orders', 'invoices'],
        note: 'Stub — configure account_id and token in credentials'
      })
    },
    {
      name: 'FieldAware FSM',
      type: 'fieldaware',
      config_json: JSON.stringify({
        sync_objects: ['jobs', 'technicians', 'labor_hours', 'parts'],
        note: 'Stub — configure API key in credentials'
      })
    },
    {
      name: 'Twilio Voice & SMS',
      type: 'telephony',
      config_json: JSON.stringify({
        greeting: 'Thank you for calling Tech Services.',
        company_name: 'Tech Services',
        from_number: '',
        tech_sms_numbers: [
          { name: 'Austin Whitehurst', phone: '' },
          { name: 'Clint Webb', phone: '' }
        ],
        webhook_base_url: 'https://tech-service-portal.vercel.app',
        note: 'Add account_sid, auth_token, from_number in credentials. Set tech cell numbers above.'
      })
    }
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO integrations (id, name, type, environment, enabled, config_json, created_at, updated_at)
    VALUES (?, ?, ?, 'sandbox', 0, ?, ?, ?)
  `);

  for (const i of integrations) {
    const existing = db.prepare('SELECT id FROM integrations WHERE type = ?').get(i.type);
    if (!existing) {
      insert.run(uuidv4(), i.name, i.type, i.config_json, now, now);
    }
  }
}

// Ticket number: TKT-NNNN
function nextTicketNumber(db) {
  const row = db.prepare("SELECT ticket_number FROM tickets ORDER BY ticket_number DESC LIMIT 1").get();
  if (!row) return 'TKT-0001';
  const num = parseInt(row.ticket_number.replace('TKT-', ''), 10);
  return 'TKT-' + String(num + 1).padStart(4, '0');
}

module.exports = { getDb, initializeDatabase, nextTicketNumber };
