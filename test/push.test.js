// Tests for core/push.js, the hand-written Web Push crypto. Node's own crypto
// is the independent check for every piece. The file is loaded straight into a
// bare vm context (no Buffer, TextEncoder, atob or crypto), as Apps Script has
// none of those, so the tests don't depend on the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const file = new URL('../core/push.js', import.meta.url);
const source = readFileSync(file, 'utf8');
function load(extra = {}) {
  const ctx = vm.createContext({ ...extra });
  vm.runInContext(source, ctx, { filename: 'core/push.js' });
  return ctx;
}
const P = load();

// Results come from another realm, so compare as Buffers, not with deepEqual on arrays.
const buf = (bytes) => Buffer.from(bytes);
const arr = (b) => Array.from(b);
const hex = (bytes) => buf(bytes).toString('hex');
const rnd = (n) => arr(crypto.randomBytes(n));
const fixed = (...chunks) => { const q = chunks.map((c) => arr(c)); return (n) => { const c = q.shift(); assert.equal(c.length, n); return c; }; };

// ---- runtime constraints ----------------------------------------------------
test('source uses nothing Apps Script lacks', () => {
  const code = source.replace(/(^|\s)\/\/.*$/gm, '$1'); // without the comments
  assert.doesNotMatch(code, /\b(0x[0-9a-f]+|\d+)n\b/i, 'BigInt literal');
  assert.doesNotMatch(code, /\?\.|\?\?/, 'optional chaining or nullish coalescing');
  assert.doesNotMatch(code, /\b(TextEncoder|TextDecoder|atob|btoa|Buffer|crypto\.|require|import|export|class)\b/);
  for (const m of source.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)) assert.match(m[1], /^(push|PUSH_)/, m[1] + ' has no push prefix');
});

test('loading does no BigInt work', () => {
  const ctx = load({ BigInt() { throw new Error('BigInt used at load time'); } });
  assert.equal(typeof ctx.pushEncrypt, 'function');
  assert.equal(ctx.pushB64uEncode([1, 2, 3]), 'AQID'); // the non-BigInt parts still work
});

// ---- base64url and UTF-8 ------------------------------------------------------
test('base64url and UTF-8 match Node', () => {
  for (let n = 0; n < 40; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(P.pushB64uEncode(arr(b)), b.toString('base64url'));
    assert.equal(hex(P.pushB64uDecode(b.toString('base64url'))), b.toString('hex'));
    assert.equal(hex(P.pushB64uDecode(b.toString('base64'))), b.toString('hex')); // padded, + and /
  }
  assert.throws(() => P.pushB64uDecode('ab*c'), /bad base64url/);
  for (const s of ['', 'abc', 'Mia’s netball – 9:00am 🏐', 'é ü 中文 𝄞', '\ud800 lone']) {
    assert.equal(hex(P.pushUtf8(s)), Buffer.from(s, 'utf8').toString('hex'), s);
  }
});

