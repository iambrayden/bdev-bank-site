const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const { ROLES } = require('./roles');
const fmt = require('./format');

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('bank-audit:' + APP_PASSWORD).digest('hex');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

if (!APP_PASSWORD && !ALLOW_NO_AUTH) {
  console.error('APP_PASSWORD is not set. Set it (or ALLOW_NO_AUTH=true for local use only).');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.locals.fmt = fmt;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.authEnabled = !!APP_PASSWORD;
  res.locals.th = config.get().thresholds;
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- auth: one shared password, HMAC-signed session cookie ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function validSession(req) {
  const c = readCookie(req, 'audit_session');
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

const attempts = new Map();
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).render('login', { error: 'Too many attempts. Try again in a few minutes.' });
  const given = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const want = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!APP_PASSWORD || !crypto.timingSafeEqual(given, want)) {
    a.n++;
    if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 5 * 60 * 1000 });
    attempts.set(ip, a);
    return res.status(401).render('login', { error: 'Wrong password.' });
  }
  attempts.delete(ip);
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `audit_session=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  res.set('Set-Cookie', 'audit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (validSession(req)) return next();
  if (req.method === 'GET') return res.redirect('/login');
  res.status(401).send('Unauthorized');
});

// SameSite=Lax blocks cross-site POSTs with the cookie; also check Origin when present.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return res.status(403).send('Bad origin');
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function snap(req) {
  return audit.snapshot(req.query.refresh === '1');
}

// ---------- helpers ----------
function paginate(list, req, per = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pages = Math.max(1, Math.ceil(list.length / per));
  return { items: list.slice((page - 1) * per, page * per), page: Math.min(page, pages), pages, total: list.length };
}

function csv(res, filename, header, rows) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([header, ...rows].map((r) => r.map(esc).join(',')).join('\n'));
}

function filterTx(s, q) {
  const text = String(q.q || '').toLowerCase().trim();
  const min = q.min ? Number(q.min) : null;
  const max = q.max ? Number(q.max) : null;
  const from = q.from ? Date.parse(q.from) / 1000 : null;
  const to = q.to ? Date.parse(q.to) / 1000 + 86400 : null;
  return s.allTx.filter((t) => {
    if (q.type && !t.type.startsWith(q.type)) return false;
    if (q.scope && t.accountType !== q.scope) return false;
    if (q.account && t.account !== q.account) return false;
    if (min !== null && t.amount < min) return false;
    if (max !== null && t.amount > max) return false;
    if (from && t.time < from) return false;
    if (to && t.time >= to) return false;
    if (text) {
      const owner = t.accountType === 'personal' ? s.playerMap.get(t.account)?.name || '' : '';
      const hay = `${t.account} ${owner} ${t.title} ${t.issuer} ${t.receiver} ${t.message} ${t.trans_id}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

function playerSort(list, sort) {
  const by = {
    total: (a, b) => b.cash + b.bank - (a.cash + a.bank),
    bank: (a, b) => b.bank - a.bank,
    cash: (a, b) => b.cash - a.cash,
    name: (a, b) => a.name.localeCompare(b.name),
    activity: (a, b) => b.lastTx - a.lastTx,
    updated: (a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)),
  };
  return [...list].sort(by[sort] || by.total);
}

// ---------- pages ----------
app.get(
  '/',
  wrap(async (req, res) => {
    const s = await snap(req);
    const th = config.get().thresholds;
    const totals = s.players.reduce((t, p) => ({ cash: t.cash + p.cash, bank: t.bank + p.bank, crypto: t.crypto + p.crypto }), { cash: 0, bank: 0, crypto: 0 });
    const accountTotal = s.accounts.reduce((t, a) => t + a.amount, 0);
    const sev = { high: 0, medium: 0, low: 0, info: 0 };
    for (const f of s.flags) sev[f.severity]++;

    // Daily personal-account flow, last 14 days
    const days = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      days.push({ key: d.toISOString().slice(0, 10), start: d.getTime() / 1000, in: 0, out: 0, n: 0 });
    }
    for (const t of s.allTx) {
      if (t.accountType !== 'personal') continue;
      const d = days.find((x) => t.time >= x.start && t.time < x.start + 86400);
      if (!d) continue;
      d.n++;
      if (t.signed >= 0) d.in += t.amount;
      else d.out += t.amount;
    }
    const jobs = new Map();
    for (const p of s.players) {
      const k = p.job?.label || p.job?.name || 'unemployed';
      const j = jobs.get(k) || { name: k, n: 0, money: 0 };
      j.n++;
      j.money += p.cash + p.bank;
      jobs.set(k, j);
    }
    res.render('dashboard', {
      s,
      th,
      totals,
      accountTotal,
      sev,
      days,
      richest: playerSort(s.players, 'total').slice(0, 10),
      bigTx: s.allTx.filter((t) => t.amount >= th.largeTransaction).slice(0, 15),
      topAccounts: [...s.accounts].sort((a, b) => b.amount - a.amount).slice(0, 8),
      jobs: [...jobs.values()].sort((a, b) => b.money - a.money).slice(0, 12),
      flags: s.flags.filter((f) => f.severity === 'high').slice(0, 10),
    });
  })
);

