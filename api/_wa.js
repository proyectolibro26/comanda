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
  const simulador = S.wa; // conversación de prueba de la app: se guarda y se devuelve intacta
  S.waConv = S.waConv || {};
  const conv = S.waConv[tel] || { tel, step: 'inicio', draft: {}, msgs: [], nombre: nombrePerfil || '' };
  if (nombrePerfil && !conv.nombre) conv.nombre = nombrePerfil;
  if (nombrePerfil && S.clientes[tel] && S.clientes[tel].nombre === 'Cliente') S.clientes[tel].nombre = nombrePerfil; // nombre real del perfil de WhatsApp
  if (conv.ts && Date.now() - conv.ts > 3 * 3600e3) { conv.step = 'inicio'; conv.draft = {}; } // conversación vieja sin terminar: empezar de nuevo
  S.wa = { tel, step: conv.step || 'inicio', draft: conv.draft || {}, msgs: [], ultimo: conv.ultimo || null, perfil: conv.nombre || nombrePerfil || '', humano: conv.humano || null, noEnt: conv.noEnt || 0, consulta: conv.consulta || null };
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
  conv.humano = S.wa.humano || null; conv.noEnt = S.wa.noEnt || 0; conv.consulta = S.wa.consulta || null;
  S.waConv[tel] = conv;
  S.waUlt = S.waUlt || {}; S.waUlt[tel] = ahora; // último mensaje del cliente (ventana de 24 h de WhatsApp)
  if (simulador) S.wa = simulador; else delete S.wa; // el simulador de la app usa su propio S.wa; no se pisa
  // no guardar conversaciones viejas para siempre: las 200 más recientes
  const tels = Object.keys(S.waConv);
  if (tels.length > 200) tels.sort((a, b) => (S.waConv[a].ts || 0) - (S.waConv[b].ts || 0)).slice(0, tels.length - 200).forEach(k => { delete S.waConv[k]; delete S.waUlt[k]; });
  return respuestas;
}
// Celulares argentinos: WhatsApp los entrega como 549XXXXXXXXXX, pero según la cuenta acepta responder
// con el 9 o sin el 9 (54XXXXXXXXXX). Se prueba el formato recibido y, si Meta lo rechaza, el otro.
function variantes(to) {
  to = String(to).replace(/\D/g, '');
  if (/^549\d{10}$/.test(to)) {
    const n = to.slice(3); // código de área + número, 10 dígitos
    // formato viejo con 15 después del código de área (2, 3 o 4 dígitos): lo pide a veces el modo prueba de Meta
    const con15 = [3, 2, 4].map(k => '54' + n.slice(0, k) + '15' + n.slice(k));
    return [to, '54' + n].concat(con15);
  }
  if (/^54[1-8]\d{9}$/.test(to)) return [to, '549' + to.slice(2)];
  return [to];
}
async function enviarUno(phoneId, to, body) {
  const r = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: String(body).slice(0, 4000) } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || `WhatsApp ${r.status}`); e.status = r.status; e.code = j.error && j.error.code; throw e; }
  return j;
}
const formatoOk = {};
async function enviarTexto(phoneId, to, body) {
  const vs = variantes(to);
  if (formatoOk[to]) vs.sort((a, b) => (b === formatoOk[to]) - (a === formatoOk[to]));
  let ultimo;
  for (const v of vs) {
    try { const j = await enviarUno(phoneId, v, body); formatoOk[to] = v; return j; }
    catch (e) { ultimo = e; if (e.code !== 131030 && e.code !== 131026 && e.code !== 100 && e.status !== 400) throw e; }
  }
  console.error('wa: Meta rechazó todos los formatos', vs.map(v => v.slice(0, 5) + '…' + v.slice(-3)).join(' / '));
  await require('./_alerta').alertar('WhatsApp', 'Meta rechazó la respuesta del bot en todos los formatos de número', { donde: 'termina en ' + String(to).slice(-3) });
  throw ultimo;
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
module.exports = { variantes, correrBot, enviarTexto, firmaMetaValida, leerCuerpo };