// ---- 1. SHA-256, HMAC, HKDF -------------------------------------------------
test('SHA-256, HMAC-SHA-256 and HKDF match Node crypto', () => {
  const lengths = [0, 1, 3, 55, 56, 63, 64, 65, 100, 128, 200, 1000];
  for (const n of lengths) {
    const data = crypto.randomBytes(n);
    assert.equal(hex(P.pushSha256(arr(data))), crypto.createHash('sha256').update(data).digest('hex'), 'sha ' + n);
    for (const kn of [0, 16, 32, 64, 65, 100]) {
      const key = crypto.randomBytes(kn);
      assert.equal(hex(P.pushHmacSha256(arr(key), arr(data))), crypto.createHmac('sha256', key).update(data).digest('hex'), `hmac ${kn}/${n}`);
    }
  }
  assert.equal(hex(P.pushSha256(P.pushUtf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const [sn, in_, fn, len] of [[16, 32, 0, 32], [0, 22, 10, 16], [16, 65, 144, 12], [100, 10, 70, 1], [32, 0, 0, 32]]) {
    const salt = crypto.randomBytes(sn), ikm = crypto.randomBytes(in_), info = crypto.randomBytes(fn);
    const want = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
    assert.equal(hex(P.pushHkdf(arr(salt), arr(ikm), arr(info), len)), want.toString('hex'), `hkdf ${sn}/${in_}/${fn}/${len}`);
  }
});

// ---- 2. AES-128-GCM -------------------------------------------------------------
test('AES-128-GCM matches Node createCipheriv', () => {
  for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 100, 3000]) {
    for (let rep = 0; rep < 3; rep++) {
      const key = crypto.randomBytes(16), iv = crypto.randomBytes(12), pt = crypto.randomBytes(n);
      const c = crypto.createCipheriv('aes-128-gcm', key, iv);
      const want = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      assert.equal(hex(P.pushAesGcmEncrypt_(arr(key), arr(iv), arr(pt))), want.toString('hex'), 'length ' + n);
    }
  }
  // FIPS 197 appendix C.1 known answer for the block cipher alone.
  const rk = P.pushAesExpandKey_(arr(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')));
  assert.equal(hex(P.pushAesEncryptBlock_(rk, arr(Buffer.from('00112233445566778899aabbccddeeff', 'hex')))), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

// ---- 3. key generation --------------------------------------------------------
function nodePublic(d) {
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(d);
  return e.getPublicKey();
}
test('pushGenerateKeys gives the public key Node gives for the same private key', () => {
  const n = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex');
  const nMinus1 = Buffer.from(n); nMinus1[31] -= 1;
  const small = (v) => { const b = Buffer.alloc(32); b[31] = v; return b; };
  const ds = [small(1), small(2), small(3), nMinus1];
  for (let i = 0; i < 20; i++) ds.push(crypto.randomBytes(32));
  // Make sure a public key with leading zero bytes in x or y is covered.
  for (let found = 0, i = 0; found < 2 && i < 5000; i++) {
    const d = crypto.randomBytes(32), pub = nodePublic(d);
    if (pub[1] === 0 || pub[33] === 0) { ds.push(d); found++; }
  }
  // And a private key with a leading zero byte.
  const lead0 = crypto.randomBytes(32); lead0[0] = 0; ds.push(lead0);
  for (const d of ds) {
    const k = P.pushGenerateKeys(fixed(d));
    assert.equal(k.privateKey, d.toString('base64url'));
    assert.equal(k.publicKey, nodePublic(d).toString('base64url'), d.toString('hex'));
  }
  assert.throws(() => P.pushGenerateKeys(fixed(Buffer.alloc(32))), /out of range/);
  assert.throws(() => P.pushGenerateKeys(fixed(n)), /out of range/);
  assert.throws(() => P.pushGenerateKeys(fixed(Buffer.alloc(32, 0xff))), /out of range/);
  assert.throws(() => P.pushGenerateKeys(() => [1, 2, 3]), /wrong number of bytes/);
});

// ---- 4. VAPID -------------------------------------------------------------------
function jwkFromPublic(b64u) {
  const pub = Buffer.from(b64u, 'base64url');
  return { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
}
test('ECDSA uses RFC 6979 deterministic k (RFC 6979 A.2.5 vectors)', () => {
  const d = 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
  const ux = '60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6';
  const uy = '7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299';
  const vectors = [
    ['sample', 'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716', 'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8'],
    ['test', 'f1abb023518351cd71d881567b1ea663ed3efcf6c5132b354f28d3b0b7d38367', '019f4113742a2b14bd25926b49c649155f267e60d3814b4c0cc84250e46f0083'],
  ];
  // The vector itself is checked against Node, so a mistyped value can't pass.
  assert.equal(nodePublic(Buffer.from(d, 'hex')).toString('hex'), '04' + ux + uy);
  const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(ux, 'hex').toString('base64url'), y: Buffer.from(uy, 'hex').toString('base64url') };
  P.pushEc_();
  for (const [msg, r, s] of vectors) {
    const sig = P.pushEcdsaSign_(P.pushSha256(P.pushUtf8(msg)), P.pushBytesToBig_(arr(Buffer.from(d, 'hex'))));
    assert.equal(hex(sig), r + s, msg);
    assert.ok(crypto.verify('sha256', Buffer.from(msg), { key: jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, buf(sig)));
  }
});

test('VAPID header: claims, a signature Node accepts, deterministic', () => {
  const now = 1795000000;
  for (let i = 0; i < 10; i++) {
    const keys = P.pushGenerateKeys(rnd);
    const endpoint = 'https://FCM.googleapis.com:443/fcm/send/abc:def?x=1';
    const h = P.pushVapidAuthorization(endpoint, 'mailto:kids@example.com', keys.privateKey, keys.publicKey, now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
    assert.ok(m, h);
    assert.equal(m[4], keys.publicKey);
    assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
    assert.deepEqual(JSON.parse(Buffer.from(m[2], 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now + 43200, sub: 'mailto:kids@example.com' });
    const sig = Buffer.from(m[3], 'base64url');
    assert.equal(sig.length, 64);
    const ok = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: jwkFromPublic(keys.publicKey), format: 'jwk', dsaEncoding: 'ieee-p1363' }, sig);
    assert.ok(ok, 'signature verifies');
    assert.equal(P.pushVapidAuthorization(endpoint, 'mailto:kids@example.com', keys.privateKey, keys.publicKey, now), h, 'same inputs, same token');
  }
  const keys = P.pushGenerateKeys(rnd);
  const aud = (ep) => JSON.parse(Buffer.from(P.pushVapidAuthorization(ep, 'mailto:a@b.c', keys.privateKey, keys.publicKey, now).split('.')[1], 'base64url')).aud;
  assert.equal(aud('https://updates.push.services.mozilla.com/wpush/v2/gAAA'), 'https://updates.push.services.mozilla.com');
  assert.equal(aud('https://web.push.apple.com:8443/QGx'), 'https://web.push.apple.com:8443');
  assert.throws(() => P.pushVapidAuthorization('https://x.example/', 'mailto:a@b.c', keys.privateKey, 'AAAA', now), /65-byte/);
  const other = P.pushGenerateKeys(rnd);
  assert.throws(() => P.pushVapidAuthorization('https://x.example/', 'mailto:a@b.c', keys.privateKey, other.publicKey, now), /does not match/);
});

// ---- 5. encryption, decrypted independently ---------------------------------
// What a browser does with the body: RFC 8188 header, ECDH, RFC 8291 keys, AES-GCM.
function browserDecrypt(body, ecdh, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  assert.ok(record.length <= rs);
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'last-record delimiter');
  return { plaintext: padded.subarray(0, end), salt, asPublic };
}

test('pushEncrypt output decrypts with Node, as a browser would', () => {
  const messages = ['Mia’s netball – 9:00am 🏐', '', 'x', JSON.stringify({ title: 'Kids Calendar', body: 'Leo: swimming moved to 4:30pm', url: '/#2026-11-28' })];
  messages.push('é🏐'.repeat(500)); // 3000 bytes
  for (const msg of messages) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    const pt = P.pushUtf8(msg);
    const body = buf(P.pushEncrypt(ecdh.getPublicKey().toString('base64url'), auth.toString('base64url'), pt, rnd));
    assert.equal(body.length, 86 + pt.length + 1 + 16);
    const out = browserDecrypt(body, ecdh, auth);
    assert.equal(out.plaintext.toString('utf8'), msg);
  }
});

test('pushEncrypt uses a fresh key pair and salt each call', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const a = browserDecrypt(buf(P.pushEncrypt(ecdh.getPublicKey().toString('base64url'), auth.toString('base64url'), [104, 105], rnd)), ecdh, auth);
  const b = browserDecrypt(buf(P.pushEncrypt(ecdh.getPublicKey().toString('base64url'), auth.toString('base64url'), [104, 105], rnd)), ecdh, auth);
  assert.notEqual(a.salt.toString('hex'), b.salt.toString('hex'));
  assert.notEqual(a.asPublic.toString('hex'), b.asPublic.toString('hex'));
  // The injected randomness really is what's used: the ephemeral key then the salt.
  const d = crypto.randomBytes(32), salt = crypto.randomBytes(16);
  const c = browserDecrypt(buf(P.pushEncrypt(ecdh.getPublicKey().toString('base64url'), auth.toString('base64url'), [1], fixed(d, salt))), ecdh, auth);
  assert.equal(c.salt.toString('hex'), salt.toString('hex'));
  assert.equal(c.asPublic.toString('hex'), nodePublic(d).toString('hex'));
  assert.throws(() => P.pushEncrypt(ecdh.getPublicKey().toString('base64url'), auth.toString('base64url'), new Array(3001).fill(65), rnd), /too long/);
});

// ---- 6. bad subscriber keys ---------------------------------------------------
test('pushEncrypt rejects an invalid p256dh or auth', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const good = ecdh.getPublicKey();
  const auth = crypto.randomBytes(16).toString('base64url');
  const offCurve = Buffer.from(good); offCurve[64] ^= 1;
  assert.throws(() => P.pushEncrypt(offCurve.toString('base64url'), auth, [1], rnd), /not a point on P-256/);
  const xTooBig = Buffer.from(good); xTooBig.fill(0xff, 1, 33);
  assert.throws(() => P.pushEncrypt(xTooBig.toString('base64url'), auth, [1], rnd), /not a point on P-256/);
  const zero = Buffer.alloc(65); zero[0] = 4;
  assert.throws(() => P.pushEncrypt(zero.toString('base64url'), auth, [1], rnd), /not a point on P-256/);
  const compressed = Buffer.from(good); compressed[0] = 2;
  assert.throws(() => P.pushEncrypt(compressed.toString('base64url'), auth, [1], rnd), /65-byte/);
  assert.throws(() => P.pushEncrypt(good.subarray(0, 64).toString('base64url'), auth, [1], rnd), /65-byte/);
  assert.throws(() => P.pushEncrypt(good.toString('base64url'), 'AAAA', [1], rnd), /auth secret/);
});

// ---- timing ---------------------------------------------------------------------
test('one encrypt plus one VAPID token, cold, is well under a second', () => {
  const t0 = performance.now();
  const ctx = load(); // fresh context: lazy set-up is included, as in Apps Script
  const keys = ctx.pushGenerateKeys(rnd);
  const t1 = performance.now();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const msg = ctx.pushUtf8(JSON.stringify({ title: 'Kids Calendar', body: 'Mia’s netball – 9:00am 🏐' }));
  const t2 = performance.now();
  ctx.pushVapidAuthorization('https://fcm.googleapis.com/fcm/send/x', 'mailto:a@b.c', keys.privateKey, keys.publicKey, 1795000000);
  ctx.pushEncrypt(ecdh.getPublicKey().toString('base64url'), crypto.randomBytes(16).toString('base64url'), msg, rnd);
  const t3 = performance.now();
  console.log(`  load + key generation: ${(t1 - t0).toFixed(1)} ms; VAPID + encrypt: ${(t3 - t2).toFixed(1)} ms`);
  assert.ok(t3 - t2 < 1000);
});