app.get(
  '/players',
  wrap(async (req, res) => {
    const s = await snap(req);
    const q = String(req.query.q || '').toLowerCase().trim();
    let list = s.players;
    if (q) list = list.filter((p) => `${p.name} ${p.citizenid} ${p.account} ${p.license} ${p.job?.label || ''} ${p.job?.name || ''} ${p.phone} ${p.groups.map((g) => g.group).join(' ')}`.toLowerCase().includes(q));
    if (req.query.job) list = list.filter((p) => p.job?.name === req.query.job || p.groups.some((g) => g.group === req.query.job));
    list = playerSort(list, req.query.sort);
    if (req.query.format === 'csv') {
      return csv(res, 'players.csv', ['citizenid', 'name', 'account', 'license', 'job', 'grade', 'cash', 'bank', 'crypto', 'transactions', 'last_updated'], list.map((p) => [p.citizenid, p.name, p.account, p.license, p.job?.name, p.job?.grade, p.cash, p.bank, p.crypto, p.txCount, p.lastUpdated]));
    }
    const flagCount = new Map();
    for (const f of s.flags) if (f.citizenid && f.severity !== 'info') flagCount.set(f.citizenid, (flagCount.get(f.citizenid) || 0) + 1);
    res.render('players', { s, pg: paginate(list, req), flagCount });
  })
);

app.get(
  '/players/:cid',
  wrap(async (req, res) => {
    const s = await snap(req);
    const cid = req.params.cid;
    const p = s.playerMap.get(cid);
    const tx = s.txByAccount.get(`personal:${cid}`) || [];
    const linked = await audit.linkedRows(cid);
    if (!p && !tx.length && !linked.some((l) => l.rows.length)) return res.status(404).render('error', { message: `No character with citizenid ${cid}` });
    const accounts = s.accounts.filter((a) => a.auth.includes(cid) || a.creator === cid);
    const alts = p && p.license ? s.players.filter((o) => o.license === p.license && o.citizenid !== cid) : [];
    const flags = s.flags.filter((f) => f.citizenid === cid || (f.accountType === 'personal' && f.account === cid));
    // Who this character sends money to / receives from
    const counterparties = new Map();
    for (const t of tx) {
      const other = t.signed < 0 ? t.receiver : t.issuer;
      if (!other || (p && other.toLowerCase() === p.name.toLowerCase())) continue;
      const c = counterparties.get(other) || { name: other, cid: audit.cidForName(s, other), sent: 0, received: 0, n: 0 };
      c.n++;
      if (t.signed < 0) c.sent += t.amount;
      else c.received += t.amount;
      counterparties.set(other, c);
    }
    const inflow = tx.filter((t) => t.signed > 0).reduce((a, t) => a + t.amount, 0);
    const outflow = tx.filter((t) => t.signed < 0).reduce((a, t) => a + t.amount, 0);
    res.render('player', {
      s,
      cid,
      p,
      tx: paginate(tx, req, 200),
      inflow,
      outflow,
      linked,
      accounts,
      alts,
      flags,
      counterparties: [...counterparties.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received)).slice(0, 25),
      ROLES,
    });
  })
);

app.get(
  '/accounts',
  wrap(async (req, res) => {
    const s = await snap(req);
    const list = [...s.accounts].sort((a, b) => b.amount - a.amount);
    if (req.query.format === 'csv') return csv(res, 'accounts.csv', ['id', 'amount', 'transactions', 'frozen', 'creator', 'auth'], list.map((a) => [a.id, a.amount, a.txCount, a.frozen ? 1 : 0, a.creator, a.auth.join(' ')]));
    res.render('accounts', { s, list });
  })
);

