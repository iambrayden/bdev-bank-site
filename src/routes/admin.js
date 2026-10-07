// Admin portal: users, roles, activity log, data settings. Plus /account for self-service.
const express = require('express');
const config = require('../config');
const db = require('../db');
const audit = require('../audit');
const store = require('../store');
const perms = require('../perms');
const { ROLES } = require('../roles');
const { wrap, need, can, flash } = require('../web');

const admin = express.Router();
const account = express.Router();

const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const MIN_PW = 10;

function pwProblem(pw) {
  if (String(pw).length < MIN_PW) return `Passwords must be at least ${MIN_PW} characters.`;
  return null;
}

// A non-superadmin can never hand out permissions they don't hold themselves.
function grantable(req) {
  return req.user.is_superadmin ? new Set(perms.ALL) : req.perms;
}
function roleWithin(req, role) {
  if (req.user.is_superadmin) return true;
  return !role || role.permissions.every((p) => req.perms.has(p));
}
// Can the current admin manage this target user at all?
function canManage(req, target) {
  if (req.user.is_superadmin) return true;
  return !target.is_superadmin;
}

admin.get('/', (req, res) => {
  const order = [
    ['admin.users', '/admin/users'],
    ['admin.roles', '/admin/roles'],
    ['admin.activity', '/admin/activity'],
    ['admin.settings', '/admin/settings'],
  ];
  const first = order.find(([p]) => can(req, p));
  if (!first) return res.status(403).render('error', { message: 'You have no admin permissions.' });
  res.redirect(first[1]);
});

// ---------- users ----------
admin.get('/users', need('admin.users'), (req, res) => {
  const users = store.listUsers().map((u) => ({ ...u, sessions: store.activeSessionCount(u.id), perms: perms.effective(u).size }));
  res.render('admin/users', { users, msg: req.query.msg || null, total: perms.ALL.length });
});

admin.get('/users/new', need('admin.users'), (req, res) => {
  res.render('admin/user_edit', { u: null, roles: store.listRoles(), PERMISSIONS: perms.PERMISSIONS, grantable: grantable(req), msg: null });
});

admin.post('/users', need('admin.users'), (req, res) => {
  const b = req.body;
  const username = String(b.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) return flash(res, '/admin/users/new', 'Usernames are 2–40 characters: letters, numbers, . _ -');
  if (store.getUserByName(username)) return flash(res, '/admin/users/new', 'That username is taken.');
  const problem = pwProblem(b.password);
  if (problem) return flash(res, '/admin/users/new', problem);
  const role = b.role_id ? store.getRole(Number(b.role_id)) : null;
  if (!roleWithin(req, role)) return flash(res, '/admin/users/new', 'You cannot assign a role with more permissions than you have.');
  const { allow, deny } = overridesFrom(req, b, null);
  const id = store.createUser({
    username,
    display_name: String(b.display_name || '').trim().slice(0, 80),
    password: b.password,
    role_id: role?.id ?? null,
    is_superadmin: req.user.is_superadmin && b.is_superadmin === '1',
    allow,
    deny,
    must_change_password: b.must_change_password === '1',
    notes: String(b.notes || '').slice(0, 2000),
  });
  store.log(req.user, 'admin.user_create', username, `role=${role?.name || '-'}`, req.ip);
  flash(res, `/admin/users/${id}`, 'User created.');
});

// Tri-state per permission: "inherit" | "allow" | "deny". Keeps existing overrides the admin can't grant.
function overridesFrom(req, b, existing) {
  const g = grantable(req);
  const allow = new Set(existing ? existing.allow.filter((p) => !g.has(p)) : []);
  const deny = new Set(existing ? existing.deny.filter((p) => !g.has(p)) : []);
  for (const p of perms.ALL) {
    if (!g.has(p)) continue;
    const v = b[`perm_${p}`];
    if (v === 'allow') allow.add(p);
    else if (v === 'deny') deny.add(p);
  }
  return { allow: [...allow], deny: [...deny] };
}

function loadTarget(req, res, next) {
  const u = store.getUser(Number(req.params.id));
  if (!u) return res.status(404).render('error', { message: 'User not found.' });
  if (!canManage(req, u)) return res.status(403).render('error', { message: 'Only a superadmin can manage superadmin accounts.' });
  req.target = u;
  next();
}

