// Phone notifications through the real Code.gs: upgrade safety, keys, who gets
// notified, decrypting what was sent (with Node's own crypto), dead devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadGas, FakeSpreadsheet } from './fake-google.js';

const FIXTURE_V1 = new URL('./fixtures/code-v1.gs', import.meta.url); // the version Don runs now

function makeSubscriber(host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    sub: {
      endpoint: `https://${host}/fcm/send/${crypto.randomBytes(12).toString('hex')}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

// Decrypt an aes128gcm Web Push body the way a browser does (RFC 8291).
function decrypt(subscriber, signedBytes) {
  const body = Buffer.from(signedBytes.map((b) => (b < 0 ? b + 256 : b)));
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = subscriber.ecdh.computeSecret(asPublic);
  const uaPublic = subscriber.ecdh.getPublicKey();
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, subscriber.auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

function verifyVapid(authHeader, endpoint) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
  assert.ok(m, authHeader);
  const [h, c, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.aud, new URL(endpoint).origin);
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature verifies');
  return claims;
}

test('upgrade: a Sheet written by the version Don runs now loses nothing', () => {
  const ss = new FakeSpreadsheet();
  const v1 = loadGas({ ss, file: FIXTURE_V1 });
  const key = v1.ctx.install();
  const { code } = v1.post({ action: 'setup', setupKey: key, you: { name: 'Alex', email: 'a@example.com' }, other: { name: 'Sam', email: 's@example.com' }, kids: ['Mia'], appUrl: 'https://x.github.io/kids-calendar/' });
  v1.post({ action: 'pattern', code, start: '2026-11-23', cycle: [1, 1, 2, 2] });
  v1.post({ action: 'custody', code, from: '2026-12-24', to: '2026-12-25', person_id: 2, note: 'Xmas' });
  v1.post({ action: 'addEvent', code, title: 'Netball', date: '2026-11-28', start_time: '09:00', kid_ids: [3] });
  const before = v1.post({ action: 'state', code });

  const v2 = loadGas({ ss });
  v2.ctx.install(); // Don runs install again to approve the new permission
  const after = v2.post({ action: 'state', code });
  for (const k of ['family', 'people', 'kids', 'overrides', 'events', 'activity']) assert.deepEqual(after[k], before[k], k);
  assert.match(after.pushKey, /^[A-Za-z0-9_-]{87}$/);

  // The old web-app version (still live until Don publishes) keeps working on the new Sheet,
  // and doesn't wipe the new keys or phones.
  const s = makeSubscriber();
  v2.post({ action: 'pushSubscribe', code, subscription: s.sub });
  v1.post({ action: 'addEvent', code, title: 'Swim', date: '2026-11-29' });
  const later = loadGas({ ss }).post({ action: 'state', code });
  assert.equal(later.pushKey, after.pushKey);
  assert.equal(ss.getSheetByName('PushDevices').data.length, 2);
  assert.ok(later.events.some((e) => e.title === 'Swim'));
});

test('push: keys made once, private key never sent, other people notified with readable text', () => {
  const g = loadGas();
  const key = g.ctx.install();
  const r = g.post({ action: 'setup', setupKey: key, you: { name: 'Alex' }, other: { name: 'Sam' }, appUrl: 'https://x.github.io/kids-calendar/' });
  const A = r.code, B = r.otherCode;
  const st = g.post({ action: 'state', code: A });
  const pub = st.pushKey;
  const priv = Object.fromEntries(g.ss.getSheetByName('Settings').data).vapid_private;
  assert.ok(priv && priv.length > 30);
  assert.ok(!JSON.stringify(st).includes(priv));
  assert.ok(!JSON.stringify(g.post({ action: 'status' })).includes(priv));
  assert.equal(g.post({ action: 'state', code: B }).pushKey, pub, 'key stays the same');

  const samPhone = makeSubscriber('web.push.apple.com');
  const alexPhone = makeSubscriber();
  g.post({ action: 'pushSubscribe', code: B, subscription: samPhone.sub, device: 'iPhone' });
  g.post({ action: 'pushSubscribe', code: A, subscription: alexPhone.sub, device: 'Android phone' });

  g.fetched.length = 0;
  g.post({ action: 'addEvent', code: A, title: 'Mia’s netball 🏐', date: '2026-11-28', start_time: '09:00' });
  assert.equal(g.fetched.length, 1, 'only Sam (not Alex, who made the change)');
  const req = g.fetched[0];
  assert.equal(req.url, samPhone.sub.endpoint);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(req.payload.every((b) => b >= -128 && b <= 127), 'signed bytes for Apps Script');
  const claims = verifyVapid(req.headers.Authorization, samPhone.sub.endpoint);
  assert.equal(claims.sub, 'https://x.github.io/kids-calendar/');
  const msg = decrypt(samPhone, req.payload);
  assert.equal(msg.body, 'Alex: Added "Mia’s netball 🏐" on Sat 28 Nov at 9:00am');
  assert.equal(msg.url, 'https://x.github.io/kids-calendar/');
});

test('push: test button reports the result; failures never fail a save; 410 removes the phone', () => {
  let status = 201;
  const g = loadGas({ pushStatus: () => status });
  const key = g.ctx.install();
  const { code: A, otherCode: B } = g.post({ action: 'setup', setupKey: key, you: { name: 'Alex' }, other: { name: 'Sam' } });
  const phone = makeSubscriber();
  g.post({ action: 'pushSubscribe', code: B, subscription: phone.sub });

  let t = g.post({ action: 'pushTest', code: B, endpoint: phone.sub.endpoint });
  assert.deepEqual(t.pushTest, { ok: true, status: 201, reason: '' });
  assert.equal(decrypt(phone, g.fetched.at(-1).payload).body, 'Test notification: they work on this phone.');
  assert.equal(g.post({ action: 'pushTest', code: A, endpoint: phone.sub.endpoint }).status, 404, "can't test someone else's phone");

  status = 500;
  const saved = g.post({ action: 'addEvent', code: A, title: 'Dentist', date: '2026-12-01' });
  assert.ok(saved.events.some((e) => e.title === 'Dentist'), 'save still succeeds');
  t = g.post({ action: 'pushTest', code: B, endpoint: phone.sub.endpoint });
  assert.equal(t.pushTest.ok, false);
  assert.equal(t.pushTest.status, 500);

  status = 410;
  g.post({ action: 'addEvent', code: A, title: 'Party', date: '2026-12-02' });
  assert.equal(g.ss.getSheetByName('PushDevices').data.length, 1, 'only the header row left');
});

test('push: only real push services are accepted', () => {
  const g = loadGas();
  const key = g.ctx.install();
  const { code } = g.post({ action: 'setup', setupKey: key, you: { name: 'Alex' } });
  const s = makeSubscriber();
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x']) {
    assert.equal(g.post({ action: 'pushSubscribe', code, subscription: { ...s.sub, endpoint } }).status, 400, endpoint);
  }
  assert.equal(g.post({ action: 'pushSubscribe', code, subscription: { ...s.sub, keys: { p256dh: 'short', auth: 'x' } } }).status, 400);
  assert.equal(g.post({ action: 'pushSubscribe', code, subscription: s.sub }).people.length, 1);
});

test('email still works alongside, and the email toggle is separate', () => {
  const g = loadGas();
  const key = g.ctx.install();
  const { code: A, otherCode: B } = g.post({ action: 'setup', setupKey: key, you: { name: 'Alex', email: 'a@example.com' }, other: { name: 'Sam', email: 's@example.com' } });
  g.post({ action: 'pushSubscribe', code: B, subscription: makeSubscriber().sub });
  g.post({ action: 'addEvent', code: A, title: 'Play', date: '2026-12-03' });
  const q = g.ss.getSheetByName('EmailQueue').data;
  for (let i = 1; i < q.length; i++) q[i][4] = String(Date.now() - 10 * 60000);
  g.ctx.sendChangeEmails();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].to, 's@example.com');
});