app.get(
  '/accounts/:id',
  wrap(async (req, res) => {
    const s = await snap(req);
    const a = s.accounts.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).render('error', { message: `No account ${req.params.id}` });
    const tx = s.txByAccount.get(`shared:${a.id}`) || [];
    const members = s.players.filter((p) => p.job?.name === a.id || p.groups.some((g) => g.group === a.id));
    const flags = s.flags.filter((f) => f.accountType === 'shared' && f.account === a.id);
    res.render('account', { s, a, tx: paginate(tx, req, 200), members, flags });
  })
);

app.get(
  '/transactions',
  wrap(async (req, res) => {
    const s = await snap(req);
    const list = filterTx(s, req.query);
    if (req.query.format === 'csv') {
      return csv(res, 'transactions.csv', ['time', 'account_type', 'account', 'owner', 'type', 'amount', 'title', 'issuer', 'receiver', 'message', 'trans_id'], list.map((t) => [fmt.date(t.time), t.accountType, t.account, t.accountType === 'personal' ? s.playerMap.get(t.account)?.name : '', t.type, t.amount, t.title, t.issuer, t.receiver, t.message, t.trans_id]));
    }
    const sum = list.reduce((a, t) => ({ in: a.in + (t.signed > 0 ? t.amount : 0), out: a.out + (t.signed < 0 ? t.amount : 0) }), { in: 0, out: 0 });
    res.render('transactions', { s, pg: paginate(list, req), sum });
  })
);

app.get(
  '/audit',
  wrap(async (req, res) => {
    const s = await snap(req);
    let list = s.flags;
    if (req.query.severity) list = list.filter((f) => f.severity === req.query.severity);
    if (req.query.code) list = list.filter((f) => f.code === req.query.code);
    if (req.query.format === 'csv') {
      return csv(res, 'audit.csv', ['severity', 'code', 'title', 'detail', 'citizenid', 'account', 'amount', 'time', 'trans_id'], list.map((f) => [f.severity, f.code, f.title, f.detail, f.citizenid, f.account, f.amount, f.time ? fmt.date(f.time) : '', f.trans_id]));
    }
    const codes = [...new Set(s.flags.map((f) => f.code))].sort();
    res.render('audit', { s, pg: paginate(list, req), codes, th: config.get().thresholds });
  })
);

app.get(
  '/tables',
  wrap(async (req, res) => {
    const all = await db.listTables();
    const configured = config.allTables();
    const exists = new Set(all.map((t) => t.name));
    const counts = {};
    for (const t of configured) {
      if (!exists.has(t.name)) continue;
      const [r] = await db.query(`SELECT COUNT(*) AS n FROM ${db.id(t.name)}`);
      counts[t.name] = r.n;
    }
    res.render('tables', { configured, exists, counts, ROLES });
  })
);

