'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { getDb, initializeDatabase } = require('./database');

// Initialize DB on startup
initializeDatabase();

const app = express();

// Trust proxy (Railway, Vercel)
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Static files
app.use('/public', express.static(path.join(__dirname, '../public')));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// SQLite-backed session store
class DbSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE id = ?').get(sid);
      if (!row) return cb(null, null);
      if (new Date(row.expires_at) < new Date()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const db = getDb();
      const expires = new Date(Date.now() + (sess.cookie?.maxAge || 86400000)).toISOString();
      db.prepare('INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

app.use(session({
  store: new DbSessionStore(),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'tsp.sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Flash messages via session
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || {};
  delete req.session.flash;
  next();
});

// CSRF middleware (after session)
const { csrfMiddleware } = require('./middleware/csrf');
app.use(csrfMiddleware);

// Routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const ticketRoutes = require('./routes/tickets');
const timeRoutes = require('./routes/timetracking');
const notifRoutes = require('./routes/notifications');
const reportsRoutes = require('./routes/reports');
const aiRoutes = require('./routes/ai');
const integrationRoutes = require('./routes/integrations');
const syncRoutes = require('./routes/sync');

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/tickets', ticketRoutes);
app.use('/notifications', notifRoutes);
app.use('/reports', reportsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/integrations', integrationRoutes);
app.use('/sync', syncRoutes);

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 Not Found',
    message: `The page ${req.path} was not found.`,
    user: req.session && req.session.user,
    unreadCount: 0
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.',
    user: req.session && req.session.user,
    unreadCount: 0
  });
});

// Local dev server
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Tech Service Portal running on http://localhost:${PORT}`));
}

module.exports = app;
