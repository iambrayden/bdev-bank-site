// Loads economy data from the configured tables, normalises it, and computes audit flags.
const db = require('./db');
const config = require('./config');

const CACHE_MS = Number(process.env.CACHE_SECONDS || 30) * 1000;
let cache = null;

function parseJson(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toSeconds(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    const d = Date.parse(t);
    return Number.isFinite(d) ? Math.floor(d / 1000) : 0;
  }
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function tablesByRole(role) {
  return config.allTables().filter((t) => t.role === role);
}

// Physical column name for a logical column, or null if the table doesn't have it.
async function resolveCols(table) {
  const wanted = config.columnsFor(table);
  const have = await db.columnsOf(table.name);
  const out = {};
  for (const [logical, physical] of Object.entries(wanted)) out[logical] = physical && have.has(physical) ? physical : null;
  out._all = have.ordered || [];
  return out;
}

function normalizeTx(raw, account, accountType) {
  const type = String(raw.trans_type || raw.type || '').toLowerCase();
  const amount = Math.abs(num(raw.amount));
  const isOut = type.startsWith('with') || type === 'transfer_out' || type === 'remove';
  return {
    trans_id: raw.trans_id || raw.id || null,
    account,
    accountType,
    title: raw.title || '',
    type: type || 'unknown',
    amount,
    signed: isOut ? -amount : amount,
    issuer: raw.issuer || '',
    receiver: raw.receiver || '',
    message: raw.message || '',
    time: toSeconds(raw.time),
  };
}

async function loadPlayers(warnings) {
  const players = [];
  for (const t of tablesByRole('players')) {
    const c = await resolveCols(t);
    if (!c.citizenid) {
      warnings.push(`${t.name}: citizenid column not found, skipped`);
      continue;
    }
    const sel = ['citizenid', 'license', 'name', 'money', 'charinfo', 'job', 'gang', 'lastUpdated']
      .filter((k) => c[k])
      .map((k) => `${db.id(c[k])} AS ${db.id(k)}`);
    const rows = await db.query(`SELECT ${sel.join(', ')} FROM ${db.id(t.name)}`);
    for (const r of rows) {
      const money = parseJson(r.money, {}) || {};
      const ci = parseJson(r.charinfo, {}) || {};
      const job = parseJson(r.job, null);
      const gang = parseJson(r.gang, null);
      const charName = [ci.firstname, ci.lastname].filter(Boolean).join(' ').trim();
      players.push({
        citizenid: String(r.citizenid),
        license: r.license || '',
        account: r.name || '',
        name: charName || r.name || String(r.citizenid),
        cash: num(money.cash),
        bank: num(money.bank),
        crypto: num(money.crypto),
        otherMoney: Object.fromEntries(Object.entries(money).filter(([k]) => !['cash', 'bank', 'crypto'].includes(k))),
        job: job ? { name: job.name, label: job.label || job.name, grade: job.grade?.name ?? job.grade?.level ?? job.grade, onduty: job.onduty } : null,
        gang: gang && gang.name && gang.name !== 'none' ? { name: gang.name, label: gang.label || gang.name } : null,
        phone: ci.phone || '',
        birthdate: ci.birthdate || '',
        lastUpdated: r.lastUpdated || '',
      });
    }
  }
  return players;
}

async function loadPersonalTx(warnings) {
  const tx = [];
  const frozen = new Set();
  for (const t of tablesByRole('player_transactions')) {
    const c = await resolveCols(t);
    if (!c.citizenid || !c.transactions) {
      warnings.push(`${t.name}: id/transactions columns not found, skipped`);
      continue;
    }
    const sel = [`${db.id(c.citizenid)} AS cid`, `${db.id(c.transactions)} AS tx`];
    if (c.frozen) sel.push(`${db.id(c.frozen)} AS frozen`);
    const rows = await db.query(`SELECT ${sel.join(', ')} FROM ${db.id(t.name)}`);
    for (const r of rows) {
      if (num(r.frozen)) frozen.add(String(r.cid));
      const list = parseJson(r.tx, []);
      if (!Array.isArray(list)) {
        warnings.push(`${t.name}: transactions for ${r.cid} are not a JSON array`);
        continue;
      }
      for (const raw of list) if (raw && typeof raw === 'object') tx.push(normalizeTx(raw, String(r.cid), 'personal'));
    }
  }
  return { tx, frozen };
}

async function loadAccounts(warnings) {
  const accounts = [];
  const tx = [];
  for (const t of tablesByRole('bank_accounts')) {
    const c = await resolveCols(t);
    if (!c.id) {
      warnings.push(`${t.name}: id column not found, skipped`);
      continue;
    }
    const sel = ['id', 'amount', 'transactions', 'auth', 'frozen', 'creator'].filter((k) => c[k]).map((k) => `${db.id(c[k])} AS ${db.id(k)}`);
    const rows = await db.query(`SELECT ${sel.join(', ')} FROM ${db.id(t.name)}`);
    for (const r of rows) {
      const auth = parseJson(r.auth, []);
      const list = parseJson(r.transactions, []);
      const acc = {
        id: String(r.id),
        table: t.name,
        amount: num(r.amount),
        auth: Array.isArray(auth) ? auth.map(String) : [],
        frozen: !!num(r.frozen),
        creator: r.creator || null,
        txCount: Array.isArray(list) ? list.length : 0,
      };
      accounts.push(acc);
      if (Array.isArray(list)) for (const raw of list) if (raw && typeof raw === 'object') tx.push(normalizeTx(raw, acc.id, 'shared'));
    }
  }
  return { accounts, tx };
}

async function loadGroups() {
  const groups = new Map();
  for (const t of tablesByRole('player_groups')) {
    const c = await resolveCols(t);
    if (!c.citizenid || !c.group) continue;
    const sel = [`${db.id(c.citizenid)} AS cid`, `${db.id(c.group)} AS g`];
    if (c.type) sel.push(`${db.id(c.type)} AS t`);
    if (c.grade) sel.push(`${db.id(c.grade)} AS gr`);
    for (const r of await db.query(`SELECT ${sel.join(', ')} FROM ${db.id(t.name)}`)) {
      const k = String(r.cid);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ group: r.g, type: r.t || '', grade: r.gr ?? '' });
    }
  }
  return groups;
}

