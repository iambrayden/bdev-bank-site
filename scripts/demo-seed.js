// Generates a demo Qbox-style database (fictional data) for local development:
//   node scripts/demo-seed.js | mysql
const now = Math.floor(Date.now() / 1000);
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const J = (o) => q(JSON.stringify(o));
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const cid = () => Array.from({ length: 8 }, () => pick('ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')).join('');

const first = ['Alex', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie', 'Quinn', 'Avery', 'Parker', 'Drew', 'Rowan', 'Skyler', 'Reese', 'Emerson'];
const last = ['Stone', 'Rivers', 'Hale', 'Brooks', 'Vance', 'Mercer', 'Cole', 'Frost', 'Lane', 'Wilder', 'Pike', 'Reyes'];
const jobs = [['police', 'LSPD'], ['bcso', 'BCSO'], ['ambulance', 'EMS'], ['mechanic', 'Mechanic'], ['unemployed', 'Civilian'], ['realestate', 'Real Estate'], ['bus', 'Bus Driver']];
const licenses = Array.from({ length: 12 }, (_, i) => 'license2:' + (i + 1).toString(16).padStart(40, 'a'));

const players = [];
for (let i = 0; i < 30; i++) {
  const [jn, jl] = pick(jobs);
  players.push({ cid: cid(), license: licenses[i % 12], acct: 'user' + (i % 12), first: pick(first), last: pick(last) + (i > 14 ? i : ''), job: jn, jobLabel: jl, grade: Math.floor(rnd() * 5), cash: Math.floor(rnd() * 20000), bank: Math.floor(rnd() * 200000) });
}
players[0].bank = 4500000; // rich
players[1].bank = -250; // negative
const out = [];
out.push('DROP DATABASE IF EXISTS qbox_demo; CREATE DATABASE qbox_demo CHARACTER SET utf8mb4; USE qbox_demo;');
out.push(`CREATE TABLE players (id INT AUTO_INCREMENT PRIMARY KEY, citizenid VARCHAR(50) UNIQUE, cid INT, license VARCHAR(255), name VARCHAR(255), money TEXT, charinfo TEXT, job TEXT, gang TEXT, position TEXT, metadata TEXT, inventory LONGTEXT, last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
out.push(`CREATE TABLE player_transactions (id VARCHAR(50) PRIMARY KEY, isFrozen INT DEFAULT 0, transactions LONGTEXT);`);
out.push(`CREATE TABLE bank_accounts_new (id VARCHAR(50) PRIMARY KEY, amount BIGINT DEFAULT 0, transactions LONGTEXT, auth LONGTEXT, isFrozen INT DEFAULT 0, creator VARCHAR(50));`);
out.push(`CREATE TABLE house_bills (id INT AUTO_INCREMENT PRIMARY KEY, house VARCHAR(50), payed_by VARCHAR(50), total INT, breakdown TEXT, payed TINYINT, date DATETIME);`);
out.push(`CREATE TABLE houselocations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) UNIQUE, label VARCHAR(255), coords TEXT, owned TINYINT, price INT, defaultPrice INT, tier INT, garage TEXT, creator VARCHAR(50));`);
out.push(`CREATE TABLE player_houses (id INT AUTO_INCREMENT PRIMARY KEY, house VARCHAR(50), citizenid VARCHAR(50), owner VARCHAR(50), keyholders TEXT, stash TEXT);`);
out.push(`CREATE TABLE player_vehicles (id INT AUTO_INCREMENT PRIMARY KEY, license VARCHAR(255), citizenid VARCHAR(50), vehicle VARCHAR(50), hash VARCHAR(50), mods LONGTEXT, plate VARCHAR(15), garage VARCHAR(50), fuel INT, engine FLOAT, body FLOAT, state INT, garage_id VARCHAR(50), financed INT DEFAULT 0, mileage FLOAT DEFAULT 0, balance INT DEFAULT 0, paymentamount INT DEFAULT 0, paymentsleft INT DEFAULT 0, financetime INT DEFAULT 0);`);
out.push('CREATE TABLE player_groups (citizenid VARCHAR(50), `group` VARCHAR(50), type VARCHAR(50), grade INT, PRIMARY KEY (citizenid, `group`, type));');
out.push(`CREATE TABLE player_jobs_activity (id INT AUTO_INCREMENT PRIMARY KEY, citizenid VARCHAR(50), job VARCHAR(50), last_checkin INT, last_checkout INT);`);

for (const p of players) {
  out.push(`INSERT INTO players (citizenid, cid, license, name, money, charinfo, job, gang) VALUES (${q(p.cid)}, 1, ${q(p.license)}, ${q(p.acct)}, ${J({ cash: p.cash, bank: p.bank, crypto: 0 })}, ${J({ firstname: p.first, lastname: p.last, phone: '555' + Math.floor(rnd() * 9999999), birthdate: '1990-01-01' })}, ${J({ name: p.job, label: p.jobLabel, onduty: rnd() > 0.5, grade: { level: p.grade, name: 'Grade ' + p.grade } })}, ${J({ name: 'none', label: 'No Gang' })});`);
  out.push(`INSERT INTO player_groups VALUES (${q(p.cid)}, ${q(p.job)}, 'job', ${p.grade});`);
  out.push(`INSERT INTO player_jobs_activity (citizenid, job, last_checkin, last_checkout) VALUES (${q(p.cid)}, ${q(p.job)}, ${now - 7200}, ${now - 3600});`);
}
const nm = (p) => `${p.first} ${p.last}`;
const ptx = new Map(players.map((p) => [p.cid, []]));
let tid = 1;
const uuid = () => `${(tid++).toString(16).padStart(8, '0')}-7aa5-44c0-8394-48950774b680`;
for (let i = 0; i < 400; i++) {
  const a = pick(players);
  const t = now - Math.floor(rnd() * 20 * 86400);
  const amount = Math.floor(rnd() * (rnd() > 0.95 ? 400000 : 8000)) + 10;
  if (rnd() > 0.5) {
    const b = pick(players);
    if (b === a) continue;
    const id = uuid();
    ptx.get(a.cid).push({ trans_id: id, title: `Personal Account / ${a.cid}`, amount, trans_type: 'withdraw', receiver: nm(b), issuer: nm(a), message: 'Transfer', time: t });
    ptx.get(b.cid).push({ trans_id: id, title: `Personal Account / ${b.cid}`, amount, trans_type: 'deposit', receiver: nm(b), issuer: nm(a), message: 'Transfer', time: t });
  } else {
    const type = pick(['deposit', 'withdraw']);
    ptx.get(a.cid).push({ trans_id: uuid(), title: `Personal Account / ${a.cid}`, amount, trans_type: type, receiver: nm(a), issuer: nm(a), message: `${nm(a)} has ${type === 'deposit' ? 'deposited' : 'withdrawed'} $${amount}`, time: t });
  }
}
// Suspicious patterns
const [r0, r2] = [players[0], players[2]];
for (let i = 0; i < 14; i++) ptx.get(r0.cid).push({ trans_id: uuid(), title: `Personal Account / ${r0.cid}`, amount: 5000, trans_type: 'deposit', receiver: nm(r0), issuer: 'Unknown', message: 'ATM deposit', time: now - 3600 + i * 20 });
const alt = players[12]; // same license as players[0]
for (let i = 0; i < 6; i++) {
  const id = uuid();
  ptx.get(alt.cid).push({ trans_id: id, title: `Personal Account / ${alt.cid}`, amount: 150000, trans_type: 'withdraw', receiver: nm(r0), issuer: nm(alt), message: 'gift', time: now - 86400 * i });
  ptx.get(r0.cid).push({ trans_id: id, title: `Personal Account / ${r0.cid}`, amount: i === 3 ? 1500000 : 150000, trans_type: 'deposit', receiver: nm(r0), issuer: nm(alt), message: 'gift', time: now - 86400 * i });
}
ptx.set('DELETED01', [{ trans_id: uuid(), title: 'Personal Account / DELETED01', amount: 1000, trans_type: 'deposit', receiver: 'Ghost', issuer: 'Ghost', message: 'x', time: now - 500 }]);
for (const [c, list] of ptx) out.push(`INSERT INTO player_transactions VALUES (${q(c)}, ${c === r2.cid ? 1 : 0}, ${J(list.sort((a, b) => b.time - a.time))});`);

const accts = [['bcso', 6038401], ['ambulance', 145000], ['police', 24000], ['mechanic', 6000], ['government', 74754], ['marinamotors', 6164548], ['ballas', 0], ['bus', 0]];
for (const [id, amount] of accts) {
  const list = Array.from({ length: Math.floor(rnd() * 25) }, () => {
    const p = pick(players);
    const type = pick(['deposit', 'withdraw']);
    return { trans_id: uuid(), title: id, amount: Math.floor(rnd() * 50000), trans_type: type, receiver: id, issuer: nm(p), message: `${nm(p)} ${type}`, time: now - Math.floor(rnd() * 15 * 86400) };
  });
  out.push(`INSERT INTO bank_accounts_new VALUES (${q(id)}, ${amount}, ${J(list)}, '[]', 0, NULL);`);
}
out.push(`INSERT INTO bank_accounts_new VALUES ('12', 0, '[]', ${J([players[3].cid])}, 0, ${q(players[3].cid)});`);
out.push(`INSERT INTO bank_accounts_new VALUES ('28', 2500, '[]', ${J([players[4].cid, 'GONE0000'])}, 0, ${q(players[4].cid)});`);

const houses = ['clubhouse', 'sandy_1016', 'jay', 'pb_4', 'harry_955'];
houses.forEach((h, i) => {
  const o = players[i + 5];
  out.push(`INSERT INTO houselocations (name, label, coords, owned, price, defaultPrice, tier, garage, creator) VALUES (${q(h)}, 'Street ${i}', '{}', NULL, ${5000 * (i + 1)}, ${5000 * (i + 1)}, 0, '{}', ${q(players[6].cid)});`);
  out.push(`INSERT INTO player_houses (house, citizenid, owner, keyholders) VALUES (${q(h)}, ${q(o.cid)}, ${q(o.cid)}, ${J([o.cid, players[0].cid])});`);
  for (let k = 0; k < 6; k++) {
    const e = Math.floor(rnd() * 100), n = Math.floor(rnd() * 300), w = Math.floor(rnd() * 150);
    out.push(`INSERT INTO house_bills (house, payed_by, total, breakdown, payed, date) VALUES (${q(h)}, ${q(o.cid)}, ${e + n + w}, ${J({ electricity: e, internet: n, water: w })}, ${k < 4 ? 1 : 0}, NOW() - INTERVAL ${k} HOUR);`);
  }
});
out.push(`INSERT INTO player_houses (house, citizenid, owner, keyholders) VALUES ('ghost_house', 'GONE0000', 'GONE0000', '["GONE0000"]');`);
let fin = 0;
for (let i = 0; i < 60; i++) {
  const p = pick(players);
  out.push(`INSERT INTO player_vehicles (license, citizenid, vehicle, hash, mods, plate, garage, fuel, engine, body, state, garage_id, financed, mileage, balance, paymentamount, paymentsleft, financetime) VALUES (${q(p.license)}, ${q(p.cid)}, ${q(pick(['sultan', 'thauler', 'dominator', 'skyline']))}, '123', '{}', ${q(cid())}, NULL, 65, 1000, 1000, 1, ${q(pick(['Sandy North', 'Legion Square', 'Marina Drive']))}, ${(fin = rnd() > 0.6 ? 1 : 0)}, ${Math.floor(rnd() * 5000)}, ${fin ? 20000 + Math.floor(rnd() * 80000) : 0}, ${fin ? 2500 : 0}, ${fin ? 1 + Math.floor(rnd() * 20) : 0}, ${fin ? Math.floor(rnd() * 1440) : 0});`);
}
console.log(out.join('\n'));
