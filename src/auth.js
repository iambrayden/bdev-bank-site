// Username / password login with server-side sessions.
const express = require('express');
const store = require('./store');
const perms = require('./perms');
const { wrap } = require('./web');

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE = 'audit_sid';

function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function setCookie(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

// Throttle by IP and by username.
const attempts = new Map();
function throttled(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now();
}
function fail(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n++;
  if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 5 * 60 * 1000 });
  attempts.set(key, a);
}

const router = express.Router();

router.get('/login', (req, res) => res.render('login', { error: null, username: '' }));

router.post(
  '/login',
  wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const keys = [`ip:${req.ip}`, `u:${username.toLowerCase()}`];
    if (keys.some(throttled)) return res.status(429).render('login', { error: 'Too many attempts. Try again in a few minutes.', username });
    const user = store.getUserByName(username);
    const ok = user && store.verifyPassword(password, user.password_hash);
    if (!ok || user.disabled) {
      keys.forEach(fail);
      store.log(user || { username }, 'auth.login_failed', username, user?.disabled ? 'account disabled' : '', req.ip);
      return res.status(401).render('login', { error: user?.disabled && ok ? 'This account is disabled.' : 'Wrong username or password.', username });
    }
    keys.forEach((k) => attempts.delete(k));
    const token = store.createSession(user.id, SESSION_HOURS, req.ip, req.get('user-agent'));
    store.log(user, 'auth.login', '', '', req.ip);
    setCookie(req, res, token, SESSION_HOURS * 3600);
    res.redirect(user.must_change_password ? '/account' : '/');
  })
);

router.post('/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  const u = store.sessionUser(token);
  store.destroySession(token);
  if (u) store.log(u, 'auth.logout', '', '', req.ip);
  setCookie(req, res, '', 0);
  res.redirect('/login');
});

// Loads req.user / req.perms, or sends the visitor to /login.
function requireUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  const user = store.sessionUser(token);
  if (!user) {
    if (req.method === 'GET') return res.redirect('/login');
    return res.status(401).send('Unauthorized');
  }
  req.user = user;
  req.sessionToken = token;
  req.perms = perms.effective(user);
  if (user.must_change_password && !['/account', '/account/password', '/logout'].includes(req.path)) return res.redirect('/account');
  next();
}

module.exports = { router, requireUser };
