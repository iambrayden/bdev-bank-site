// Case files: group citizens, transactions, flags and accounts into an investigation.
const express = require('express');
const audit = require('../audit');
const store = require('../store');
const fmt = require('../format');
const { wrap, need, can, csv, flash, redactText } = require('../web');

const router = express.Router();
const SUBJECT_LABELS = ['suspect', 'associate', 'victim', 'witness', 'subject'];
const EVIDENCE_TYPES = { transaction: 'Transaction', flag: 'Audit flag', account: 'Shared account', note: 'Note', link: 'Link' };

function canView(req, c) {
  if (!c) return false;
  if (can(req, 'cases.view_all')) return true;
  if (!can(req, 'cases.view')) return false;
  const uid = req.user.id;
  return c.created_by === uid || c.assigned_to === uid || store.isCaseMember(c.id, uid);
}

// Loads :id into req.case, 404 if not visible.
function loadCase(req, res, next) {
  const c = store.getCase(Number(req.params.id));
  if (!canView(req, c)) return res.status(404).render('error', { message: 'Case not found.' });
  req.case = c;
  next();
}

// Cases this user can attach evidence to.
function attachableCases(req) {
  if (!can(req, 'cases.edit')) return [];
  return store.listCases({ userId: req.user.id, viewAll: can(req, 'cases.view_all'), status: 'active' });
}

const caseNo = (id) => 'CASE-' + String(id).padStart(4, '0');
const clean = (s, max = 5000) => String(s ?? '').trim().slice(0, max);

function userChoices() {
  return store.listUsers().filter((u) => !u.disabled);
}

// ---------- building evidence from live data ----------
function playerSnapshot(p) {
  if (!p) return {};
  return { name: p.name, bank: p.bank, crypto: p.crypto, job: p.job?.label || p.job?.name || '', license: p.license, at: Math.floor(Date.now() / 1000) };
}

async function buildEvidence(type, q) {
  const s = await audit.snapshot();
  if (type === 'transaction') {
    let list = q.ref ? s.allTx.filter((t) => t.trans_id === q.ref) : [];
    if (!list.length && q.account && q.time) list = s.allTx.filter((t) => t.account === q.account && String(t.time) === String(q.time));
    if (!list.length) return null;
    const first = list[0];
    const records = list.map((t) => ({
      account: t.account,
      accountType: t.accountType,
      owner: t.accountType === 'personal' ? s.playerMap.get(t.account)?.name || '' : '',
      type: t.type,
      amount: t.amount,
      issuer: t.issuer,
      receiver: t.receiver,
      message: t.message,
      title: t.title,
      time: t.time,
    }));
    const amount = Math.max(...list.map((t) => t.amount));
    return {
      type,
      ref: first.trans_id || `${first.account}|${first.time}`,
      title: `${first.type} ${fmt.money(amount)} · ${first.issuer || first.account} → ${first.receiver || first.account}`,
      data: { trans_id: first.trans_id, amount, time: first.time, records },
      // citizens on either side, to offer as subjects
      cids: [...new Set(list.filter((t) => t.accountType === 'personal').map((t) => t.account).concat([s.nameIndex.get(String(first.issuer).toLowerCase())?.[0], s.nameIndex.get(String(first.receiver).toLowerCase())?.[0]]).filter(Boolean))],
    };
  }
  if (type === 'flag') {
    const f = s.flags.find((x) => x.id === q.ref);
    if (!f) return null;
    return { type, ref: f.id, title: `${f.code}: ${f.title}`, data: { ...f }, cids: [f.citizenid, f.accountType === 'personal' ? f.account : null].filter(Boolean) };
  }
  if (type === 'account') {
    const a = s.accounts.find((x) => x.id === q.ref);
    if (!a) return null;
    return { type, ref: a.id, title: `Account ${a.id} · ${fmt.money(a.amount)}`, data: { id: a.id, amount: a.amount, auth: a.auth, creator: a.creator, frozen: a.frozen, txCount: a.txCount, at: Math.floor(Date.now() / 1000) }, cids: [] };
  }
  if (type === 'player') {
    const p = s.playerMap.get(q.ref);
    return { type, ref: q.ref, title: p ? `${p.name} (${q.ref})` : q.ref, data: playerSnapshot(p), cids: [q.ref] };
  }
  return null;
}

