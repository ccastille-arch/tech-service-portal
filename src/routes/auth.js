'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { logAudit, AUDIT_ACTIONS, getClientIp } = require('../services/audit');
const router = express.Router();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES    = 15;

router.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Tech Service Portal — Login', error: null, csrfToken: res.locals.csrfToken });
});

router.post('/login', (req, res, next) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  const ip = getClientIp(req);

  if (!username || !password) {
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Username and password required.', csrfToken: res.locals.csrfToken });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);

  if (!user) {
    logAudit(db, { action: AUDIT_ACTIONS.LOGIN_FAILED, new_value: username, ip });
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Invalid username or password.', csrfToken: res.locals.csrfToken });
  }

  // Check lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_LOCKED, ip });
    return res.render('login', { title: 'Tech Service Portal — Login', error: `Account locked. Try again in ${mins} minute(s).`, csrfToken: res.locals.csrfToken });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const attempts = (user.login_attempts || 0) + 1;
    const now = new Date().toISOString();
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET login_attempts=?, locked_until=?, updated_at=? WHERE id=?').run(attempts, lockedUntil, now, user.id);
      logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_LOCKED, ip, meta: { attempts } });
      return res.render('login', { title: 'Tech Service Portal — Login', error: `Account locked for ${LOCKOUT_MINUTES} minutes after too many failed attempts.`, csrfToken: res.locals.csrfToken });
    }
    db.prepare('UPDATE users SET login_attempts=?, updated_at=? WHERE id=?').run(attempts, now, user.id);
    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_FAILED, ip, meta: { attempts } });
    return res.render('login', { title: 'Tech Service Portal — Login', error: `Invalid username or password. ${MAX_LOGIN_ATTEMPTS - attempts} attempt(s) remaining.`, csrfToken: res.locals.csrfToken });
  }

  // Successful login — reset lockout counters
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET login_attempts=0, locked_until=NULL, last_login_at=?, updated_at=? WHERE id=?').run(now, now, user.id);

  const userData = { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role };
  const returnTo = req.session.returnTo || '/dashboard';

  // Session fixation fix — regenerate session ID before setting user data
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user  = userData;
    req.session.flash = { success: `Welcome back, ${user.name.split(' ')[0]}!` };
    logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGIN_SUCCESS, ip });
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(returnTo);
    });
  });
});

router.get('/logout', (req, res) => {
  const db = getDb();
  const user = req.session?.user;
  if (user) logAudit(db, { actor_id: user.id, actor_name: user.name, action: AUDIT_ACTIONS.LOGOUT, ip: getClientIp(req) });
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
