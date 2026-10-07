const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;
let poolKey = '';

function getPool() {
  const { db } = config.get();
  const key = JSON.stringify(db);
  if (pool && key === poolKey) return pool;
  if (pool) pool.end().catch(() => {});
  if (!db.user || !db.database) {
    pool = null;
    poolKey = '';
    throw new Error('Database is not configured. Set DB_* env vars or open Settings.');
  }
  pool = mysql.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: 5,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    connectTimeout: 10000,
  });
  // Belt and braces: every session is read-only, on top of the app only issuing SELECTs.
  pool.pool.on('connection', (conn) => {
    conn.query('SET SESSION TRANSACTION READ ONLY');
  });
  poolKey = key;
  schemaCache.clear();
  return pool;
}

async function query(sql, params = []) {
  if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) throw new Error('Only read queries are allowed');
  const [rows] = await getPool().query(sql, params);
  return rows;
}

const id = (name) => mysql.escapeId(name);

// table -> Set(columns), cached per pool
const schemaCache = new Map();

async function columnsOf(table) {
  if (schemaCache.has(table)) return schemaCache.get(table);
  const rows = await query(
    'SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table]
  );
  const cols = rows.map((r) => r.c);
  const set = new Set(cols);
  set.ordered = cols;
  schemaCache.set(table, set);
  return set;
}

async function listTables() {
  const rows = await query(
    'SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
  );
  return rows;
}

async function testConnection(dbCfg) {
  const conn = await mysql.createConnection({ ...dbCfg, connectTimeout: 8000 });
  try {
    const [[row]] = await conn.query('SELECT VERSION() AS v, DATABASE() AS d, CURRENT_USER() AS u');
    let canWrite = false;
    try {
      const [grants] = await conn.query('SHOW GRANTS');
      canWrite = grants.some((g) => /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP)\b/i.test(Object.values(g)[0]));
    } catch {}
    return { version: row.v, database: row.d, user: row.u, canWrite };
  } finally {
    await conn.end();
  }
}

function clearSchemaCache() {
  schemaCache.clear();
}

module.exports = { query, id, columnsOf, listTables, testConnection, clearSchemaCache, getPool };