async function attach(req, caseId, ev) {
  const s = await audit.snapshot();
  if (ev.type === 'player') {
    const p = s.playerMap.get(ev.ref);
    store.addSubject(caseId, { citizenid: ev.ref, name: p?.name || '', label: SUBJECT_LABELS.includes(req.body.label) ? req.body.label : 'subject', note: clean(req.body.note, 2000), snapshot: playerSnapshot(p) }, req.user.id);
    store.log(req.user, 'case.subject_add', caseNo(caseId), ev.ref, req.ip);
    return;
  }
  if (!store.hasEvidence(caseId, ev.type, ev.ref)) {
    store.addEvidence(caseId, { type: ev.type, ref: ev.ref, title: ev.title, data: ev.data, note: clean(req.body.note, 2000) }, req.user.id);
    store.log(req.user, 'case.evidence_add', caseNo(caseId), `${ev.type}:${ev.ref}`, req.ip);
  }
  // Optionally add the citizens involved as subjects too
  const addCids = [].concat(req.body.add_subject || []).filter((c) => ev.cids.includes(c));
  for (const cid of addCids) {
    const p = s.playerMap.get(cid);
    store.addSubject(caseId, { citizenid: cid, name: p?.name || '', label: 'subject', snapshot: playerSnapshot(p) }, req.user.id);
  }
}

// ---------- list / create ----------
router.get('/', need('cases.view', 'cases.view_all'), (req, res) => {
  const status = req.query.status ?? 'active';
  const list = store.listCases({ userId: req.user.id, viewAll: can(req, 'cases.view_all'), status, q: clean(req.query.q, 100), mine: req.query.mine === '1' });
  res.render('cases', { list, status, STATUSES: store.CASE_STATUSES, caseNo });
});

router.get('/new', need('cases.create'), (req, res) => {
  res.render('case_new', { PRIORITIES: store.CASE_PRIORITIES, users: can(req, 'cases.assign') ? userChoices() : [] });
});

router.post(
  '/',
  need('cases.create'),
  wrap(async (req, res) => {
    const title = clean(req.body.title, 200);
    if (!title) return res.status(400).render('error', { message: 'A case needs a title.' });
    const priority = store.CASE_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';
    const assigned = can(req, 'cases.assign') && req.body.assigned_to ? Number(req.body.assigned_to) : req.user.id;
    const id = store.createCase({ title, summary: clean(req.body.summary), priority, created_by: req.user.id, assigned_to: assigned });
    store.addNote(id, req.user.id, `Case opened by ${req.user.username}.`, 'system');
    store.log(req.user, 'case.create', caseNo(id), title, req.ip);
    // Created from an "add to case" form: attach the item straight away
    if (req.body.attach_type && req.body.attach_ref) {
      const ev = await buildEvidence(req.body.attach_type, { ref: req.body.attach_ref, account: req.body.attach_account, time: req.body.attach_time });
      if (ev) await attach(req, id, ev);
    }
    res.redirect(`/cases/${id}`);
  })
);

// ---------- "add to case" from anywhere ----------
router.get(
  '/attach',
  need('cases.edit', 'cases.create'),
  wrap(async (req, res) => {
    const type = String(req.query.type || '');
    const ev = await buildEvidence(type, req.query);
    if (!ev) return res.status(404).render('error', { message: 'That item could not be found in the current data. It may have rotated out of the transaction history.' });
    const s = await audit.snapshot();
    res.render('case_attach', { ev, s, cases: attachableCases(req), q: req.query, SUBJECT_LABELS, EVIDENCE_TYPES, caseNo, PRIORITIES: store.CASE_PRIORITIES });
  })
);

router.post(
  '/attach',
  need('cases.edit'),
  wrap(async (req, res) => {
    const c = store.getCase(Number(req.body.case_id));
    if (!canView(req, c)) return res.status(404).render('error', { message: 'Case not found.' });
    const ev = await buildEvidence(String(req.body.type), { ref: req.body.ref, account: req.body.account, time: req.body.time });
    if (!ev) return res.status(404).render('error', { message: 'That item could not be found in the current data.' });
    await attach(req, c.id, ev);
    flash(res, `/cases/${c.id}`, 'Added to case.');
  })
);

