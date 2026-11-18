// WhatsApp Cloud API (Meta) para ta-ca. Variables en Vercel:
//   WA_TOKEN         Token permanente (usuario del sistema) con permiso whatsapp_business_messaging
//   WA_APP_SECRET    Clave secreta de la app de Meta (para validar la firma de los webhooks)
//   WA_VERIFY_TOKEN  Texto que inventás y ponés igual en Meta al configurar el webhook
process.env.TZ = 'America/Argentina/Buenos_Aires'; // "hoy", "mañana" y las horas de las reservas en hora argentina
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';
let nucleoSrc = null;
function nucleo() {
  if (!nucleoSrc) nucleoSrc = fs.readFileSync(path.join(__dirname, '..', 'nucleo.js'), 'utf8');
  return nucleoSrc;
}
// Corre el bot de ta-ca sobre los datos del local (los mismos que usa la app).
function correrBot(data, tel, texto, nombrePerfil) {
  const S = data;
  S.clientes = S.clientes || {}; S.reservas = S.reservas || []; S.pedidos = S.pedidos || []; S.audit = S.audit || [];
  S.waConv = S.waConv || {};
  const conv = S.waConv[tel] || { tel, step: 'inicio', draft: {}, msgs: [], nombre: nombrePerfil || '' };
  if (nombrePerfil && !conv.nombre) conv.nombre = nombrePerfil;
  S.wa = { tel, step: conv.step || 'inicio', draft: conv.draft || {}, msgs: [], ultimo: conv.ultimo || null };
  const ctx = {
    S, console, Date, Math, JSON, Object, Array, String, Number, RegExp, Intl,
    save() {},
    audit(accion, detalle, monto) { S.audit.push({ id: Math.random().toString(36).slice(2, 9), ts: Date.now(), por: 'WhatsApp', accion, detalle, monto: monto ?? null }); }
  };
  vm.createContext(ctx);
  vm.runInContext(nucleo(), ctx, { filename: 'nucleo.js' });
  const respuestas = vm.runInContext('bot(' + JSON.stringify(texto) + ')', ctx) || [];
  const ahora = Date.now();
  conv.msgs = (conv.msgs || []).concat([{ from: 'user', t: texto, ts: ahora }], respuestas.map(t => ({ from: 'bot', t, ts: ahora })))
    .slice(-40);
  conv.step = S.wa.step; conv.draft = S.wa.draft; conv.ultimo = S.wa.ultimo; conv.ts = ahora;
  S.waConv[tel] = conv;
  S.waUlt = S.waUlt || {}; S.waUlt[tel] = ahora; // último mensaje del cliente (ventana de 24 h de WhatsApp)
  delete S.wa; // el simulador de la app usa su propio S.wa; no se pisa
  // no guardar conversaciones viejas para siempre: las 200 más recientes
  const tels = Object.keys(S.waConv);
  if (tels.length > 200) tels.sort((a, b) => (S.waConv[a].ts || 0) - (S.waConv[b].ts || 0)).slice(0, tels.length - 200).forEach(k => { delete S.waConv[k]; delete S.waUlt[k]; });
  return respuestas;
}
// WhatsApp entrega los celulares argentinos como 549XXXXXXXXXX, pero para responder hay que usar 54XXXXXXXXXX (sin el 9).
function destino(to) {
  to = String(to).replace(/\D/g, '');
  if (/^549\d{10}$/.test(to)) return '54' + to.slice(3);
  return to;
}
async function enviarTexto(phoneId, to, body) {
  to = destino(to);
  const r = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: String(body).slice(0, 4000) } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || `WhatsApp ${r.status}`); e.status = r.status; throw e; }
  return j;
}
function firmaMetaValida(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const calc = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(header)); } catch (e) { return false; }
}
function leerCuerpo(req) {
  return new Promise(resolve => {
    if (req.rawBody) return resolve(Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody));
    const partes = [];
    req.on('data', c => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
module.exports = { destino, correrBot, enviarTexto, firmaMetaValida, leerCuerpo };
