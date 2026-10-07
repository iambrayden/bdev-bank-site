// Economy pages: overview, citizens, accounts, transactions, audit flags, raw tables.
const express = require('express');
const config = require('../config');
const db = require('../db');
const audit = require('../audit');
const store = require('../store');
const fmt = require('../format');
const { ROLES } = require('../roles');
const { summarize } = require('../citizen');
const { wrap, need, can, paginate, csv, tableAllowed, MASK, redactText } = require('../web');

const router = express.Router();

async function snap(req) {
  return audit.snapshot(req.query.refresh === '1' && can(req, 'data.refresh'));
}

function filterTx(s, q, canMoney) {
  const text = String(q.q || '').toLowerCase().trim();
  const min = q.min && canMoney ? Number(q.min) : null;
  const max = q.max && canMoney ? Number(q.max) : null;
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

function playerSort(list, sort, canMoney) {
  const by = {
    total: (a, b) => b.bank - a.bank,
    bank: (a, b) => b.bank - a.bank,
    name: (a, b) => a.name.localeCompare(b.name),
    activity: (a, b) => b.lastTx - a.lastTx,
    updated: (a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)),
  };
  if (!canMoney && ['total', 'bank', undefined].includes(sort)) sort = 'name';
  return [...list].sort(by[sort] || by.total);
}

// Civilian cash is never shown: remove it from the players table's money JSON.
function stripCash(t, c, rows) {
  if (t.role !== 'players' || !c.money) return;
  for (const r of rows) {
    const m = audit.parseJson(r[c.money], null);
    if (m && typeof m === 'object' && 'cash' in m) {
      delete m.cash;
      r[c.money] = JSON.stringify(m);
    }
  }
}

// First page this user may open; used as the landing page.
function homeFor(req) {
  const order = [
    ['dashboard.view', '/'],
    ['players.view', '/citizens'],
    ['cases.view', '/cases'],
    ['cases.view_all', '/cases'],
    ['transactions.view', '/transactions'],
    ['accounts.view', '/accounts'],
    ['audit.view', '/audit'],
    ['admin.users', '/admin/users'],
    ['admin.settings', '/admin/settings'],
  ];
  return order.find(([p]) => can(req, p))?.[1] || '/account';
}

router.get(
  '/',
  wrap(async (req, res) => {
    if (!can(req, 'dashboard.view')) return res.redirect(homeFor(req));
    const s = await snap(req);
    const th = config.get().thresholds;
    const totals = s.players.reduce((t, p) => ({ bank: t.bank + p.bank, crypto: t.crypto + p.crypto }), { bank: 0, crypto: 0 });
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
      j.money += p.bank;
      jobs.set(k, j);
    }
    const canMoney = can(req, 'money.view');
    res.render('dashboard', {
      s,
      th,
      totals,
      accountTotal,
      sev,
      days,
      richest: playerSort(s.players, canMoney ? 'total' : 'activity', canMoney).slice(0, 10),
      bigTx: s.allTx.filter((t) => t.amount >= th.largeTransaction).slice(0, 15),
      topAccounts: [...s.accounts].sort((a, b) => b.amount - a.amount).slice(0, 8),
      jobs: [...jobs.values()].sort((a, b) => b.money - a.money).slice(0, 12),
      flags: s.flags.filter((f) => f.severity === 'high').slice(0, 10),
      myCases: can(req, 'cases.view') || can(req, 'cases.view_all') ? store.listCases({ userId: req.user.id, viewAll: false, status: 'active' }).slice(0, 8) : [],
    });
  })
);

router.get(
  '/citizens',
  need('players.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    const canMoney = can(req, 'money.view');
    const canId = can(req, 'players.identity');
    const canPersonal = can(req, 'players.personal');
    const q = String(req.query.q || '').toLowerCase().trim();
    let list = s.players;
    if (q) {
      list = list.filter((p) =>
        [p.name, p.citizenid, p.job?.label, p.job?.name, ...p.groups.map((g) => g.group), canId && p.account, canId && p.license, canPersonal && p.phone].filter(Boolean).join(' ').toLowerCase().includes(q)
      );
    }
    if (req.query.job) list = list.filter((p) => p.job?.name === req.query.job || p.groups.some((g) => g.group === req.query.job));
    list = playerSort(list, req.query.sort, canMoney);
    if (req.query.format === 'csv') {
      if (!can(req, 'export.csv')) return res.status(403).render('error', { message: 'You do not have permission to export.' });
      const m = (v) => (canMoney ? v : '');
      return csv(req, res, 'players.csv', ['citizenid', 'name', 'account', 'license', 'job', 'grade', 'bank', 'crypto', 'transactions', 'last_updated'], list.map((p) => [p.citizenid, p.name, canId ? p.account : '', canId ? p.license : '', p.job?.name, p.job?.grade, m(p.bank), m(p.crypto), p.txCount, p.lastUpdated]));
    }
    const flagCount = new Map();
    if (can(req, 'audit.view')) for (const f of s.flags) if (f.citizenid && f.severity !== 'info') flagCount.set(f.citizenid, (flagCount.get(f.citizenid) || 0) + 1);
    res.render('players', { s, pg: paginate(list, req), flagCount });
  })
);

