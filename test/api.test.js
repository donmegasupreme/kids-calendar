// Tests run the real apps-script/Code.gs (built from core + gas layer) against
// fake Google services, through doPost, just as the app calls it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGas, FakeSpreadsheet } from './fake-google.js';

const g = loadGas();
const { post, ctx, ss, sent } = g;
let A, B, key;

test('install makes the tabs, a setup key and the email trigger, once', () => {
  key = ctx.install();
  assert.match(key, /^[A-Z2-9]{10}$/);
  assert.equal(ctx.install(), key);
  assert.deepEqual(g.triggers, ['sendChangeEmails']);
  for (const t of ['Settings', 'People', 'Kids', 'Overrides', 'Events', 'Activity', 'EmailQueue']) assert.ok(ss.getSheetByName(t), t);
});

test('date helpers (no time zone shifts, no Intl needed)', () => {
  assert.equal(ctx.coreAddDays('2026-12-31', 1), '2027-01-01');
  assert.equal(ctx.coreAddDays('2026-04-05', 1), '2026-04-06');
  assert.equal(ctx.corePrettyDate('2026-11-28'), 'Sat 28 Nov');
  assert.ok(ctx.coreIsDate('2028-02-29'));
  assert.ok(!ctx.coreIsDate('2027-02-29'));
});

