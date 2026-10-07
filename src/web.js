// Shared request helpers: permission checks, pagination, CSV, money masking.
const fmt = require('./format');
const perms = require('./perms');
const store = require('./store');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function can(req, perm) {
  return !!req.perms && req.perms.has(perm);
}

// Route guard: needs ANY of the given permissions.
function need(...list) {
  return (req, res, next) => {
    if (list.some((p) => can(req, p))) return next();
    res.status(403).render('error', { message: `You don't have permission to do that (${list.join(' or ')}).` });
  };
}

function tableAllowed(req, name) {
  const u = req.user;
  if (!u) return false;
  if (u.is_superadmin) return true;
  const t = u.role_tables || [];
  return t.includes('*') || t.includes(name);
}

function paginate(list, req, per = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pages = Math.max(1, Math.ceil(list.length / per));
  return { items: list.slice((page - 1) * per, page * per), page: Math.min(page, pages), pages, total: list.length };
}

function csv(req, res, filename, header, rows) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  store.log(req.user, 'export.csv', filename, req.originalUrl, req.ip);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([header, ...rows].map((r) => r.map(esc).join(',')).join('\n'));
}

const MASK = '$•••••';
// Removes dollar amounts from free text (flag titles etc.) for users without money.view.
const redactText = (s) => String(s ?? '').replace(/-?\$-?[\d,]+(\.\d+)?/g, MASK);

// Per-request locals for templates.
function locals(req, res, next) {
  const showMoney = can(req, 'money.view');
  res.locals.user = req.user || null;
  res.locals.can = (p) => can(req, p);
  res.locals.money = showMoney ? fmt.money : () => MASK;
  res.locals.amount = showMoney ? (v) => v : () => '';
  res.locals.red = showMoney ? (s) => s : redactText;
  res.locals.tableAllowed = (n) => tableAllowed(req, n);
  res.locals.LABELS = perms.LABELS;
  next();
}

const flash = (res, url, msg) => res.redirect(url + (url.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg));

module.exports = { wrap, can, need, tableAllowed, paginate, csv, locals, redactText, MASK, flash };
