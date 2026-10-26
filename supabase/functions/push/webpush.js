// Web Push, sent straight to Apple's (or any browser's) push service:
// RFC 8291 encryption (aes128gcm) and RFC 8292 VAPID sign-in, with nothing
// but WebCrypto. Plain JavaScript so it runs in the Supabase function (Deno)
// and in Node for the test (test.mjs).

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text) {
  const s = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

// The VAPID key pair, from the two base64url strings kept as function secrets:
// the public key (65 bytes, uncompressed point) and the private scalar (32 bytes).
export async function importVapid(publicKey, privateKey) {
  const pub = unb64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not a P-256 public key");
  const jwk = { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)), d: privateKey, ext: true };
  const key = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey, key };
}

async function vapidHeader(vapid, endpoint, subject) {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${header}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  // WebCrypto signs ECDSA as r||s, which is what a JWT wants.
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${vapid.publicKey}`;
}

// The payload, encrypted for one subscription (RFC 8291, one record).
export async function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const uaKey = await subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));

  const one = new Uint8Array([1]);
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, one));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);

  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 2: the last (only) record
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

// Send one notification. Returns the push service's status: 201 delivered to
// it, 404/410 the subscription is gone (the app was removed).
export async function sendPush(vapid, subject, subscription, payload, ttlSec = 120) {
  const body = await encrypt(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(vapid, subscription.endpoint, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSec),
      Urgency: "high",
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}