app.get(
  '/tables/:name',
  wrap(async (req, res) => {
    const t = config.allTables().find((x) => x.name === req.params.name);
    if (!t) return res.status(404).render('error', { message: 'Only tables listed in Settings can be browsed.' });
    const cols = await db.columnsOf(t.name);
    if (!cols.size) return res.status(404).render('error', { message: `Table ${t.name} does not exist in the database.` });
    const per = 100;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q = String(req.query.q || '').trim();
    let where = '';
    const params = [];
    if (q) {
      where = 'WHERE ' + cols.ordered.map((c) => `CAST(${db.id(c)} AS CHAR) LIKE ?`).join(' OR ');
      for (let i = 0; i < cols.size; i++) params.push(`%${q}%`);
    }
    const sort = cols.has(req.query.sort) ? req.query.sort : cols.ordered[0];
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${db.id(t.name)} ${where}`, params);
    const rows = await db.query(`SELECT * FROM ${db.id(t.name)} ${where} ORDER BY ${db.id(sort)} ${dir} LIMIT ? OFFSET ?`, [...params, per, (page - 1) * per]);
    if (req.query.format === 'csv') {
      const all = await db.query(`SELECT * FROM ${db.id(t.name)} ${where} ORDER BY ${db.id(sort)} ${dir} LIMIT 50000`, params);
      return csv(res, `${t.name}.csv`, cols.ordered, all.map((r) => cols.ordered.map((c) => fmt.cell(r[c]))));
    }
    const c = await audit.resolveCols(t);
    const linkCols = ['citizenid', 'owner', 'creator'].map((k) => c[k]).filter(Boolean);
    res.render('table', { t, columns: cols.ordered, rows, page, pages: Math.max(1, Math.ceil(n / per)), total: n, sort, dir, linkCols, role: ROLES[t.role] });
  })
);

// ---------- settings ----------
app.get(
  '/settings',
  wrap(async (req, res) => {
    let dbTables = [];
    let dbError = null;
    try {
      dbTables = await db.listTables();
    } catch (e) {
      dbError = e.message;
    }
    const cfg = config.get();
    res.render('settings', { cfg, ROLES, dbTables, dbError, msg: req.query.msg || null, configFile: config.CONFIG_FILE });
  })
);

app.post(
  '/settings/db',
  wrap(async (req, res) => {
    const b = req.body;
    const cur = config.get().db;
    const next = { host: b.host.trim(), port: Number(b.port) || 3306, user: b.user.trim(), database: b.database.trim(), password: b.password ? b.password : cur.password };
    if (b.action === 'test') {
      try {
        const r = await db.testConnection(next);
        const warn = r.canWrite ? ' ⚠ This user has write privileges — a read-only user is recommended.' : ' User is read-only.';
        return res.redirect('/settings?msg=' + encodeURIComponent(`Connected: ${r.user} on ${r.database} (${r.version}).${warn}`));
      } catch (e) {
        return res.redirect('/settings?msg=' + encodeURIComponent('Connection failed: ' + e.message));
      }
    }
    config.save({ db: next });
    audit.invalidate();
    db.clearSchemaCache();
    res.redirect('/settings?msg=' + encodeURIComponent('Database settings saved.'));
  })
);

function parseColumns(raw, where) {
  if (!raw || !raw.trim()) return undefined;
  const obj = JSON.parse(raw);
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${where}: column overrides must be a JSON object`);
  return obj;
}

app.post(
  '/settings/tables',
  wrap(async (req, res) => {
    const b = req.body;
    const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const names = arr(b['name']);
    const roles = arr(b['role']);
    const cols = arr(b['columns']);
    const removes = new Set(arr(b['remove']));
    try {
      const core = { name: (b.core_name || 'players').trim(), role: 'players', columns: parseColumns(b.core_columns, 'players') };
      const tables = [];
      names.forEach((n, i) => {
        const name = String(n || '').trim();
        if (!name || removes.has(String(i))) return;
        if (!/^[A-Za-z0-9_$-]{1,64}$/.test(name)) throw new Error(`Invalid table name: ${name}`);
        const role = ROLES[roles[i]] && roles[i] !== 'players' ? roles[i] : 'generic';
        tables.push({ name, role, columns: parseColumns(cols[i], name) });
      });
      for (const n of arr(b.add)) {
        if (n && !tables.some((t) => t.name === n) && n !== core.name) tables.push({ name: n, role: 'generic' });
      }
      config.save({ core, tables });
    } catch (e) {
      return res.redirect('/settings?msg=' + encodeURIComponent('Not saved: ' + e.message));
    }
    audit.invalidate();
    db.clearSchemaCache();
    res.redirect('/settings?msg=' + encodeURIComponent('Tables saved.'));
  })
);

app.post(
  '/settings/thresholds',
  wrap(async (req, res) => {
    const th = {};
    for (const k of Object.keys(config.DEFAULT_THRESHOLDS)) {
      const v = Number(req.body[k]);
      th[k] = Number.isFinite(v) && v > 0 ? v : config.DEFAULT_THRESHOLDS[k];
    }
    config.save({ thresholds: th });
    audit.invalidate();
    res.redirect('/settings?msg=' + encodeURIComponent('Thresholds saved.'));
  })
);

app.post('/settings/reset', (req, res) => {
  config.resetToEnv();
  audit.invalidate();
  db.clearSchemaCache();
  res.redirect('/settings?msg=' + encodeURIComponent('Settings reset to environment defaults.'));
});

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const setup = /not configured|ECONNREFUSED|ER_ACCESS_DENIED|ENOTFOUND|ETIMEDOUT|ER_BAD_DB|ER_NO_SUCH_TABLE/.test(err.code || err.message);
  res.status(500).render('error', { message: err.message, setup });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Bank audit listening on :${PORT}`));
}

module.exports = app;