router.get(
  '/citizens/:cid',
  need('players.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    const cid = req.params.cid;
    const p = s.playerMap.get(cid);
    const tx = s.txByAccount.get(`personal:${cid}`) || [];
    let linked = [];
    if (can(req, 'players.linked')) linked = (await audit.linkedRows(cid)).filter((sec) => tableAllowed(req, sec.table.name));
    if (!p && !tx.length && !linked.some((l) => l.rows.length)) return res.status(404).render('error', { message: `No citizen with citizenid ${cid}` });
    store.log(req.user, 'view.citizen', cid, p?.name || '', req.ip);
    const accounts = can(req, 'accounts.view') ? s.accounts.filter((a) => a.auth.includes(cid) || a.creator === cid) : [];
    const alts = can(req, 'players.identity') && p && p.license ? s.players.filter((o) => o.license === p.license && o.citizenid !== cid) : [];
    const flags = can(req, 'audit.view') ? s.flags.filter((f) => f.citizenid === cid || (f.accountType === 'personal' && f.account === cid)) : [];
    // Who this citizen sends money to / receives from
    const counterparties = new Map();
    if (can(req, 'transactions.view')) {
      for (const t of tx) {
        const other = t.signed < 0 ? t.receiver : t.issuer;
        if (!other || (p && other.toLowerCase() === p.name.toLowerCase())) continue;
        const c = counterparties.get(other) || { name: other, cid: audit.cidForName(s, other), sent: 0, received: 0, n: 0 };
        c.n++;
        if (t.signed < 0) c.sent += t.amount;
        else c.received += t.amount;
        counterparties.set(other, c);
      }
    }
    const inflow = tx.filter((t) => t.signed > 0).reduce((a, t) => a + t.amount, 0);
    const outflow = tx.filter((t) => t.signed < 0).reduce((a, t) => a + t.amount, 0);
    const cases = can(req, 'cases.view') || can(req, 'cases.view_all') ? store.casesForCitizen(cid, req.user.id, can(req, 'cases.view_all')) : [];
    const TABS = ['overview', 'transactions', 'assets', 'flags', 'cases', 'records'];
    const assets = summarize(cid, linked);
    res.render('player', {
      s,
      cid,
      p,
      tab: TABS.includes(req.query.tab) ? req.query.tab : 'overview',
      assets,
      allTx: can(req, 'transactions.view') ? tx : [],
      tx: paginate(can(req, 'transactions.view') ? tx : [], req, 100),
      inflow,
      outflow,
      linked,
      accounts,
      alts,
      flags,
      cases,
      counterparties: [...counterparties.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received)).slice(0, 25),
      ROLES,
    });
  })
);

router.get(
  '/accounts',
  need('accounts.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    const canMoney = can(req, 'money.view');
    const list = [...s.accounts].sort((a, b) => (canMoney ? b.amount - a.amount : a.id.localeCompare(b.id)));
    if (req.query.format === 'csv') {
      if (!can(req, 'export.csv')) return res.status(403).render('error', { message: 'You do not have permission to export.' });
      return csv(req, res, 'accounts.csv', ['id', 'amount', 'transactions', 'frozen', 'creator', 'auth'], list.map((a) => [a.id, canMoney ? a.amount : '', a.txCount, a.frozen ? 1 : 0, a.creator, a.auth.join(' ')]));
    }
    res.render('accounts', { s, list });
  })
);

router.get(
  '/accounts/:id',
  need('accounts.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    const a = s.accounts.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).render('error', { message: `No account ${req.params.id}` });
    store.log(req.user, 'view.account', a.id, '', req.ip);
    const tx = can(req, 'transactions.view') ? s.txByAccount.get(`shared:${a.id}`) || [] : [];
    const members = s.players.filter((p) => p.job?.name === a.id || p.groups.some((g) => g.group === a.id));
    const flags = can(req, 'audit.view') ? s.flags.filter((f) => f.accountType === 'shared' && f.account === a.id) : [];
    res.render('account', { s, a, tx: paginate(tx, req, 200), members, flags });
  })
);