test('setup needs the key, gives two codes, then is closed', () => {
  assert.deepEqual(post({ action: 'status' }), { setUp: false, needsSetupKey: true });
  const base = { action: 'setup', familyName: 'Test kids', you: { name: 'Alex', email: 'alex@example.com' },
    other: { name: 'Sam', email: 'sam@example.com' }, kids: ['Mia', 'Leo', ' '], appUrl: 'https://x.github.io/kids-calendar/' };
  assert.equal(post({ ...base, setupKey: 'WRONG' }).status, 403);
  assert.equal(post({ ...base }).status, 403);
  const r = post({ ...base, setupKey: key.toLowerCase() });
  assert.match(r.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  A = r.code; B = r.otherCode;
  assert.notEqual(A, B);
  assert.equal(post({ ...base, setupKey: key }).status, 409);
  assert.equal(post({ action: 'status' }).setUp, true);
});

test('codes: wrong one rejected; works without dash or in lower case', () => {
  assert.equal(post({ action: 'state' }).status, 401);
  assert.equal(post({ action: 'state', code: 'ZZZZ-ZZZZ' }).status, 401);
  const s = post({ action: 'state', code: B.replace('-', ' ').toLowerCase() });
  assert.equal(s.people.length, 2);
  assert.deepEqual(s.kids.map((k) => k.name), ['Mia', 'Leo']);
  assert.equal(s.people.find((p) => p.id === s.me).name, 'Sam');
});

test('Sheet keeps dates and times as text, and data survives a reload', () => {
  post({ action: 'addEvent', code: A, title: 'Check', date: '2026-01-05', start_time: '08:05' });
  const ev = ss.getSheetByName('Events').data[1];
  assert.equal(ev[1], '2026-01-05');
  assert.equal(ev[2], '08:05');
  // A fresh script instance reading the same Sheet sees the same data.
  const again = loadGas({ ss });
  const s = again.post({ action: 'state', code: A });
  assert.equal(s.events.at(-1).title, 'Check');
  assert.equal(s.events.at(-1).start_time, '08:05');
  post({ action: 'deleteEvent', code: A, id: s.events.at(-1).id });
});

test('text that looks like a formula or starts with an apostrophe survives the Sheet', () => {
  const r = post({ action: 'addEvent', code: A, title: '=1+1', date: '2026-02-02', notes: '+64 21 555', location: "'quoted" });
  const id = r.events.find((e) => e.title === '=1+1').id;
  const back = loadGas({ ss }).post({ action: 'state', code: A }).events.find((e) => e.id === id);
  assert.equal(back.title, '=1+1');
  assert.equal(back.notes, '+64 21 555');
  assert.equal(back.location, "'quoted");
  post({ action: 'deleteEvent', code: A, id });
});

test('usual schedule and swaps', () => {
  const st = post({ action: 'state', code: A });
  const [alex, sam] = st.people;
  const cycle = [...Array(7).fill(alex.id), ...Array(7).fill(sam.id)];
  let r = post({ action: 'pattern', code: A, start: '2026-11-23', cycle });
  assert.deepEqual(r.family.pattern, { start: '2026-11-23', cycle });
  r = post({ action: 'custody', code: A, from: '2026-12-24', to: '2026-12-26', person_id: sam.id, note: 'Christmas' });
  assert.equal(r.overrides.length, 3);
  assert.equal(r.overrides[0].note, 'Christmas');
  r = post({ action: 'custody', code: A, from: '2026-12-26', to: '2026-12-26', person_id: null });
  assert.deepEqual(r.overrides.map((o) => o.date), ['2026-12-24', '2026-12-25']);
  assert.equal(post({ action: 'custody', code: A, from: '2026-12-26', to: '2026-12-20', person_id: sam.id }).status, 400);
  assert.equal(post({ action: 'custody', code: A, from: '2026-02-30', to: '2026-03-01', person_id: sam.id }).status, 400);
  assert.equal(post({ action: 'pattern', code: A, start: '2026-11-23', cycle: Array(29).fill(alex.id) }).status, 400);
  // A failed request changes nothing in the Sheet.
  assert.equal(loadGas({ ss }).post({ action: 'state', code: A }).overrides.length, 2);
});

test('events: add, move, delete, and bad input', () => {
  const mia = post({ action: 'state', code: A }).kids[0];
  let r = post({ action: 'addEvent', code: A, title: 'Netball', date: '2026-11-28', start_time: '09:00', end_time: '10:30', kid_ids: [mia.id, 999] });
  const ev = r.events.find((e) => e.title === 'Netball');
  assert.deepEqual(ev.kid_ids, [mia.id]);
  assert.equal(r.activity[0].summary, 'Added "Netball" on Sat 28 Nov at 9:00am for Mia');
  r = post({ ...ev, action: 'updateEvent', code: B, date: '2026-11-29', start_time: '10:00', end_time: '' });
  assert.equal(r.activity[0].summary, 'Moved "Netball" from Sat 28 Nov 9:00am to Sun 29 Nov at 10:00am');
  assert.equal(r.activity[0].person, 'Sam');
  assert.equal(post({ action: 'addEvent', code: A, title: '', date: '2026-11-28' }).status, 400);
  assert.equal(post({ action: 'addEvent', code: A, title: 'X', date: '2026-11-28', start_time: '10:00', end_time: '09:00' }).status, 400);
  assert.equal(post({ action: 'addEvent', code: A, title: 'X', date: 'soon' }).status, 400);
  r = post({ action: 'deleteEvent', code: A, id: ev.id });
  assert.equal(r.events.length, 0);
  assert.equal(post({ action: 'deleteEvent', code: A, id: ev.id }).status, 404);
  assert.equal(post({ action: 'nonsense', code: A }).status, 404);
});

test('people: only you can switch off or change your own emails', () => {
  const sam = post({ action: 'state', code: A }).people[1];
  assert.equal(post({ action: 'updatePerson', code: A, id: sam.id, notify: false }).people[1].notify, true);
  assert.equal(post({ action: 'updatePerson', code: A, id: sam.id, email: 'not-an-email' }).status, 400);
  assert.equal(post({ action: 'updatePerson', code: A, id: sam.id, email: '' }).status, 403);
  assert.equal(post({ action: 'updatePerson', code: A, id: sam.id, email: 'x@example.com' }).status, 403);
  assert.equal(post({ action: 'updatePerson', code: B, id: sam.id, email: 'sam2@example.com' }).people[1].email, 'sam2@example.com');
  post({ action: 'updatePerson', code: B, id: sam.id, email: 'sam@example.com' });
  const nana = post({ action: 'addPerson', code: A, name: 'Nana' }).people.find((p) => p.name === 'Nana');
  assert.equal(post({ action: 'updatePerson', code: A, id: nana.id, email: 'nana@example.com' }).people.at(-1).email, 'nana@example.com');
});

test('emails: one per person after a quiet spell, never to the person who changed it', () => {
  ss.getSheetByName('EmailQueue').data = [];
  sent.length = 0;
  // Nana has an email now but turns hers off so this check is about Sam.
  const nanaCode = post({ action: 'state', code: A }).people.find((p) => p.name === 'Nana').code;
  const nanaId = post({ action: 'state', code: nanaCode }).me;
  post({ action: 'updatePerson', code: nanaCode, id: nanaId, notify: false });
  ss.getSheetByName('EmailQueue').data = [];

  post({ action: 'addEvent', code: A, title: 'School play', date: '2026-12-03', start_time: '18:30' });
  post({ action: 'addEvent', code: A, title: 'Dentist', date: '2026-12-04' });
  ctx.sendChangeEmails(); // too soon: still within the quiet spell
  assert.equal(sent.length, 0);

  // Age the queue past the quiet spell.
  const q = ss.getSheetByName('EmailQueue').data;
  for (let i = 1; i < q.length; i++) q[i][4] = String(Date.now() - 10 * 60000);
  ctx.sendChangeEmails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'sam@example.com');
  assert.match(sent[0].subject, /Alex made 2 changes/);
  assert.match(sent[0].body, /School play" on Thu 3 Dec at 6:30pm/);
  assert.match(sent[0].body, /Open the calendar: https:\/\/x\.github\.io\/kids-calendar\//);
  assert.equal(ss.getSheetByName('EmailQueue').data.length, 1); // header only
  ctx.sendChangeEmails();
  assert.equal(sent.length, 1);
});

test('a failed email stays queued and is retried', () => {
  const failing = loadGas({ ss, mailer: () => { throw new Error('quota'); } });
  failing.post({ action: 'addEvent', code: B, title: 'Party', date: '2026-12-06' });
  const q = ss.getSheetByName('EmailQueue').data;
  for (let i = 1; i < q.length; i++) q[i][4] = String(Date.now() - 10 * 60000);
  failing.ctx.sendChangeEmails();
  assert.equal(ss.getSheetByName('EmailQueue').data.length, 2);
  const ok = loadGas({ ss });
  ok.ctx.sendChangeEmails();
  assert.equal(ok.sent[0].to, 'alex@example.com');
  assert.equal(ss.getSheetByName('EmailQueue').data.length, 1);
});

test('bad JSON and the plain address answer sensibly', () => {
  assert.equal(JSON.parse(ctx.doPost({ postData: { contents: '{nope' } }).getContent()).status, 400);
  assert.equal(JSON.parse(ctx.doGet().getContent()).app, 'kids-calendar');
});

test('a brand-new Sheet without install refuses setup', () => {
  const fresh = loadGas({ ss: new FakeSpreadsheet() });
  assert.equal(fresh.post({ action: 'setup', setupKey: '', you: { name: 'X' } }).status, 403);
});
