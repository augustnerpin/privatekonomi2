// Web Push-kryptering/VAPID (functions/_shared/push.ts) och nattens sammanfattning (functions/bank/notify.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, vapidHeader, b64u, unb64u } from '../functions/_shared/push.ts';
import { buildDigest } from '../functions/bank/notify.ts';

const enc = new TextEncoder();
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

test('aes128gcm: telefonen kan dekryptera notisen (RFC 8291)', async () => {
  // Telefonens nycklar (som i PushSubscription)
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload('{"title":"Hej åäö"}', b64u(uaPub), b64u(auth));
  // Dekryptera som webbläsaren
  const salt = body.slice(0, 16), rs = new DataView(body.buffer).getUint32(16), idlen = body[20];
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(pt[pt.length - 1], 2); // sista posten
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), '{"title":"Hej åäö"}');
});

test('VAPID: giltig ES256-signatur och rätt aud', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const h = await vapidHeader('https://web.push.apple.com/QGuQyavX', jwk, pub, 'https://example.se/');
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m); assert.equal(m[4], pub);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, 'https://web.push.apple.com'); assert.equal(claims.sub, 'https://example.se/');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, unb64u(m[3]), enc.encode(m[1] + '.' + m[2]));
  assert.ok(ok);
});

const period = { id: '2026-10', start: '2026-09-25', end: '2026-10-22' };
test('sammanfattning: lön, köp, budget, samtycke – och inget skickas två gånger', () => {
  const newRows = [
    { id: 1, type: 'income', category: 'Lön', amount: 29500, description: '' },
    { id: 2, type: 'expense', category: 'Mat (Ute)', amount: 250, description: 'MAX' },
    { id: 3, type: 'expense', category: 'Resa', amount: 3673, description: 'SAS', extra: { review: true } },
    { id: 4, type: 'transfer', category: 'Egen överföring', amount: -500, description: 'X' },
  ];
  const d = buildDigest({ newRows, spent: { 'Mat (Ute)': 900, Fest: 1200 }, budgets: { 'Mat (Ute)': 1000, Fest: 1000, Gym: 500 }, period, today: '2026-09-28', conns: [{ id: 'c1', aspsp: 'SEB', status: 'active', valid_until: '2026-10-05T00:00:00Z' }], sent: new Set() });
  assert.equal(d.title, 'Lönen har kommit');
  assert.deepEqual(d.body.split('\n'), [
    '💰 Lönen har kommit: 29 500 kr',
    '⚠️ Mat (Ute): 900 kr av 1 000 kr redan dag 4',
    '⚠️ Fest: 1 200 kr av 1 000 kr – över budget',
    '🏦 SEB: samtycket går ut om 6 dagar',
    '+ 3 till i appen',
  ]);
  assert.deepEqual(d.keys.sort(), ['budget:2026-10:Fest:over', 'budget:2026-10:Mat (Ute):80', 'dag:2026-09-28', 'granska:2026-09-28', 'lon:1', 'samtycke:c1:14', 'stort:3'].sort());
  // Samma natt igen: redan skickat → ingen notis
  assert.equal(buildDigest({ newRows, spent: { 'Mat (Ute)': 900, Fest: 1200 }, budgets: { 'Mat (Ute)': 1000, Fest: 1000 }, period, today: '2026-09-28', conns: [{ id: 'c1', aspsp: 'SEB', status: 'active', valid_until: '2026-10-05T00:00:00Z' }], sent: new Set(d.keys) }), null);
  // Inget nytt alls → ingen notis
  assert.equal(buildDigest({ newRows: [], spent: {}, budgets: {}, period, today: '2026-09-28', conns: [], sent: new Set() }), null);
  // Budget i takt (900 av 1000 men sent i perioden) → ingen varning
  const late = buildDigest({ newRows: [], spent: { 'Mat (Ute)': 900 }, budgets: { 'Mat (Ute)': 1000 }, period, today: '2026-10-20', conns: [], sent: new Set() });
  assert.equal(late, null);
});