admin.get('/users/:id', need('admin.users'), loadTarget, (req, res) => {
  const u = req.target;
  res.render('admin/user_edit', {
    u,
    roles: store.listRoles(),
    PERMISSIONS: perms.PERMISSIONS,
    grantable: grantable(req),
    effective: perms.effective(u),
    sessions: store.activeSessionCount(u.id),
    activity: store.listActivity({ user: u.username, limit: 25 }).rows,
    msg: req.query.msg || null,
  });
});

admin.post('/users/:id', need('admin.users'), loadTarget, (req, res) => {
  const u = req.target;
  const b = req.body;
  const self = u.id === req.user.id;
  const role = b.role_id ? store.getRole(Number(b.role_id)) : null;
  if ((role?.id ?? null) !== (u.role_id ?? null) && !roleWithin(req, role)) return flash(res, `/admin/users/${u.id}`, 'You cannot assign a role with more permissions than you have.');
  const isSuper = req.user.is_superadmin ? b.is_superadmin === '1' : !!u.is_superadmin;
  const disabled = b.disabled === '1';
  if (self && (disabled || (!isSuper && u.is_superadmin))) return flash(res, `/admin/users/${u.id}`, 'You cannot disable yourself or remove your own superadmin status.');
  if (u.is_superadmin && (!isSuper || disabled) && store.countSuperadmins() <= 1) return flash(res, `/admin/users/${u.id}`, 'This is the last active superadmin.');
  const { allow, deny } = overridesFrom(req, b, u);
  store.updateUser(u.id, { display_name: String(b.display_name || '').trim().slice(0, 80), role_id: role?.id ?? null, is_superadmin: isSuper, allow, deny, disabled, notes: String(b.notes || '').slice(0, 2000) });
  store.log(req.user, 'admin.user_update', u.username, { role: role?.name || null, allow, deny, disabled, superadmin: isSuper }, req.ip);
  flash(res, `/admin/users/${u.id}`, 'User saved.');
});

admin.post('/users/:id/password', need('admin.users'), loadTarget, (req, res) => {
  const problem = pwProblem(req.body.password);
  if (problem) return flash(res, `/admin/users/${req.target.id}`, problem);
  store.setPassword(req.target.id, req.body.password, req.body.must_change_password === '1');
  if (req.target.id !== req.user.id) store.revokeSessions(req.target.id);
  store.log(req.user, 'admin.user_password', req.target.username, '', req.ip);
  flash(res, `/admin/users/${req.target.id}`, 'Password reset. Existing sessions were signed out.');
});

admin.post('/users/:id/sessions', need('admin.users'), loadTarget, (req, res) => {
  store.revokeSessions(req.target.id, req.target.id === req.user.id ? req.sessionToken : undefined);
  store.log(req.user, 'admin.user_signout', req.target.username, '', req.ip);
  flash(res, `/admin/users/${req.target.id}`, 'Sessions signed out.');
});

admin.post('/users/:id/delete', need('admin.users'), loadTarget, (req, res) => {
  const u = req.target;
  if (u.id === req.user.id) return flash(res, `/admin/users/${u.id}`, 'You cannot delete yourself.');
  if (u.is_superadmin && store.countSuperadmins() <= 1) return flash(res, `/admin/users/${u.id}`, 'This is the last active superadmin.');
  store.deleteUser(u.id);
  store.log(req.user, 'admin.user_delete', u.username, '', req.ip);
  flash(res, '/admin/users', `Deleted ${u.username}.`);
});

// ---------- roles ----------
admin.get(
  '/roles',
  need('admin.roles'),
  (req, res) => res.render('admin/roles', { roles: store.listRoles(), LABELS: perms.LABELS, total: perms.ALL.length, msg: req.query.msg || null })
);

async function tableNames() {
  const names = new Set(config.allTables().map((t) => t.name));
  try {
    for (const t of await db.listTables()) names.add(t.name);
  } catch {}
  return [...names].sort();
}

admin.get(
  '/roles/new',
  need('admin.roles'),
  wrap(async (req, res) => res.render('admin/role_edit', { r: null, PERMISSIONS: perms.PERMISSIONS, grantable: grantable(req), tables: await tableNames(), configured: new Set(config.allTables().map((t) => t.name)), msg: req.query.msg || null }))
);

