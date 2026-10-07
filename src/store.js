// App database (SQLite, in DATA_DIR): users, roles, sessions, cases, activity log.
// Separate from the game database, which is only ever read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_ROLES } = require('./perms');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  tables TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  allow TEXT NOT NULL DEFAULT '[]',
  deny TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  outcome TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS case_members (
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (case_id, user_id)
);
CREATE TABLE IF NOT EXISTS case_subjects (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  citizenid TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT 'subject',
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  UNIQUE (case_id, citizenid)
);
CREATE TABLE IF NOT EXISTS case_evidence (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS case_notes (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
CREATE INDEX IF NOT EXISTS evidence_case ON case_evidence(case_id);
CREATE INDEX IF NOT EXISTS subjects_cid ON case_subjects(citizenid);
`;

const now = () => Math.floor(Date.now() / 1000);
const J = (v) => JSON.stringify(v ?? null);
const P = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}

// ---------- init ----------
function init(file = path.join(DATA_DIR, 'app.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT COUNT(*) n FROM roles').get().n) {
    for (const r of DEFAULT_ROLES) createRole(r);
  }
  bootstrapAdmin();
  return db;
}

// First start: create a superadmin from ADMIN_USERNAME / ADMIN_PASSWORD (or APP_PASSWORD).
function bootstrapAdmin() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  const password = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD;
  if (!password) {
    console.error('No users exist yet. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) to create the first admin.');
    process.exit(1);
  }
  const username = process.env.ADMIN_USERNAME || 'admin';
  const role = db.prepare("SELECT id FROM roles WHERE name = 'Administrator'").get();
  createUser({ username, display_name: 'Administrator', password, role_id: role?.id ?? null, is_superadmin: 1 });
  console.log(`Created superadmin user "${username}".`);
}

// ---------- roles ----------
function rowToRole(r) {
  return r && { ...r, permissions: P(r.permissions, []), tables: P(r.tables, []) };
}
function listRoles() {
  return db
    .prepare('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r ORDER BY r.name')
    .all()
    .map(rowToRole);
}
function getRole(id) {
  return rowToRole(db.prepare('SELECT * FROM roles WHERE id = ?').get(id));
}
function createRole({ name, description = '', permissions = [], tables = [] }) {
  return db.prepare('INSERT INTO roles (name, description, permissions, tables, created_at) VALUES (?, ?, ?, ?, ?)').run(name, description, J(permissions), J(tables), now()).lastInsertRowid;
}
function updateRole(id, { name, description, permissions, tables }) {
  db.prepare('UPDATE roles SET name = ?, description = ?, permissions = ?, tables = ? WHERE id = ?').run(name, description, J(permissions), J(tables), id);
}
function deleteRole(id) {
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
}

// ---------- users ----------
const USER_SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions, r.tables AS role_tables
  FROM users u LEFT JOIN roles r ON r.id = u.role_id`;
function rowToUser(u) {
  if (!u) return null;
  return { ...u, allow: P(u.allow, []), deny: P(u.deny, []), role_permissions: P(u.role_permissions, []), role_tables: P(u.role_tables, []) };
}
function listUsers() {
  return db.prepare(`${USER_SELECT} ORDER BY u.username`).all().map(rowToUser);
}
function getUser(id) {
  return rowToUser(db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id));
}
function getUserByName(username) {
  return rowToUser(db.prepare(`${USER_SELECT} WHERE u.username = ?`).get(username));
}
function createUser({ username, display_name = '', password, role_id = null, is_superadmin = 0, allow = [], deny = [], must_change_password = 0, notes = '' }) {
  return db
    .prepare('INSERT INTO users (username, display_name, password_hash, role_id, is_superadmin, allow, deny, must_change_password, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, display_name, hashPassword(password), role_id, is_superadmin ? 1 : 0, J(allow), J(deny), must_change_password ? 1 : 0, notes, now()).lastInsertRowid;
}
function updateUser(id, f) {
  db.prepare('UPDATE users SET display_name = ?, role_id = ?, is_superadmin = ?, allow = ?, deny = ?, disabled = ?, notes = ? WHERE id = ?').run(
    f.display_name,
    f.role_id,
    f.is_superadmin ? 1 : 0,
    J(f.allow),
    J(f.deny),
    f.disabled ? 1 : 0,
    f.notes || '',
    id
  );
  if (f.disabled) revokeSessions(id);
}
function setPassword(id, password, mustChange = false) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hashPassword(password), mustChange ? 1 : 0, id);
}
function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
function countSuperadmins() {
  return db.prepare('SELECT COUNT(*) n FROM users WHERE is_superadmin = 1 AND disabled = 0').get().n;
}

