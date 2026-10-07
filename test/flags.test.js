const test = require('node:test');
const assert = require('node:assert');
const { computeFlags, normalizeTx } = require('../src/audit');
const { DEFAULT_THRESHOLDS } = require('../src/config');

function snap(players, txs, accounts = []) {
  const playerMap = new Map(players.map((p) => [p.citizenid, p]));
  const nameIndex = new Map(players.map((p) => [p.name.toLowerCase(), [p.citizenid]]));
  const allTx = txs.sort((a, b) => b.time - a.time);
  const txByAccount = new Map();
  for (const t of allTx) {
    const k = `${t.accountType}:${t.account}`;
    if (!txByAccount.has(k)) txByAccount.set(k, []);
    txByAccount.get(k).push(t);
  }
  return { players, playerMap, nameIndex, allTx, txByAccount, accounts, refs: [], frozenPersonal: new Set() };
}
const P = (citizenid, name, license, bank = 0) => ({ citizenid, name, license, bank, crypto: 0 });
const now = Math.floor(Date.now() / 1000);

test('normalizes Renewed-Banking transactions', () => {
  const t = normalizeTx({ trans_id: 'x', amount: '5000', trans_type: 'withdraw', time: now * 1000 }, 'A', 'personal');
  assert.equal(t.amount, 5000);
  assert.equal(t.signed, -5000);
  assert.equal(t.time, now);
});

test('flags large transfers once, alt transfers and mismatched ids', () => {
  const ps = [P('A', 'Ann Lee', 'lic1'), P('B', 'Bob Ray', 'lic1'), P('C', 'Cy Fox', 'lic2', 2e6)];
  const tx = [
    normalizeTx({ trans_id: 't1', amount: 200000, trans_type: 'withdraw', issuer: 'Ann Lee', receiver: 'Bob Ray', time: now }, 'A', 'personal'),
    normalizeTx({ trans_id: 't1', amount: 200000, trans_type: 'deposit', issuer: 'Ann Lee', receiver: 'Bob Ray', time: now }, 'B', 'personal'),
    normalizeTx({ trans_id: 't2', amount: 10, trans_type: 'withdraw', issuer: 'Cy Fox', receiver: 'Ann Lee', time: now }, 'C', 'personal'),
    normalizeTx({ trans_id: 't2', amount: 9999, trans_type: 'deposit', issuer: 'Cy Fox', receiver: 'Ann Lee', time: now }, 'A', 'personal'),
  ];
  const flags = computeFlags(snap(ps, tx), DEFAULT_THRESHOLDS);
  const codes = flags.map((f) => f.code);
  assert.equal(codes.filter((c) => c === 'LARGE_TX').length, 1);
  assert.equal(codes.filter((c) => c === 'ALT_TRANSFER').length, 1);
  assert.ok(codes.includes('TRANS_ID_MISMATCH'));
  assert.ok(codes.includes('HIGH_BALANCE'));
});

test('flags bursts', () => {
  const ps = [P('A', 'Ann Lee', 'lic1')];
  const tx = Array.from({ length: 12 }, (_, i) => normalizeTx({ trans_id: 'b' + i, amount: 100, trans_type: 'deposit', time: now - i * 30 }, 'A', 'personal'));
  const flags = computeFlags(snap(ps, tx), DEFAULT_THRESHOLDS);
  assert.ok(flags.some((f) => f.code === 'BURST' && f.citizenid === 'A'));
});