// ---------- single case ----------
router.get(
  '/:id',
  loadCase,
  wrap(async (req, res) => {
    const c = req.case;
    let s = null;
    try {
      s = await audit.snapshot();
    } catch {
      s = null; // case files still work if the game DB is down
    }
    const evidence = store.caseEvidence(c.id);
    const txTotal = evidence.filter((e) => e.type === 'transaction').reduce((a, e) => a + (Number(e.data.amount) || 0), 0);
    store.log(req.user, 'case.view', caseNo(c.id), '', req.ip);
    res.render('case', {
      c,
      s,
      caseNo,
      subjects: store.caseSubjects(c.id),
      evidence,
      notes: store.caseNotes(c.id),
      members: store.caseMembers(c.id),
      users: can(req, 'cases.assign') ? userChoices() : [],
      txTotal,
      canEdit: can(req, 'cases.edit'),
      STATUSES: store.CASE_STATUSES,
      PRIORITIES: store.CASE_PRIORITIES,
      SUBJECT_LABELS,
      EVIDENCE_TYPES,
      msg: req.query.msg || null,
    });
  })
);

router.get('/:id/print', loadCase, (req, res) => {
  const c = req.case;
  store.log(req.user, 'case.print', caseNo(c.id), '', req.ip);
  res.render('case_print', { c, caseNo, subjects: store.caseSubjects(c.id), evidence: store.caseEvidence(c.id), notes: store.caseNotes(c.id), members: store.caseMembers(c.id), EVIDENCE_TYPES, printedAt: Math.floor(Date.now() / 1000) });
});

router.get('/:id/evidence.csv', loadCase, need('export.csv'), (req, res) => {
  const c = req.case;
  const showMoney = can(req, 'money.view');
  const rows = [];
  for (const e of store.caseEvidence(c.id)) {
    if (e.type === 'transaction') {
      for (const r of e.data.records || []) rows.push([e.id, e.type, e.data.trans_id, fmt.date(r.time), r.accountType, r.account, r.owner, r.type, showMoney ? r.amount : '', r.issuer, r.receiver, showMoney ? r.message : redactText(r.message), e.note, e.added_by_name, fmt.date(e.added_at)]);
    } else {
      rows.push([e.id, e.type, e.ref, e.data.time ? fmt.date(e.data.time) : '', '', e.data.account || e.data.id || '', '', e.data.code || '', showMoney ? e.data.amount ?? '' : '', '', '', showMoney ? e.title : redactText(e.title), e.note, e.added_by_name, fmt.date(e.added_at)]);
    }
  }
  csv(req, res, `${caseNo(c.id)}-evidence.csv`, ['evidence_id', 'type', 'ref', 'time', 'account_type', 'account', 'owner', 'tx_type', 'amount', 'issuer', 'receiver', 'message', 'note', 'added_by', 'added_at'], rows);
});

router.post('/:id/edit', loadCase, need('cases.edit'), (req, res) => {
  const title = clean(req.body.title, 200) || req.case.title;
  store.updateCase(req.case.id, { title, summary: clean(req.body.summary), outcome: clean(req.body.outcome) });
  store.log(req.user, 'case.edit', caseNo(req.case.id), '', req.ip);
  flash(res, `/cases/${req.case.id}`, 'Case updated.');
});

router.post('/:id/status', loadCase, need('cases.status'), (req, res) => {
  const c = req.case;
  const status = store.CASE_STATUSES.includes(req.body.status) ? req.body.status : c.status;
  const priority = store.CASE_PRIORITIES.includes(req.body.priority) ? req.body.priority : c.priority;
  const changes = [];
  if (status !== c.status) changes.push(`status ${c.status} → ${status}`);
  if (priority !== c.priority) changes.push(`priority ${c.priority} → ${priority}`);
  if (changes.length) {
    store.updateCase(c.id, { status, priority, closed_at: status === 'closed' ? Math.floor(Date.now() / 1000) : null });
    store.addNote(c.id, req.user.id, `${req.user.username} changed ${changes.join(', ')}.`, 'system');
    store.log(req.user, 'case.status', caseNo(c.id), changes.join(', '), req.ip);
  }
  flash(res, `/cases/${c.id}`, 'Status updated.');
});

router.post('/:id/assign', loadCase, need('cases.assign'), (req, res) => {
  const c = req.case;
  const valid = new Set(userChoices().map((u) => u.id));
  const assigned = valid.has(Number(req.body.assigned_to)) ? Number(req.body.assigned_to) : null;
  const members = [].concat(req.body.members || []).map(Number).filter((id) => valid.has(id));
  if (assigned !== c.assigned_to) {
    store.updateCase(c.id, { assigned_to: assigned });
    store.addNote(c.id, req.user.id, `${req.user.username} assigned the case to ${assigned ? store.getUser(assigned).username : 'nobody'}.`, 'system');
  }
  store.setCaseMembers(c.id, members);
  store.log(req.user, 'case.assign', caseNo(c.id), `assigned=${assigned} members=${members.join(',')}`, req.ip);
  flash(res, `/cases/${c.id}`, 'Assignment updated.');
});