// Every citizenid referenced by a linked table, to find assets of deleted citizens.
async function loadReferencedCids() {
  const refs = [];
  for (const t of config.get().tables) {
    const c = await resolveCols(t).catch(() => null);
    if (!c) continue;
    for (const k of ['citizenid', 'owner']) {
      if (!c[k]) continue;
      const rows = await db.query(`SELECT ${db.id(c[k])} AS cid, COUNT(*) AS n FROM ${db.id(t.name)} GROUP BY ${db.id(c[k])}`);
      for (const r of rows) if (r.cid) refs.push({ table: t.name, column: c[k], cid: String(r.cid), n: num(r.n) });
    }
  }
  return refs;
}

async function snapshot(force = false) {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;
  const warnings = [];
  const safe = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${label}: ${e.message}`);
      return fallback;
    }
  };
  // Surface connection errors and a missing core table directly rather than as warnings.
  await db.query('SELECT 1');
  const players = await loadPlayers(warnings);
  const personal = await safe('player_transactions', () => loadPersonalTx(warnings), { tx: [], frozen: new Set() });
  const shared = await safe('bank_accounts', () => loadAccounts(warnings), { accounts: [], tx: [] });
  const groups = await safe('player_groups', loadGroups, new Map());
  const refs = await safe('linked tables', loadReferencedCids, []);

  const playerMap = new Map(players.map((p) => [p.citizenid, p]));
  const nameIndex = new Map();
  for (const p of players) {
    const k = p.name.toLowerCase();
    if (!nameIndex.has(k)) nameIndex.set(k, []);
    nameIndex.get(k).push(p.citizenid);
  }
  for (const p of players) p.groups = groups.get(p.citizenid) || [];

  const allTx = [...personal.tx, ...shared.tx].sort((a, b) => b.time - a.time);
  const txByAccount = new Map();
  for (const t of allTx) {
    const k = `${t.accountType}:${t.account}`;
    if (!txByAccount.has(k)) txByAccount.set(k, []);
    txByAccount.get(k).push(t);
  }
  for (const p of players) {
    const list = txByAccount.get(`personal:${p.citizenid}`) || [];
    p.txCount = list.length;
    p.lastTx = list[0]?.time || 0;
    p.frozen = personal.frozen.has(p.citizenid);
  }

  cache = {
    loadedAt: Date.now(),
    players,
    playerMap,
    nameIndex,
    accounts: shared.accounts,
    allTx,
    txByAccount,
    frozenPersonal: personal.frozen,
    refs,
    warnings,
  };
  cache.flags = computeFlags(cache, config.get().thresholds);
  return cache;
}

function invalidate() {
  cache = null;
}

// Name -> citizenid, only when the name is unambiguous.
function cidForName(snap, name) {
  if (!name) return null;
  const hits = snap.nameIndex.get(String(name).toLowerCase().trim());
  return hits && hits.length === 1 ? hits[0] : null;
}

function computeFlags(snap, th) {
  const flags = [];
  const add = (f) => flags.push(f);
  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

  // 1. Large single transactions (a transfer is recorded on both sides; flag it once)
  const seenLarge = new Set();
  for (const t of snap.allTx) {
    if (t.amount >= th.largeTransaction) {
      const key = t.trans_id ? `${t.trans_id}:${t.amount}` : null;
      if (key && seenLarge.has(key)) continue;
      if (key) seenLarge.add(key);
      add({
        severity: t.amount >= th.largeTransaction * 5 ? 'high' : 'medium',
        code: 'LARGE_TX',
        title: `Large ${t.type} of ${fmt(t.amount)}`,
        detail: [t.title, t.message, t.issuer && `issuer: ${t.issuer}`, t.receiver && `receiver: ${t.receiver}`].filter(Boolean).join(' · '),
        citizenid: t.accountType === 'personal' ? t.account : undefined,
        account: t.account,
        accountType: t.accountType,
        amount: t.amount,
        time: t.time,
        trans_id: t.trans_id,
      });
    }
  }

  // 2. Balances
  for (const p of snap.players) {
    const total = p.cash + p.bank;
    if (p.cash < 0 || p.bank < 0 || p.crypto < 0) {
      add({ severity: 'high', code: 'NEGATIVE_BALANCE', title: `Negative balance on ${p.name}`, detail: `cash ${fmt(p.cash)} · bank ${fmt(p.bank)} · crypto ${p.crypto}`, citizenid: p.citizenid, amount: total });
    }
    if (total >= th.highBalance) {
      add({ severity: total >= th.highBalance * 5 ? 'high' : 'medium', code: 'HIGH_BALANCE', title: `${p.name} holds ${fmt(total)}`, detail: `cash ${fmt(p.cash)} · bank ${fmt(p.bank)}`, citizenid: p.citizenid, amount: total });
    }
  }
  for (const a of snap.accounts) {
    if (a.amount < 0) add({ severity: 'high', code: 'NEGATIVE_BALANCE', title: `Negative balance on account ${a.id}`, detail: fmt(a.amount), account: a.id, accountType: 'shared', amount: a.amount });
    if (a.amount >= th.highAccountBalance) add({ severity: 'medium', code: 'HIGH_ACCOUNT_BALANCE', title: `Account ${a.id} holds ${fmt(a.amount)}`, detail: `${a.txCount} transactions on record`, account: a.id, accountType: 'shared', amount: a.amount });
  }

  // 3. Bursts: many transactions on one account in a short window
  const windowSec = th.burstMinutes * 60;
  for (const [key, list] of snap.txByAccount) {
    if (list.length < th.burstCount) continue;
    const asc = [...list].sort((a, b) => a.time - b.time);
    let best = { n: 0 };
    for (let i = 0, j = 0; j < asc.length; j++) {
      while (asc[j].time - asc[i].time > windowSec) i++;
      const n = j - i + 1;
      if (n > best.n) best = { n, start: asc[i].time, end: asc[j].time, sum: asc.slice(i, j + 1).reduce((s, t) => s + t.amount, 0) };
    }
    if (best.n >= th.burstCount) {
      const [accountType, account] = key.split(/:(.*)/s);
      add({ severity: best.n >= th.burstCount * 3 ? 'high' : 'medium', code: 'BURST', title: `${best.n} transactions within ${th.burstMinutes} min`, detail: `total moved ${fmt(best.sum)}`, account, accountType, citizenid: accountType === 'personal' ? account : undefined, amount: best.sum, time: best.start });
    }
  }

  // 4. Transfers: repeated pairs and transfers between citizens on the same license
  const since = Math.floor(Date.now() / 1000) - th.pairDays * 86400;
  const pairs = new Map();
  for (const t of snap.allTx) {
    if (t.accountType !== 'personal' || t.signed >= 0) continue; // count sender side only
    if (!t.receiver || !t.issuer || t.receiver.toLowerCase() === t.issuer.toLowerCase()) continue;
    const toCid = cidForName(snap, t.receiver);
    const from = snap.playerMap.get(t.account);
    const to = toCid && snap.playerMap.get(toCid);
    if (from && to && from.citizenid !== to.citizenid && from.license && from.license === to.license) {
      add({ severity: t.amount >= th.largeTransaction ? 'high' : 'medium', code: 'ALT_TRANSFER', title: `Transfer between citizens on the same license`, detail: `${from.name} (${from.citizenid}) → ${to.name} (${to.citizenid}) ${fmt(t.amount)}`, citizenid: from.citizenid, account: t.account, accountType: 'personal', amount: t.amount, time: t.time, trans_id: t.trans_id });
    }
    if (t.time < since) continue;
    const k = `${t.account}→${t.receiver.toLowerCase()}`;
    const p = pairs.get(k) || { n: 0, sum: 0, from: t.account, receiver: t.receiver, last: 0 };
    p.n++;
    p.sum += t.amount;
    p.last = Math.max(p.last, t.time);
    pairs.set(k, p);
  }
  for (const p of pairs.values()) {
    if (p.n < th.pairCount) continue;
    const from = snap.playerMap.get(p.from);
    add({ severity: p.sum >= th.largeTransaction ? 'medium' : 'low', code: 'REPEATED_TRANSFERS', title: `${p.n} transfers to ${p.receiver} in ${th.pairDays} days`, detail: `from ${from ? from.name : p.from} · total ${fmt(p.sum)}`, citizenid: p.from, account: p.from, accountType: 'personal', amount: p.sum, time: p.last });
  }

  // 5. Same trans_id recorded with different amounts
  const byId = new Map();
  for (const t of snap.allTx) {
    if (!t.trans_id) continue;
    if (!byId.has(t.trans_id)) byId.set(t.trans_id, []);
    byId.get(t.trans_id).push(t);
  }
  for (const [tid, list] of byId) {
    const amounts = new Set(list.map((t) => t.amount));
    if (amounts.size > 1) add({ severity: 'high', code: 'TRANS_ID_MISMATCH', title: `Transaction ${tid} has mismatched amounts`, detail: list.map((t) => `${t.account}: ${t.type} ${fmt(t.amount)}`).join(' · '), trans_id: tid, account: list[0].account, accountType: list[0].accountType, time: list[0].time });
    if (list.length > 2) add({ severity: 'medium', code: 'TRANS_ID_DUPLICATE', title: `Transaction ${tid} recorded ${list.length} times`, detail: list.map((t) => `${t.account}: ${t.type} ${fmt(t.amount)}`).join(' · '), trans_id: tid, account: list[0].account, accountType: list[0].accountType, time: list[0].time });
  }

  // 6. Assets / records belonging to citizens that no longer exist
  if (snap.players.length) {
    const orphans = new Map();
    for (const r of snap.refs) {
      if (snap.playerMap.has(r.cid)) continue;
      const o = orphans.get(r.cid) || [];
      o.push(`${r.table}.${r.column} ×${r.n}`);
      orphans.set(r.cid, o);
    }
    for (const t of snap.txByAccount.keys()) {
      const [type, cid] = t.split(/:(.*)/s);
      if (type === 'personal' && !snap.playerMap.has(cid)) {
        const o = orphans.get(cid) || [];
        o.push('personal transaction history');
        orphans.set(cid, o);
      }
    }
    for (const [cid, where] of orphans) add({ severity: 'low', code: 'ORPHAN_RECORDS', title: `Records for unknown citizen ${cid}`, detail: where.join(' · '), citizenid: cid });
    for (const a of snap.accounts) {
      const missing = a.auth.filter((c) => !snap.playerMap.has(c));
      if (missing.length) add({ severity: 'low', code: 'ORPHAN_AUTH', title: `Account ${a.id} authorises unknown citizens`, detail: missing.join(', '), account: a.id, accountType: 'shared' });
    }
  }

  // 7. Frozen accounts (informational)
  for (const cid of snap.frozenPersonal) add({ severity: 'info', code: 'FROZEN', title: `Personal account ${cid} is frozen`, detail: snap.playerMap.get(cid)?.name || '', citizenid: cid, account: cid, accountType: 'personal' });
  for (const a of snap.accounts) if (a.frozen) add({ severity: 'info', code: 'FROZEN', title: `Account ${a.id} is frozen`, detail: '', account: a.id, accountType: 'shared' });

  // Stable id per flag, so a flag can be attached to a case as evidence.
  for (const f of flags) f.id = require('crypto').createHash('sha1').update([f.code, f.citizenid, f.account, f.trans_id, f.time, f.title].join('|')).digest('hex').slice(0, 16);

  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount || 0) - (a.amount || 0) || (b.time || 0) - (a.time || 0));
  return flags;
}

// house name -> { house_label, house_price } from the house_locations table(s).
async function houseInfo(names) {
  const out = new Map();
  const wanted = [...new Set(names.filter(Boolean).map(String))];
  if (!wanted.length) return out;
  for (const t of tablesByRole('house_locations')) {
    try {
      const c = await resolveCols(t);
      if (!c.name) continue;
      const sel = [`${db.id(c.name)} AS n`, c.label ? `${db.id(c.label)} AS l` : "'' AS l", c.price ? `${db.id(c.price)} AS p` : "'' AS p"];
      const rows = await db.query(`SELECT ${sel.join(', ')} FROM ${db.id(t.name)} WHERE ${db.id(c.name)} IN (?)`, [wanted]);
      for (const r of rows) out.set(String(r.n), { house_label: r.l, house_price: r.p });
    } catch {}
  }
  return out;
}

// Rows from every non-core configured table that reference this citizen.
async function linkedRows(cid) {
  const sections = [];
  const skip = new Set(['players', 'player_transactions', 'bank_accounts']);
  for (const t of config.get().tables) {
    if (skip.has(t.role) || t.role === 'house_locations') continue;
    let c;
    try {
      c = await resolveCols(t);
    } catch (e) {
      sections.push({ table: t, error: e.message, rows: [], columns: [] });
      continue;
    }
    const where = [];
    const params = [];
    for (const k of ['citizenid', 'owner', 'creator']) {
      if (c[k] && !where.some((w) => w.col === c[k])) {
        where.push({ col: c[k], sql: `${db.id(c[k])} = ?` });
        params.push(cid);
      }
    }
    if (c.keyholders) {
      where.push({ col: c.keyholders, sql: `${db.id(c.keyholders)} LIKE ?` });
      params.push(`%"${cid.replace(/[%_\\"]/g, '')}"%`);
    }
    if (!where.length) continue;
    try {
      const rows = await db.query(`SELECT * FROM ${db.id(t.name)} WHERE ${where.map((w) => w.sql).join(' OR ')} LIMIT 500`, params);
      let columns = c._all;
      if (t.role === 'player_houses' && c.house && rows.length) {
        const info = await houseInfo(rows.map((r) => r[c.house]));
        if (info.size) {
          for (const r of rows) Object.assign(r, info.get(String(r[c.house])) || { house_label: '', house_price: '' });
          columns = [c.house, 'house_label', 'house_price', ...columns.filter((x) => x !== c.house)];
        }
      }
      sections.push({ table: t, cols: c, columns, rows });
    } catch (e) {
      sections.push({ table: t, error: e.message, rows: [], columns: [] });
    }
  }
  return sections;
}

module.exports = { houseInfo, snapshot, invalidate, computeFlags, linkedRows, parseJson, cidForName, resolveCols, normalizeTx };
