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
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
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
      last_login_at TEXT,
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
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
      finalized_at TEXT,
      finalized_by TEXT REFERENCES users(id),
      closed_at TEXT,
      closed_by TEXT REFERENCES users(id),
      closure_status TEXT CHECK(closure_status IN ('resolved','unresolved','escalated')),
      final_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      comment_type TEXT NOT NULL DEFAULT 'note',
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
      type TEXT NOT NULL CHECK(type IN ('mlink','enbase','netsuite','fieldaware','email','sms','telephony','documents')),
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

    -- Nexus Call Center
    CREATE TABLE IF NOT EXISTS nexus_calls (
      id TEXT PRIMARY KEY,
      call_number TEXT UNIQUE NOT NULL,
      caller_name TEXT,
      caller_phone TEXT,
      caller_company TEXT,
      subject TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'P3' CHECK(priority IN ('P1','P2','P3','P4')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','active','on-hold','transferred','ended','escalated')),
      assigned_to TEXT REFERENCES users(id),
      ticket_id TEXT REFERENCES tickets(id),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER,
      notes TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Community / Feature Requests
    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      author_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under-review','planned','in-progress','completed','declined')),
      upvotes INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      admin_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feature_request_votes (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(request_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS changelog (
      id TEXT PRIMARY KEY,
      version TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'feature' CHECK(type IN ('new','feature','improvement','fix')),
      is_published INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Audit Logs (append-only)
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      old_value TEXT,
      new_value TEXT,
      ip TEXT,
      user_agent TEXT,
      meta TEXT,
      created_at TEXT NOT NULL
    );

    -- Analytics page views
    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      path TEXT,
      method TEXT,
      feature TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at TEXT NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned   ON tickets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tickets_priority   ON tickets(priority);
    CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_time_entries_ticket ON time_entries(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status  ON sync_queue(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_integration_logs   ON integration_logs(integration_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor   ON audit_logs(actor_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_nexus_calls_status ON nexus_calls(status);
    CREATE INDEX IF NOT EXISTS idx_page_views_path    ON page_views(path, created_at);
  `);

  // Safe schema migrations for existing databases
  initSecuritySchema(db);
  seedUsers(db);
  seedIntegrations(db);
  purgeExpiredSessions(db);
}

function initSecuritySchema(db) {
  // Add columns that may not exist in older databases (safe ALTER TABLE)
  const ticketCols = db.prepare("PRAGMA table_info(tickets)").all().map(r => r.name);
  const migrations = [
    ['finalized_at',    'ALTER TABLE tickets ADD COLUMN finalized_at TEXT'],
    ['finalized_by',    'ALTER TABLE tickets ADD COLUMN finalized_by TEXT'],
    ['closed_at',       'ALTER TABLE tickets ADD COLUMN closed_at TEXT'],
    ['closed_by',       'ALTER TABLE tickets ADD COLUMN closed_by TEXT'],
    ['closure_status',  'ALTER TABLE tickets ADD COLUMN closure_status TEXT'],
    ['final_notes',     'ALTER TABLE tickets ADD COLUMN final_notes TEXT'],
  ];
  for (const [col, sql] of migrations) {
    if (!ticketCols.includes(col)) {
      try { db.exec(sql); } catch (_) {}
    }
  }

  // Add lockout columns to users if missing
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  const userMigrations = [
    ['last_login_at',   'ALTER TABLE users ADD COLUMN last_login_at TEXT'],
    ['login_attempts',  'ALTER TABLE users ADD COLUMN login_attempts INTEGER NOT NULL DEFAULT 0'],
    ['locked_until',    'ALTER TABLE users ADD COLUMN locked_until TEXT'],
  ];
  for (const [col, sql] of userMigrations) {
    if (!userCols.includes(col)) {
      try { db.exec(sql); } catch (_) {}
    }
  }

  // Add comment_type if missing
  const commentCols = db.prepare("PRAGMA table_info(ticket_comments)").all().map(r => r.name);
  if (!commentCols.includes('comment_type')) {
    try { db.exec("ALTER TABLE ticket_comments ADD COLUMN comment_type TEXT NOT NULL DEFAULT 'note'"); } catch (_) {}
  }

  // Tech schedules table
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tech_schedules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      shift_start TEXT,
      shift_end TEXT,
      on_call INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, date)
    )`);
  } catch (_) {}

  // Escalation list table
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS escalation_list (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      availability TEXT NOT NULL DEFAULT 'on-shift',
      priority_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id)
    )`);
  } catch (_) {}
}

function purgeExpiredSessions(db) {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  } catch (_) {}
}

function seedUsers(db) {
  const now = new Date().toISOString();
  const adminPw = process.env.ADMIN_PASSWORD || 'Brayden25!';
  const users = [
    { username: 'cody', email: 'cody@localhost', name: 'Cody Castille', role: 'admin', password: adminPw },
    { username: 'austin.whitehurst', email: 'austin.whitehurst@techservices.local', name: 'Austin Whitehurst', role: 'admin', password: 'AustinTech#2025' },
    { username: 'clint.webb', email: 'clint.webb@techservices.local', name: 'Clint Webb', role: 'tech', password: 'ClintTech#2025' },
    { username: 'system', email: 'system@techservices.local', name: 'System', role: 'tech', password: uuidv4() }
  ];

  for (const u of users) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    const hash = bcrypt.hashSync(u.password, 12);
    if (!existing) {
      db.prepare(`
        INSERT OR IGNORE INTO users (id, username, email, password_hash, name, role, login_attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(uuidv4(), u.username, u.email, hash, u.name, u.role, now, now);
    } else {
      // Always sync password and role on boot
      db.prepare('UPDATE users SET password_hash=?, role=?, login_attempts=0, locked_until=NULL, updated_at=? WHERE username=?')
        .run(hash, u.role, now, u.username);
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
        base_url: process.env.MLINK_API_URL || 'https://api.fwmurphy-iot.com/api',
        device_ids: ['2504-504495', '2504-505561', '2504-505472'],
        sync_objects: ['telemetry', 'devices'],
        poll_interval_minutes: 5
      })
    },
    {
      name: 'Detechtion Enbase',
      type: 'enbase',
      config_json: JSON.stringify({
        base_url: process.env.ENBASE_API_URL || 'https://api.detechtion.com/enbase/api',
        sync_objects: ['assets', 'alarms', 'devices', 'measurements', 'customers', 'locations', 'downtime_events'],
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
    }
  ];

  for (const i of integrations) {
    const existing = db.prepare('SELECT id FROM integrations WHERE type = ?').get(i.type);
    if (!existing) {
      db.prepare(`
        INSERT OR IGNORE INTO integrations (id, name, type, environment, enabled, config_json, created_at, updated_at)
        VALUES (?, ?, ?, 'production', 1, ?, ?, ?)
      `).run(uuidv4(), i.name, i.type, i.config_json, now, now);
    } else {
      // Always sync config so base_url / device_ids stay current
      db.prepare('UPDATE integrations SET config_json=?, enabled=1, environment=\'production\', updated_at=? WHERE id=?')
        .run(i.config_json, now, existing.id);
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

// Call number: CALL-NNNN
function nextCallNumber(db) {
  const row = db.prepare("SELECT call_number FROM nexus_calls ORDER BY call_number DESC LIMIT 1").get();
  if (!row) return 'CALL-0001';
  const num = parseInt(row.call_number.replace('CALL-', ''), 10);
  return 'CALL-' + String(num + 1).padStart(4, '0');
}

module.exports = { getDb, initializeDatabase, nextTicketNumber, nextCallNumber, purgeExpiredSessions };