router.get(
  '/transactions',
  need('transactions.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    const canMoney = can(req, 'money.view');
    const list = filterTx(s, req.query, canMoney);
    if (req.query.format === 'csv') {
      if (!can(req, 'export.csv')) return res.status(403).render('error', { message: 'You do not have permission to export.' });
      return csv(req, res, 'transactions.csv', ['time', 'account_type', 'account', 'owner', 'type', 'amount', 'title', 'issuer', 'receiver', 'message', 'trans_id'], list.map((t) => [fmt.date(t.time), t.accountType, t.account, t.accountType === 'personal' ? s.playerMap.get(t.account)?.name : '', t.type, canMoney ? t.amount : '', t.title, t.issuer, t.receiver, canMoney ? t.message : redactText(t.message), t.trans_id]));
    }
    const sum = list.reduce((a, t) => ({ in: a.in + (t.signed > 0 ? t.amount : 0), out: a.out + (t.signed < 0 ? t.amount : 0) }), { in: 0, out: 0 });
    res.render('transactions', { s, pg: paginate(list, req), sum });
  })
);

router.get(
  '/audit',
  need('audit.view'),
  wrap(async (req, res) => {
    const s = await snap(req);
    let list = s.flags;
    if (req.query.severity) list = list.filter((f) => f.severity === req.query.severity);
    if (req.query.code) list = list.filter((f) => f.code === req.query.code);
    if (req.query.format === 'csv') {
      if (!can(req, 'export.csv')) return res.status(403).render('error', { message: 'You do not have permission to export.' });
      const r = can(req, 'money.view') ? (x) => x : redactText;
      return csv(req, res, 'audit.csv', ['severity', 'code', 'title', 'detail', 'citizenid', 'account', 'amount', 'time', 'trans_id'], list.map((f) => [f.severity, f.code, r(f.title), r(f.detail), f.citizenid, f.account, can(req, 'money.view') ? f.amount : '', f.time ? fmt.date(f.time) : '', f.trans_id]));
    }
    const codes = [...new Set(s.flags.map((f) => f.code))].sort();
    res.render('audit', { s, pg: paginate(list, req), codes, th: config.get().thresholds });
  })
);

router.get(
  '/tables',
  need('tables.browse'),
  wrap(async (req, res) => {
    const all = await db.listTables();
    const configured = config.allTables().filter((t) => tableAllowed(req, t.name));
    const exists = new Set(all.map((t) => t.name));
    const counts = {};
    for (const t of configured) {
      if (!exists.has(t.name)) continue;
      const [r] = await db.query(`SELECT COUNT(*) AS n FROM ${db.id(t.name)}`);
      counts[t.name] = r.n;
    }
    res.render('tables', { configured, exists, counts, ROLES, coreName: config.get().core.name });
  })
);

router.get(
  '/tables/:name',
  need('tables.browse'),
  wrap(async (req, res) => {
    const t = config.allTables().find((x) => x.name === req.params.name);
    if (!t) return res.status(404).render('error', { message: 'Only tables listed in Settings can be browsed.' });
    if (!tableAllowed(req, t.name)) return res.status(403).render('error', { message: `Your role cannot view table ${t.name}.` });
    const cols = await db.columnsOf(t.name);
    if (!cols.size) return res.status(404).render('error', { message: `Table ${t.name} does not exist in the database.` });
    const per = 100;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q = String(req.query.q || '').trim();
    let where = '';
    const params = [];
    if (q) {
      const moneyCol = t.role === 'players' ? config.columnsFor(t).money : null;
      const searchCols = cols.ordered.filter((c) => c !== moneyCol);
      where = 'WHERE ' + searchCols.map((c) => `CAST(${db.id(c)} AS CHAR) LIKE ?`).join(' OR ');
      for (let i = 0; i < searchCols.length; i++) params.push(`%${q}%`);
    }
    const sort = cols.has(req.query.sort) && !(t.role === 'players' && req.query.sort === config.columnsFor(t).money) ? req.query.sort : cols.ordered[0];
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    store.log(req.user, 'view.table', t.name, q, req.ip);
    if (req.query.format === 'csv') {
      if (!can(req, 'export.csv')) return res.status(403).render('error', { message: 'You do not have permission to export.' });
      const all = await db.query(`SELECT * FROM ${db.id(t.name)} ${where} ORDER BY ${db.id(sort)} ${dir} LIMIT 50000`, params);
      stripCash(t, await audit.resolveCols(t), all);
      return csv(req, res, `${t.name}.csv`, cols.ordered, all.map((r) => cols.ordered.map((c) => fmt.cell(r[c]))));
    }
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${db.id(t.name)} ${where}`, params);
    const rows = await db.query(`SELECT * FROM ${db.id(t.name)} ${where} ORDER BY ${db.id(sort)} ${dir} LIMIT ? OFFSET ?`, [...params, per, (page - 1) * per]);
    const c = await audit.resolveCols(t);
    stripCash(t, c, rows);
    const linkCols = ['citizenid', 'owner', 'creator'].map((k) => c[k]).filter(Boolean);
    res.render('table', { t, columns: cols.ordered, rows, page, pages: Math.max(1, Math.ceil(n / per)), total: n, sort, dir, linkCols, role: ROLES[t.role] });
  })
);

module.exports = { router, homeFor, MASK };