admin.get(
  '/roles/:id',
  need('admin.roles'),
  wrap(async (req, res) => {
    const r = store.getRole(Number(req.params.id));
    if (!r) return res.status(404).render('error', { message: 'Role not found.' });
    const users = store.listUsers().filter((u) => u.role_id === r.id);
    res.render('admin/role_edit', { r, users, PERMISSIONS: perms.PERMISSIONS, grantable: grantable(req), tables: await tableNames(), configured: new Set(config.allTables().map((t) => t.name)), msg: req.query.msg || null });
  })
);

function roleFrom(req, b, existing) {
  const g = grantable(req);
  const chosen = new Set(arr(b.permissions).filter((p) => perms.ALL.includes(p) && g.has(p)));
  // keep permissions the editor can't grant (they also can't remove them)
  if (existing) for (const p of existing.permissions) if (!g.has(p)) chosen.add(p);
  const tables = b.all_tables === '1' ? ['*'] : arr(b.tables).map(String);
  return { name: String(b.name || '').trim().slice(0, 60), description: String(b.description || '').slice(0, 300), permissions: [...chosen], tables };
}

admin.post('/roles', need('admin.roles'), (req, res) => {
  const r = roleFrom(req, req.body, null);
  if (!r.name) return flash(res, '/admin/roles/new', 'Roles need a name.');
  if (store.listRoles().some((x) => x.name.toLowerCase() === r.name.toLowerCase())) return flash(res, '/admin/roles/new', 'A role with that name exists.');
  const id = store.createRole(r);
  store.log(req.user, 'admin.role_create', r.name, r, req.ip);
  flash(res, `/admin/roles/${id}`, 'Role created.');
});

admin.post('/roles/:id', need('admin.roles'), (req, res) => {
  const existing = store.getRole(Number(req.params.id));
  if (!existing) return res.status(404).render('error', { message: 'Role not found.' });
  if (!roleWithin(req, existing)) return res.status(403).render('error', { message: 'You cannot edit a role with more permissions than you have.' });
  const r = roleFrom(req, req.body, existing);
  if (!r.name) return flash(res, `/admin/roles/${existing.id}`, 'Roles need a name.');
  if (store.listRoles().some((x) => x.id !== existing.id && x.name.toLowerCase() === r.name.toLowerCase())) return flash(res, `/admin/roles/${existing.id}`, 'A role with that name exists.');
  store.updateRole(existing.id, r);
  store.log(req.user, 'admin.role_update', r.name, r, req.ip);
  flash(res, `/admin/roles/${existing.id}`, 'Role saved.');
});

admin.post('/roles/:id/delete', need('admin.roles'), (req, res) => {
  const r = store.getRole(Number(req.params.id));
  if (!r) return res.status(404).render('error', { message: 'Role not found.' });
  if (store.listUsers().some((u) => u.role_id === r.id)) return flash(res, `/admin/roles/${r.id}`, 'Move users off this role before deleting it.');
  if (!roleWithin(req, r)) return res.status(403).render('error', { message: 'You cannot delete a role with more permissions than you have.' });
  store.deleteRole(r.id);
  store.log(req.user, 'admin.role_delete', r.name, '', req.ip);
  flash(res, '/admin/roles', `Deleted role ${r.name}.`);
});

// ---------- activity ----------
admin.get('/activity', need('admin.activity'), (req, res) => {
  const per = 100;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const { total, rows } = store.listActivity({ user: req.query.user || '', action: req.query.action || '', q: req.query.q || '', limit: per, offset: (page - 1) * per });
  res.render('admin/activity', { rows, pg: { page, pages: Math.max(1, Math.ceil(total / per)), total }, actions: store.activityActions(), users: store.listUsers() });
});

// ---------- data settings (game DB connection, tables, thresholds) ----------
admin.get(
  '/settings',
  need('admin.settings'),
  wrap(async (req, res) => {
    let dbTables = [];
    let dbError = null;
    try {
      dbTables = await db.listTables();
    } catch (e) {
      dbError = e.message;
    }
    res.render('settings', { cfg: config.get(), ROLES, dbTables, dbError, msg: req.query.msg || null, configFile: config.CONFIG_FILE });
  })
);

