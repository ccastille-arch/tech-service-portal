'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getDb, initializeDatabase } = require('./database');
const { validateSecretsOnStartup, getSecret } = require('./services/secrets');

// Validate secrets before anything else
validateSecretsOnStartup();

// Initialize DB on startup
initializeDatabase();

const app = express();

// Trust proxy (Railway, Vercel)
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Static files — CSS/JS/img served openly; uploads are served via /tickets/files/:id (auth-gated)
app.use('/public/css', express.static(path.join(__dirname, '../public/css')));
app.use('/public/js',  express.static(path.join(__dirname, '../public/js')));
app.use('/public/img', express.static(path.join(__dirname, '../public/img')));

// Body parsing — tight limits
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));

// SQLite-backed session store
class DbSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const db  = getDb();
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
      const db      = getDb();
      const expires = new Date(Date.now() + (sess.cookie?.maxAge || 86400000)).toISOString();
      db.prepare('INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

app.use(session({
  store: new DbSessionStore(),
  secret: getSecret('SESSION_SECRET', 'dev-secret-change-me'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'tsp.sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Rate limiting
const limiter      = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const nexusLimiter = rateLimit({ windowMs:  1 * 60 * 1000, max: 30,  standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// Flash messages
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || {};
  delete req.session.flash;
  next();
});

// SSO token auto-login
app.use((req, res, next) => {
  const token = req.query.sso_token;
  if (!token) return next();
  try {
    const jwt     = require('jsonwebtoken');
    const secret  = getSecret('SESSION_SECRET', 'dev-secret-change-me');
    const payload = jwt.verify(token, secret);
    req.session.user = {
      id:       payload.sub,
      username: payload.username || payload.email?.split('@')[0] || 'user',
      name:     payload.name,
      email:    payload.email,
      role:     payload.role || 'tech'
    };
    const clean = req.path + (Object.keys(req.query).filter(k => k !== 'sso_token').length
      ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'sso_token'))).toString()
      : '');
    return req.session.save(() => res.redirect(clean || '/dashboard'));
  } catch (_) { return next(); }
});

// Analytics
const { analyticsMiddleware } = require('./middleware/analytics');
app.use(analyticsMiddleware);

// Voice webhooks — exempt from CSRF (Twilio posts without tokens)
const voiceRoutes = require('./routes/voice');
app.use('/voice', voiceRoutes);

// CSRF middleware (after session, after voice routes)
const { csrfMiddleware } = require('./middleware/csrf');
app.use(csrfMiddleware);

// Routes
const authRoutes        = require('./routes/auth');
const dashboardRoutes   = require('./routes/dashboard');
const ticketRoutes      = require('./routes/tickets');
const notifRoutes       = require('./routes/notifications');
const reportsRoutes     = require('./routes/reports');
const aiRoutes          = require('./routes/ai');
const integrationRoutes = require('./routes/integrations');
const syncRoutes        = require('./routes/sync');
const fleetRoutes       = require('./routes/fleet');
const adminRoutes       = require('./routes/admin');
const communityRoutes   = require('./routes/community');
const nexusCallsRoutes  = require('./routes/nexus-calls');

const { requireAdmin: _requireAdmin } = require('./middleware/authenticate');

app.use('/login',              authLimiter);
app.use('/admin',              adminLimiter);
app.use('/nexus/calls/create', nexusLimiter);

app.use('/',             authRoutes);
app.use('/',             dashboardRoutes);
app.use('/tickets',      ticketRoutes);       // /tickets/files/:id is secure file serving
app.use('/notifications', notifRoutes);
app.use('/reports',      _requireAdmin, reportsRoutes);
app.use('/api/reports',  _requireAdmin, reportsRoutes);
app.use('/api/ai',       aiRoutes);
app.use('/integrations', integrationRoutes);
app.use('/sync',         syncRoutes);
app.use('/fleet',        fleetRoutes);
app.use('/nexus',        nexusCallsRoutes);
app.use('/calls',        voiceRoutes);
app.use('/admin',        adminRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/',             communityRoutes);

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

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Tech Service Portal running on http://localhost:${PORT}`));
}

module.exports = app;
