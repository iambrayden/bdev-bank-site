const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const fmt = require('./format');
const web = require('./web');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'SAFIN';
const APP_TAGLINE = process.env.APP_TAGLINE ?? 'San Andreas Financial Intelligence Network';
const BANNER_TEXT = process.env.BANNER_TEXT ?? 'Restricted · Authorized use only · All activity is monitored and logged';

store.init();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.locals.fmt = fmt;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.th = config.get().thresholds;
  res.locals.appName = APP_NAME;
  res.locals.appTagline = APP_TAGLINE;
  res.locals.bannerText = BANNER_TEXT;
  res.locals.user = null;
  res.locals.can = () => false;
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Reject cross-site form posts (SameSite=Lax cookies already block most of these).
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).send('Bad origin');
    } catch {
      return res.status(403).send('Bad origin');
    }
  }
  next();
});

app.use(auth.router);
app.use(auth.requireUser, web.locals);

// Old URLs: "characters" are now "citizens".
app.get(['/players', '/players/*'], (req, res) => res.redirect(301, req.originalUrl.replace(/^\/players/, '/citizens')));
app.use('/', require('./routes/data').router);
app.use('/cases', require('./routes/cases').router);
const { admin, account } = require('./routes/admin');
app.use('/admin', admin);
app.use('/account', account);
app.get('/settings', (req, res) => res.redirect('/admin/settings'));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const setup = /not configured|ECONNREFUSED|ER_ACCESS_DENIED|ENOTFOUND|ETIMEDOUT|ER_BAD_DB|ER_NO_SUCH_TABLE/.test(err.code || err.message);
  res.status(500).render('error', { message: err.message, setup });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`${APP_NAME} listening on :${PORT}`));
}

module.exports = app;