admin.post(
  '/settings/db',
  need('admin.settings'),
  wrap(async (req, res) => {
    const b = req.body;
    const cur = config.get().db;
    const next = { host: String(b.host || '').trim(), port: Number(b.port) || 3306, user: String(b.user || '').trim(), database: String(b.database || '').trim(), password: b.password ? b.password : cur.password };
    if (b.action === 'test') {
      try {
        const r = await db.testConnection(next);
        const warn = r.canWrite ? ' ⚠ This user has write privileges — a read-only user is recommended.' : ' User is read-only.';
        return flash(res, '/admin/settings', `Connected: ${r.user} on ${r.database} (${r.version}).${warn}`);
      } catch (e) {
        return flash(res, '/admin/settings', 'Connection failed: ' + e.message);
      }
    }
    config.save({ db: next });
    audit.invalidate();
    db.clearSchemaCache();
    store.log(req.user, 'admin.settings_db', `${next.user}@${next.host}/${next.database}`, '', req.ip);
    flash(res, '/admin/settings', 'Database settings saved.');
  })
);

function parseColumns(raw, where) {
  if (!raw || !raw.trim()) return undefined;
  const obj = JSON.parse(raw);
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${where}: column overrides must be a JSON object`);
  return obj;
}

admin.post('/settings/tables', need('admin.settings'), (req, res) => {
  const b = req.body;
  const names = arr(b.name);
  const roles = arr(b.role);
  const cols = arr(b.columns);
  const removes = new Set(arr(b.remove));
  try {
    const core = { name: String(b.core_name || 'players').trim(), role: 'players', columns: parseColumns(b.core_columns, 'players') };
    const tables = [];
    names.forEach((n, i) => {
      const name = String(n || '').trim();
      if (!name || removes.has(String(i))) return;
      if (!/^[A-Za-z0-9_$-]{1,64}$/.test(name)) throw new Error(`Invalid table name: ${name}`);
      const role = ROLES[roles[i]] && roles[i] !== 'players' ? roles[i] : 'generic';
      tables.push({ name, role, columns: parseColumns(cols[i], name) });
    });
    for (const n of arr(b.add)) if (n && !tables.some((t) => t.name === n) && n !== core.name) tables.push({ name: n, role: 'generic' });
    config.save({ core, tables });
    store.log(req.user, 'admin.settings_tables', '', { core: core.name, tables: tables.map((t) => `${t.name}:${t.role}`) }, req.ip);
  } catch (e) {
    return flash(res, '/admin/settings', 'Not saved: ' + e.message);
  }
  audit.invalidate();
  db.clearSchemaCache();
  flash(res, '/admin/settings', 'Tables saved.');
});

admin.post('/settings/thresholds', need('admin.settings'), (req, res) => {
  const th = {};
  for (const k of Object.keys(config.DEFAULT_THRESHOLDS)) {
    const v = Number(req.body[k]);
    th[k] = Number.isFinite(v) && v > 0 ? v : config.DEFAULT_THRESHOLDS[k];
  }
  config.save({ thresholds: th });
  audit.invalidate();
  store.log(req.user, 'admin.settings_thresholds', '', th, req.ip);
  flash(res, '/admin/settings', 'Thresholds saved.');
});

admin.post('/settings/reset', need('admin.settings'), (req, res) => {
  config.resetToEnv();
  audit.invalidate();
  db.clearSchemaCache();
  store.log(req.user, 'admin.settings_reset', '', '', req.ip);
  flash(res, '/admin/settings', 'Settings reset to environment defaults.');
});

// ---------- my account ----------
account.get('/', (req, res) => {
  res.render('account_me', { PERMISSIONS: perms.PERMISSIONS, effective: req.perms, msg: req.query.msg || null });
});

account.post('/password', (req, res) => {
  const u = store.getUser(req.user.id);
  if (!store.verifyPassword(String(req.body.current || ''), u.password_hash)) return flash(res, '/account', 'Current password is wrong.');
  if (req.body.password !== req.body.confirm) return flash(res, '/account', 'New passwords do not match.');
  const problem = pwProblem(req.body.password);
  if (problem) return flash(res, '/account', problem);
  store.setPassword(u.id, req.body.password, false);
  store.revokeSessions(u.id, req.sessionToken);
  store.log(req.user, 'auth.password_change', '', '', req.ip);
  flash(res, '/account', 'Password changed.');
});

module.exports = { admin, account };
