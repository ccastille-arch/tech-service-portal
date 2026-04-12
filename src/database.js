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

    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_time_entries_ticket ON time_entries(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_integration_logs_integration ON integration_logs(integration_id, timestamp);
  `);

  seedUsers(db);
  seedIntegrations(db);
}

function seedUsers(db) {
  const now = new Date().toISOString();
  const adminPw = process.env.ADMIN_PASSWORD || 'Brayden25!';
  const users = [
    { username: 'cody', email: 'cody@localhost', name: 'Cody Castille', role: 'admin', password: adminPw },
    { username: 'austin.whitehurst', email: 'austin.whitehurst@techservices.local', name: 'Austin Whitehurst', role: 'tech', password: 'AustinTech#2025' },
    { username: 'clint.webb', email: 'clint.webb@techservices.local', name: 'Clint Webb', role: 'tech', password: 'ClintTech#2025' }
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, email, password_hash, name, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const u of users) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    if (!existing) {
      const hash = bcrypt.hashSync(u.password, 12);
      insert.run(uuidv4(), u.username, u.email, hash, u.name, u.role, now, now);
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