// ---------- sessions (random token in cookie, hash stored) ----------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId, hours, ip, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(sha(token), userId, now(), now() + hours * 3600, ip || '', String(ua || '').slice(0, 200));
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), userId);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), now());
  if (!s) return null;
  const u = getUser(s.user_id);
  return u && !u.disabled ? u : null;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}
function revokeSessions(userId, exceptToken) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function activeSessionCount(userId) {
  return db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, now()).n;
}

// ---------- activity log ----------
function log(user, action, target = '', detail = '', ip = '') {
  db.prepare('INSERT INTO activity (user_id, username, action, target, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user?.id ?? null, user?.username ?? null, action, String(target), typeof detail === 'string' ? detail : J(detail), ip || '', now());
}
function listActivity({ user, action, q, limit = 200, offset = 0 }) {
  const where = [];
  const params = [];
  if (user) where.push('username = ?') && params.push(user);
  if (action) where.push('action LIKE ?') && params.push(action + '%');
  if (q) where.push('(target LIKE ? OR detail LIKE ?)') && params.push(`%${q}%`, `%${q}%`);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM activity ${w}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM activity ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows };
}
function activityActions() {
  return db.prepare('SELECT DISTINCT action FROM activity ORDER BY action').all().map((r) => r.action);
}

// ---------- cases ----------
const CASE_STATUSES = ['open', 'investigating', 'pending_review', 'closed'];
const CASE_PRIORITIES = ['low', 'medium', 'high', 'critical'];

const CASE_SELECT = `SELECT c.*, cu.username AS created_by_name, au.username AS assigned_to_name,
  (SELECT COUNT(*) FROM case_evidence e WHERE e.case_id = c.id) AS evidence_count,
  (SELECT COUNT(*) FROM case_subjects s WHERE s.case_id = c.id) AS subject_count
  FROM cases c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users au ON au.id = c.assigned_to`;

