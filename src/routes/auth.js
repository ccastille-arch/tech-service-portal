'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDb } = require('../database');
const { logAudit, actorFromReq, AUDIT_ACTIONS } = require('../services/audit');
const { sanitizeString } = require('../middleware/validate');
const router = express.Router();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES    = 15;

router.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Tech Service Portal — Login', error: null, csrfToken: res.locals.csrfToken });
});

router.post('/login', (req, res, next) => {
  const username = sanitizeString(req.body.username, 100);
  const password  = req.body.password ? String(req.body.password) : null;

  if (!username || !password) {
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Username and password required.', csrfToken: res.locals.csrfToken });
  }

  const db  = getDb();
  const ip  = (req.ip || '').substring(0, 100);
  const ua  = (req.headers['user-agent'] || '').substring(0, 200);
  const key = username.toLowerCase();

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(key, key);

  if (!user) {
    logAudit(db, { action: AUDIT_ACTIONS.LOGIN_FAILED, resource_type: 'user', new_value: `unknown: ${key}`, ip, user_agent: ua });
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Invalid username or password.', csrfToken: res.locals.csrfToken });
  }

  // Account lockout check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_FAILED, resource_type: 'user', resource_id: user.id, new_value: 'blocked — account locked', ip, user_agent: ua });
    return res.render('login', { title: 'Tech Service Portal — Login', error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`, csrfToken: res.locals.csrfToken });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const attempts = (user.login_attempts || 0) + 1;
    const now = new Date().toISOString();
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
      db.prepare('UPDATE users SET login_attempts=?, locked_until=?, updated_at=? WHERE id=?').run(attempts, lockedUntil, now, user.id);
      logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.ACCOUNT_LOCKED, resource_type: 'user', resource_id: user.id, new_value: `locked ${LOCKOUT_MINUTES}m after ${attempts} attempts`, ip, user_agent: ua });
      return res.render('login', { title: 'Tech Service Portal — Login', error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`, csrfToken: res.locals.csrfToken });
    }
    db.prepare('UPDATE users SET login_attempts=?, updated_at=? WHERE id=?').run(attempts, now, user.id);
    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_FAILED, resource_type: 'user', resource_id: user.id, new_value: `attempt ${attempts}/${MAX_LOGIN_ATTEMPTS}`, ip, user_agent: ua });
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Invalid username or password.', csrfToken: res.locals.csrfToken });
  }

  // Success — reset lockout counters
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET login_attempts=0, locked_until=NULL, last_login_at=?, updated_at=? WHERE id=?').run(now, now, user.id);

  // FIX: Regenerate session ID on login to prevent session fixation attacks
  const userData   = { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role };
  const returnTo   = req.session.returnTo || '/dashboard';
  const firstName  = user.name.split(' ')[0];

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user  = userData;
    req.session.flash = { success: `Welcome back, ${firstName}!` };

    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_SUCCESS, resource_type: 'user', resource_id: user.id, ip, user_agent: ua });

    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(returnTo);
    });
  });
});

router.get('/logout', (req, res) => {
  const db = getDb();
  if (req.session?.user) {
    logAudit(db, { ...actorFromReq(req), action: AUDIT_ACTIONS.LOGOUT, resource_type: 'user', resource_id: req.session.user.id });
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