router.post(
  '/:id/subjects',
  loadCase,
  need('cases.edit'),
  wrap(async (req, res) => {
    const cid = clean(req.body.citizenid, 60);
    if (!cid) return flash(res, `/cases/${req.case.id}`, 'Enter a citizenid.');
    await attach(req, req.case.id, { type: 'player', ref: cid, cids: [cid] });
    flash(res, `/cases/${req.case.id}`, 'Citizen added.');
  })
);

router.post('/:id/subjects/:sid/delete', loadCase, need('cases.edit'), (req, res) => {
  store.removeSubject(req.case.id, Number(req.params.sid));
  store.log(req.user, 'case.subject_remove', caseNo(req.case.id), req.params.sid, req.ip);
  flash(res, `/cases/${req.case.id}`, 'Citizen removed.');
});

router.post('/:id/evidence', loadCase, need('cases.edit'), (req, res) => {
  const type = req.body.type === 'link' ? 'link' : 'note';
  const title = clean(req.body.title, 200);
  const url = clean(req.body.url, 1000);
  if (!title) return flash(res, `/cases/${req.case.id}`, 'Evidence needs a title.');
  if (type === 'link' && !/^https?:\/\//i.test(url)) return flash(res, `/cases/${req.case.id}`, 'Links must start with http:// or https://');
  store.addEvidence(req.case.id, { type, ref: url, title, data: { url, body: clean(req.body.body) }, note: '' }, req.user.id);
  store.log(req.user, 'case.evidence_add', caseNo(req.case.id), `${type}:${title}`, req.ip);
  flash(res, `/cases/${req.case.id}`, 'Evidence added.');
});

router.post('/:id/evidence/:eid/note', loadCase, need('cases.edit'), (req, res) => {
  store.updateEvidenceNote(req.case.id, Number(req.params.eid), clean(req.body.note, 2000));
  flash(res, `/cases/${req.case.id}#ev${req.params.eid}`, 'Note saved.');
});

router.post('/:id/evidence/:eid/delete', loadCase, need('cases.edit'), (req, res) => {
  const e = store.getEvidence(req.case.id, Number(req.params.eid));
  if (!e) return flash(res, `/cases/${req.case.id}`, 'Evidence not found.');
  if (e.added_by !== req.user.id && !can(req, 'cases.delete')) return res.status(403).render('error', { message: 'You can only remove evidence you added.' });
  store.removeEvidence(req.case.id, e.id);
  store.log(req.user, 'case.evidence_remove', caseNo(req.case.id), `${e.type}:${e.ref}`, req.ip);
  flash(res, `/cases/${req.case.id}`, 'Evidence removed.');
});

router.post('/:id/notes', loadCase, need('cases.comment'), (req, res) => {
  const body = clean(req.body.body, 10000);
  if (body) {
    store.addNote(req.case.id, req.user.id, body);
    store.log(req.user, 'case.note', caseNo(req.case.id), body.slice(0, 80), req.ip);
  }
  res.redirect(`/cases/${req.case.id}#notes`);
});

router.post('/:id/notes/:nid/delete', loadCase, (req, res) => {
  const n = store.getNote(req.case.id, Number(req.params.nid));
  if (!n || n.kind === 'system') return flash(res, `/cases/${req.case.id}`, 'Note not found.');
  if (n.user_id !== req.user.id && !can(req, 'cases.delete')) return res.status(403).render('error', { message: 'You can only delete your own notes.' });
  store.removeNote(req.case.id, n.id);
  store.log(req.user, 'case.note_remove', caseNo(req.case.id), String(n.id), req.ip);
  res.redirect(`/cases/${req.case.id}#notes`);
});

router.post('/:id/delete', loadCase, need('cases.delete'), (req, res) => {
  store.deleteCase(req.case.id);
  store.log(req.user, 'case.delete', caseNo(req.case.id), req.case.title, req.ip);
  res.redirect('/cases?msg=' + encodeURIComponent('Case deleted.'));
});

module.exports = { router, caseNo };
