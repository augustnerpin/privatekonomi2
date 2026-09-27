// Web Push utan externa bibliotek: VAPID-signatur (RFC 8292) och aes128gcm-kryptering (RFC 8291) med WebCrypto.
// Fungerar i Deno (edge-funktioner) och Node 20+ (tester). iOS kräver att webbappen ligger på hemskärmen.
// deno-lint-ignore-file no-explicit-any
const enc = new TextEncoder();
export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

// Krypterar payload till en prenumeration (p256dh = mottagarens publika nyckel, auth = 16 byte hemlighet)
export async function encryptPayload(payload: string, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // postens storlek 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// VAPID: JWT signerad med serverns nyckel (ES256). jwk = privat nyckel som JWK, pub = publik nyckel (base64url, 65 byte)
export async function vapidHeader(endpoint: string, jwk: JsonWebKey, pub: string, subject: string) {
  const aud = new URL(endpoint).origin;
  const b = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const data = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data)));
  return `vapid t=${data}.${b64u(sig)}, k=${pub}`;
}

// Skickar en notis. Returnerar HTTP-status; 404/410 betyder att prenumerationen är borta (ta bort den).
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, msg: Record<string, unknown>, vapid: { jwk: JsonWebKey; pub: string; subject: string }) {
  const body = await encryptPayload(JSON.stringify(msg), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, vapid.jwk, vapid.pub, vapid.subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body,
  });
  return { status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 300) };
}
