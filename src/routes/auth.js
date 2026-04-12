'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const router = express.Router();

router.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Tech Service Portal — Login', error: null, csrfToken: res.locals.csrfToken });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Username and password required.', csrfToken: res.locals.csrfToken });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username.toLowerCase(), username.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { title: 'Tech Service Portal — Login', error: 'Invalid username or password.', csrfToken: res.locals.csrfToken });
  }

  req.session.user = { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role };
  req.session.flash = { success: `Welcome back, ${user.name.split(' ')[0]}!` };
  const returnTo = req.session.returnTo || '/dashboard';
  delete req.session.returnTo;
  res.redirect(returnTo);
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
