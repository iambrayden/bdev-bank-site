const test = require('node:test');
const assert = require('node:assert');
process.env.ADMIN_PASSWORD = 'bootstrap-pass';
const store = require('../src/store');
const perms = require('../src/perms');

store.init(':memory:');

test('bootstraps a superadmin and default roles', () => {
  const admin = store.getUserByName('admin');
  assert.ok(admin && admin.is_superadmin);
  assert.ok(store.verifyPassword('bootstrap-pass', admin.password_hash));
  assert.deepEqual(store.listRoles().map((r) => r.name).sort(), ['Administrator', 'Investigator', 'Viewer']);
});

test('effective permissions = role + allow - deny', () => {
  const viewer = store.listRoles().find((r) => r.name === 'Viewer');
  const id = store.createUser({ username: 'v1', password: 'x'.repeat(10), role_id: viewer.id, allow: ['export.csv'], deny: ['money.view'] });
  const eff = perms.effective(store.getUser(id));
  assert.ok(eff.has('players.view'));
  assert.ok(eff.has('export.csv'));
  assert.ok(!eff.has('money.view'));
  assert.ok(!eff.has('admin.users'));
});

test('sessions are revoked when a user is disabled', () => {
  const id = store.createUser({ username: 'v2', password: 'y'.repeat(10) });
  const token = store.createSession(id, 1, '127.0.0.1', 'test');
  assert.equal(store.sessionUser(token).id, id);
  const u = store.getUser(id);
  store.updateUser(id, { ...u, disabled: true });
  assert.equal(store.sessionUser(token), null);
});

test('case visibility follows creator / assignee / members', () => {
  const a = store.createUser({ username: 'inv', password: 'z'.repeat(10) });
  const b = store.createUser({ username: 'other', password: 'z'.repeat(10) });
  const c = store.createCase({ title: 'Dupe glitch', created_by: a, assigned_to: a });
  assert.equal(store.listCases({ userId: b, viewAll: false }).length, 0);
  store.setCaseMembers(c, [b]);
  assert.equal(store.listCases({ userId: b, viewAll: false }).length, 1);
  store.addEvidence(c, { type: 'transaction', ref: 't1', title: 'x', data: { amount: 5 } }, a);
  assert.ok(store.hasEvidence(c, 'transaction', 't1'));
  store.addSubject(c, { citizenid: 'ABC', name: 'A' }, a);
  store.addSubject(c, { citizenid: 'ABC', name: 'A', label: 'suspect' }, a); // upsert
  assert.equal(store.caseSubjects(c).length, 1);
  assert.equal(store.caseSubjects(c)[0].label, 'suspect');
});
