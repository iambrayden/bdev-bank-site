const fs = require('fs');
const path = require('path');
const { ROLES, DEFAULT_TABLES, DEFAULT_CORE } = require('./roles');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_THRESHOLDS = {
  largeTransaction: 100000, // single transaction >= this is flagged
  highBalance: 1000000, // citizen bank balance >= this is flagged
  highAccountBalance: 5000000, // shared/society account balance >= this is flagged
  burstCount: 10, // >= N transactions on one account ...
  burstMinutes: 10, // ... within this many minutes
  pairCount: 5, // >= N transfers between the same two people ...
  pairDays: 7, // ... within this many days
};

// AUDIT_TABLES="players:players,player_transactions:player_transactions,..."
function tablesFromEnv() {
  const raw = process.env.AUDIT_TABLES;
  if (!raw) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, role] = entry.split(':').map((s) => s.trim());
      return { name, role: ROLES[role] ? role : 'generic' };
    });
}

function dbFromEnv() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  };
}

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  current = {
    // Saved settings win over env so that changes made in the UI stick.
    db: { ...dbFromEnv(), ...(saved.db || {}) },
    core: { ...DEFAULT_CORE, ...(process.env.PLAYERS_TABLE ? { name: process.env.PLAYERS_TABLE } : {}), ...(saved.core || {}), role: 'players' },
    tables: (saved.tables || tablesFromEnv() || DEFAULT_TABLES.map((t) => ({ ...t }))).filter((t) => t.role !== 'players'),
    thresholds: { ...DEFAULT_THRESHOLDS, ...(saved.thresholds || {}) },
  };
  return current;
}

function get() {
  return current || load();
}

// Core players table first, then every linked table.
function allTables() {
  const c = get();
  return [c.core, ...c.tables];
}

function save(partial) {
  const next = { ...get(), ...partial };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  current = next;
  return current;
}

function resetToEnv() {
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {}
  current = null;
  return load();
}

// Resolved column map for a configured table entry.
function columnsFor(table) {
  const role = ROLES[table.role] || ROLES.generic;
  return { ...role.columns, ...(table.columns || {}) };
}

module.exports = { get, allTables, load, save, resetToEnv, columnsFor, DEFAULT_THRESHOLDS, CONFIG_FILE };
