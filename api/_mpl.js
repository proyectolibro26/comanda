// Mercado Pago de cada local (para cobrar las mesas). El local conecta su propia cuenta por OAuth:
// la plata del cliente va directo a la cuenta del local, Roman Web no la toca.
//   MP_CLIENT_SECRET  Client Secret de la app de Mercado Pago de Roman Web (Tus integraciones › la app › Credenciales de producción)
//   MP_CLIENT_ID      Opcional: el número de la app. Si falta se toma del MP_ACCESS_TOKEN (APP_USR-<id>-...)
const crypto = require('crypto');
const { SB } = require('./_lib');

const BASE = (process.env.APP_URL || 'https://comanda-flax-eight.vercel.app').replace(/\/$/, '');
const REDIRECT = BASE + '/api/mp-oauth';

function clientId() {
  if (process.env.MP_CLIENT_ID) return process.env.MP_CLIENT_ID;
  const m = String(process.env.MP_ACCESS_TOKEN || '').match(/^(?:APP_USR|TEST)-(\d+)-/);
  return m ? m[1] : '';
}
const listo = () => !!(clientId() && process.env.MP_CLIENT_SECRET && process.env.SUPABASE_SERVICE_ROLE_KEY);

// state firmado: local|usuario|hora|nonce . firma — el verificador PKCE se recalcula del nonce, nunca viaja
const b64 = s => Buffer.from(s).toString('base64url');
const hmac = s => crypto.createHmac('sha256', process.env.MP_CLIENT_SECRET).update(s).digest('base64url');
function firmarEstado(local, user) {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const cuerpo = b64(JSON.stringify({ l: local, u: user, t: Date.now(), n: nonce }));
  return { state: cuerpo + '.' + hmac('st:' + cuerpo), nonce };
}
function leerEstado(state) {
  const [cuerpo, firma] = String(state || '').split('.');
  if (!cuerpo || !firma) return null;
  const ok = hmac('st:' + cuerpo);
  if (firma.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(ok))) return null;
  const j = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
  if (Date.now() - j.t > 20 * 60e3) return null; // 20 minutos para autorizar
  return j;
}
const verificador = nonce => hmac('pkce:' + nonce);
const desafio = nonce => crypto.createHash('sha256').update(verificador(nonce)).digest('base64url');

function urlAutorizar(local, user) {
  const { state, nonce } = firmarEstado(local, user);
  const q = new URLSearchParams({ client_id: clientId(), response_type: 'code', platform_id: 'mp', state, redirect_uri: REDIRECT, code_challenge: desafio(nonce), code_challenge_method: 'S256' });
  return 'https://auth.mercadopago.com.ar/authorization?' + q.toString();
}

async function oauthToken(body) {
  const r = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(Object.assign({ client_id: clientId(), client_secret: process.env.MP_CLIENT_SECRET }, body))
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(j.message || j.error || `oauth ${r.status}`); e.mp = j; throw e; }
  return j;
}

// Supabase (servidor)
function h(extra) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const x = Object.assign({ apikey: k, 'Content-Type': 'application/json' }, extra || {});
  if (k.startsWith('eyJ')) x.Authorization = 'Bearer ' + k;
  return x;
}
async function sb(method, path, body, prefer) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: h(prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

async function guardarCuenta(local, tok, user) {
  await sb('POST', 'taca_mp_cuentas?on_conflict=local_id', [{
    local_id: local, mp_user_id: String(tok.user_id || ''), access_token: tok.access_token, refresh_token: tok.refresh_token || null,
    expira: new Date(Date.now() + (tok.expires_in || 15552000) * 1000).toISOString(), conectado: new Date().toISOString(), por: user || null
  }], 'resolution=merge-duplicates');
}
// token vigente del local (lo renueva solo si está por vencer)
async function tokenLocal(local) {
  const [c] = await sb('GET', `taca_mp_cuentas?select=*&local_id=eq.${encodeURIComponent(local)}`);
  if (!c) return null;
  if (c.refresh_token && c.expira && Date.parse(c.expira) - Date.now() < 7 * 864e5) {
    try { const t = await oauthToken({ grant_type: 'refresh_token', refresh_token: c.refresh_token }); await guardarCuenta(local, t, c.por); return t.access_token; }
    catch (e) { console.error('mp refresh', local, e.message); }
  }
  return c.access_token;
}
async function mpCon(token, path, opts) {
  opts = opts || {};
  const r = await fetch('https://api.mercadopago.com' + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || `Mercado Pago ${r.status}`); e.status = r.status; e.mp = j; throw e; }
  return j;
}
const cuerpo = req => typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

module.exports = { BASE, REDIRECT, clientId, listo, urlAutorizar, leerEstado, verificador, oauthToken, sb, guardarCuenta, tokenLocal, mpCon, cuerpo };