// Cases visible to a user. viewAll = has cases.view_all.
function listCases({ userId, viewAll, status, q, citizenid, mine }) {
  const where = [];
  const params = [];
  if (!viewAll || mine) {
    where.push('(c.created_by = ? OR c.assigned_to = ? OR EXISTS (SELECT 1 FROM case_members m WHERE m.case_id = c.id AND m.user_id = ?))');
    params.push(userId, userId, userId);
  }
  if (status === 'active') where.push("c.status != 'closed'");
  else if (status) where.push('c.status = ?') && params.push(status);
  if (q) where.push('(c.title LIKE ? OR c.summary LIKE ? OR c.id = ?)') && params.push(`%${q}%`, `%${q}%`, Number(String(q).replace(/\D/g, '')) || -1);
  if (citizenid) where.push('EXISTS (SELECT 1 FROM case_subjects s WHERE s.case_id = c.id AND s.citizenid = ?)') && params.push(citizenid);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`${CASE_SELECT} ${w} ORDER BY CASE c.status WHEN 'closed' THEN 1 ELSE 0 END, CASE c.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, c.updated_at DESC`).all(...params);
}
function getCase(id) {
  return db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) || null;
}
function caseMembers(id) {
  return db.prepare('SELECT u.id, u.username, u.display_name FROM case_members m JOIN users u ON u.id = m.user_id WHERE m.case_id = ? ORDER BY u.username').all(id);
}
function isCaseMember(caseId, userId) {
  return !!db.prepare('SELECT 1 FROM case_members WHERE case_id = ? AND user_id = ?').get(caseId, userId);
}
function createCase({ title, summary = '', priority = 'medium', created_by, assigned_to = null }) {
  const t = now();
  return Number(db.prepare('INSERT INTO cases (title, summary, priority, created_by, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(title, summary, priority, created_by, assigned_to, t, t).lastInsertRowid);
}
function updateCase(id, fields) {
  const allowed = ['title', 'summary', 'status', 'priority', 'outcome', 'assigned_to', 'closed_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
}
function touchCase(id) {
  db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), id);
}
function deleteCase(id) {
  db.prepare('DELETE FROM cases WHERE id = ?').run(id);
}
function setCaseMembers(id, userIds) {
  db.prepare('DELETE FROM case_members WHERE case_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO case_members VALUES (?, ?)');
  for (const u of userIds) ins.run(id, u);
}

function caseSubjects(id) {
  return db.prepare('SELECT s.*, u.username AS added_by_name FROM case_subjects s LEFT JOIN users u ON u.id = s.added_by WHERE s.case_id = ? ORDER BY s.added_at').all(id).map((s) => ({ ...s, snapshot: P(s.snapshot, {}) }));
}
function addSubject(caseId, { citizenid, name = '', label = 'subject', note = '', snapshot = {} }, userId) {
  db.prepare(
    `INSERT INTO case_subjects (case_id, citizenid, name, label, note, snapshot, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (case_id, citizenid) DO UPDATE SET label = excluded.label, note = CASE WHEN excluded.note != '' THEN excluded.note ELSE case_subjects.note END`
  ).run(caseId, citizenid, name, label, note, J(snapshot), userId, now());
  touchCase(caseId);
}
function removeSubject(caseId, subjectId) {
  db.prepare('DELETE FROM case_subjects WHERE id = ? AND case_id = ?').run(subjectId, caseId);
  touchCase(caseId);
}

function caseEvidence(id) {
  return db.prepare('SELECT e.*, u.username AS added_by_name FROM case_evidence e LEFT JOIN users u ON u.id = e.added_by WHERE e.case_id = ? ORDER BY e.added_at').all(id).map((e) => ({ ...e, data: P(e.data, {}) }));
}
function getEvidence(caseId, evId) {
  const e = db.prepare('SELECT * FROM case_evidence WHERE id = ? AND case_id = ?').get(evId, caseId);
  return e ? { ...e, data: P(e.data, {}) } : null;
}
function hasEvidence(caseId, type, ref) {
  return !!(ref && db.prepare('SELECT 1 FROM case_evidence WHERE case_id = ? AND type = ? AND ref = ?').get(caseId, type, ref));
}
function addEvidence(caseId, { type, ref = '', title = '', data = {}, note = '' }, userId) {
  const id = db.prepare('INSERT INTO case_evidence (case_id, type, ref, title, data, note, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(caseId, type, ref, title, J(data), note, userId, now()).lastInsertRowid;
  touchCase(caseId);
  return id;
}
function updateEvidenceNote(caseId, evId, note) {
  db.prepare('UPDATE case_evidence SET note = ? WHERE id = ? AND case_id = ?').run(note, evId, caseId);
  touchCase(caseId);
}
function removeEvidence(caseId, evId) {
  db.prepare('DELETE FROM case_evidence WHERE id = ? AND case_id = ?').run(evId, caseId);
  touchCase(caseId);
}

function caseNotes(id) {
  return db.prepare('SELECT n.*, u.username, u.display_name FROM case_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.case_id = ? ORDER BY n.created_at, n.id').all(id);
}
function getNote(caseId, noteId) {
  return db.prepare('SELECT * FROM case_notes WHERE id = ? AND case_id = ?').get(noteId, caseId);
}
function addNote(caseId, userId, body, kind = 'note') {
  db.prepare('INSERT INTO case_notes (case_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, userId, kind, body, now());
  touchCase(caseId);
}
function removeNote(caseId, noteId) {
  db.prepare('DELETE FROM case_notes WHERE id = ? AND case_id = ?').run(noteId, caseId);
}

// citizenid -> [{id, title, status}] for cases visible to the user
function casesForCitizen(citizenid, userId, viewAll) {
  return listCases({ userId, viewAll, citizenid });
}

module.exports = {
  init,
  hashPassword,
  verifyPassword,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  listUsers,
  getUser,
  getUserByName,
  createUser,
  updateUser,
  setPassword,
  deleteUser,
  countSuperadmins,
  createSession,
  sessionUser,
  destroySession,
  revokeSessions,
  activeSessionCount,
  log,
  listActivity,
  activityActions,
  CASE_STATUSES,
  CASE_PRIORITIES,
  listCases,
  getCase,
  caseMembers,
  isCaseMember,
  createCase,
  updateCase,
  deleteCase,
  setCaseMembers,
  caseSubjects,
  addSubject,
  removeSubject,
  caseEvidence,
  getEvidence,
  hasEvidence,
  addEvidence,
  updateEvidenceNote,
  removeEvidence,
  caseNotes,
  getNote,
  addNote,
  removeNote,
  casesForCitizen,
};
