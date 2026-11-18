// Funciones del servidor de ta-ca (Vercel). Las claves se cargan en Vercel › Settings › Environment Variables:
//   MP_ACCESS_TOKEN            Access Token de producción de la app de Mercado Pago de Roman Web
//   MP_WEBHOOK_SECRET          Clave secreta de los webhooks de esa app (para validar la firma)
//   SUPABASE_SERVICE_ROLE_KEY  Clave secreta de Supabase (service_role o sb_secret_...)
//   SUPABASE_URL               Opcional; por defecto el proyecto ta-ca
const crypto = require('crypto');

const SB = process.env.SUPABASE_URL || 'https://ktoicklowsblqmerqqdo.supabase.co';
const PLANES = { local: { nombre: 'Local', precio: 49900 }, encendido: { nombre: 'Encendido', precio: 89900 } };
const PERIODOS = { mensual: { meses: 1, factor: 1 }, anual: { meses: 12, factor: 10 } }; // anual: 2 meses gratis

function sbHeaders(extra) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const h = Object.assign({ apikey: k, 'Content-Type': 'application/json' }, extra || {});
  if (k.startsWith('eyJ') && !h.Authorization) h.Authorization = 'Bearer ' + k; // clave service_role vieja (JWT)
  return h;
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${fn}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function sbSelect(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status}`);
  return r.json();
}
async function sbUsuario(token) {
  if (!token) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || '', Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json();
}
async function mp(path, opts) {
  opts = opts || {};
  const r = await fetch('https://api.mercadopago.com' + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || `Mercado Pago ${r.status}`); e.status = r.status; e.mp = j; throw e; }
  return j;
}
// Firma de los webhooks: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" con la clave secreta.
function firmaValida(headers, dataId, secret) {
  const sig = headers['x-signature'] || '';
  const reqId = headers['x-request-id'] || '';
  let ts = '', v1 = '';
  sig.split(',').forEach(p => { const [k, v] = p.split('=').map(x => (x || '').trim()); if (k === 'ts') ts = v; if (k === 'v1') v1 = v; });
  if (!ts || !v1) return false;
  let manifest = '';
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId};`;
  if (reqId) manifest += `request-id:${reqId};`;
  manifest += `ts:${ts};`;
  const calc = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(v1)); } catch (e) { return false; }
}
function leerRef(ref) {
  const [local, plan, periodo] = String(ref || '').split('|');
  return { local, plan: PLANES[plan] ? plan : null, periodo: PERIODOS[periodo] ? periodo : 'mensual' };
}
module.exports = { SB, PLANES, PERIODOS, sbRpc, sbSelect, sbUsuario, mp, firmaValida, leerRef };
