// Notificaciones push (Web Push, RFC 8291 + VAPID RFC 8292) con el crypto de Node, sin librerías.
// La clave VAPID se deriva de SUPABASE_SERVICE_ROLE_KEY: no hace falta cargar otra variable en Vercel.
const crypto = require('crypto');

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

let VAPID = null;
function vapid() {
  if (VAPID) return VAPID;
  const sec = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sec) throw new Error('sin clave');
  const ecdh = crypto.createECDH('prime256v1');
  for (let i = 0; ; i++) { // casi siempre sirve la primera
    try { ecdh.setPrivateKey(hmac(sec, 'taca-vapid-v1:' + i)); break; } catch (e) { if (i > 5) throw e; }
  }
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(ecdh.getPrivateKey()), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  VAPID = { pub, publica: b64u(pub), key };
  return VAPID;
}

function firma(endpoint) {
  const v = vapid(), aud = new URL(endpoint).origin;
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const cuerpo = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:hola@ta-ca.com.ar' }));
  const sig = crypto.sign('sha256', Buffer.from(cab + '.' + cuerpo), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${cab}.${cuerpo}.${b64u(sig)}, k=${v.publica}`;
}

function cifrar(sub, texto) {
  const uaPub = deB64u(sub.keys.p256dh), auth = deB64u(sub.keys.auth);
  if (uaPub.length !== 65 || auth.length < 16) throw new Error('suscripción inválida');
  const as = crypto.createECDH('prime256v1'); as.generateKeys();
  const asPub = as.getPublicKey(), secreto = as.computeSecret(uaPub), salt = crypto.randomBytes(16);
  const prkKey = hmac(auth, secreto);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cuerpo = Buffer.concat([c.update(Buffer.concat([Buffer.from(texto), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([65]), asPub, cuerpo]);
}

const SERVICIOS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|notify\.windows\.com|push\.apple\.com)$/;
function endpointOk(ep) { try { const u = new URL(ep); return u.protocol === 'https:' && SERVICIOS.test(u.hostname); } catch (e) { return false; } }

// Devuelve el código HTTP del servicio de push (201 = entregado; 404/410 = la suscripción ya no existe).
async function enviar(sub, datos) {
  if (!endpointOk(sub.endpoint)) return 400;
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: firma(sub.endpoint), TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
    body: cifrar(sub, JSON.stringify(datos))
  });
  return r.status;
}

module.exports = { vapid, enviar, endpointOk, cifrar, firma, b64u, deB64u };
