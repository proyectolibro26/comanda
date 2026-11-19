// Avisos de errores: se guardan en taca_errores y, si están las variables, llegan al Telegram de Roman Web.
//   TELEGRAM_TOKEN  token del bot (el de @BotFather)
//   TELEGRAM_CHAT   chat id donde avisar
// El mismo error no avisa de nuevo por 30 minutos (solo suma "veces"); como mucho 30 avisos por hora.
const crypto = require('crypto');
const { sb } = require('./_mpl');

let chatCache = null;
async function chat() {
  if (process.env.TELEGRAM_CHAT) return process.env.TELEGRAM_CHAT;
  if (chatCache) return chatCache;
  try { const [a] = await sb('GET', 'taca_ajustes?select=valor&clave=eq.telegram_chat'); chatCache = a ? String(a.valor) : null; } catch (e) { chatCache = null; }
  return chatCache;
}
// busca el chat de la última persona que le escribió al bot (para no tener que averiguar el número a mano)
async function detectarChat() {
  const t = process.env.TELEGRAM_TOKEN;
  if (!t) return { error: 'Falta TELEGRAM_TOKEN en Vercel' };
  const r = await fetch(`https://api.telegram.org/bot${t}/getUpdates?limit=50`).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!j.ok) return { error: 'Telegram no aceptó el token: revisalo en Vercel' };
  const ms = (j.result || []).map(u => u.message || u.edited_message || u.channel_post).filter(Boolean).filter(m => m.chat);
  const m = ms.filter(m => m.chat.type === 'private').pop() || ms.pop();
  if (!m) return { error: 'No encontré mensajes. Mandale cualquier mensaje a tu bot en Telegram y probá de nuevo.' };
  const id = String(m.chat.id), nombre = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.title || m.chat.username || '';
  await sb('POST', 'taca_ajustes?on_conflict=clave', [{ clave: 'telegram_chat', valor: id, actualizado: new Date().toISOString() }], 'resolution=merge-duplicates');
  chatCache = id;
  return { ok: true, nombre };
}
async function telegram(texto) {
  const t = process.env.TELEGRAM_TOKEN, c = await chat();
  if (!t || !c) return false;
  const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c, text: texto.slice(0, 3900), disable_web_page_preview: true }) }).catch(() => null);
  return !!(r && r.ok);
}
async function alertar(origen, mensaje, detalle, local) {
  try {
    mensaje = String(mensaje || 'Error sin mensaje').slice(0, 500);
    const clave = crypto.createHash('sha1').update(origen + '|' + (local || '') + '|' + mensaje.slice(0, 200)).digest('hex');
    const [prev] = await sb('GET', `taca_errores?select=id,veces,ultimo&clave=eq.${clave}&order=ultimo.desc&limit=1`);
    if (prev && Date.now() - Date.parse(prev.ultimo) < 30 * 60e3) {
      await sb('PATCH', `taca_errores?id=eq.${prev.id}`, { veces: prev.veces + 1, ultimo: new Date().toISOString() });
      return { ok: true, repetido: true };
    }
    await sb('POST', 'taca_errores', [{ clave, origen: String(origen).slice(0, 40), local_id: local ? String(local).slice(0, 80) : null, mensaje, detalle: detalle || null }]);
    const hora = await sb('GET', `taca_errores?select=id&ts=gte.${new Date(Date.now() - 3600e3).toISOString()}&limit=31`);
    if (hora.length > 30) return { ok: true, silenciado: true };
    const d = detalle || {};
    const enviado = await telegram(`⚠️ ta-ca · ${origen}${local ? ' · ' + local : ''}\n${mensaje}${d.donde ? '\n📍 ' + d.donde : ''}${d.rol ? '\n👤 ' + d.rol : ''}${d.stack ? '\n' + String(d.stack).split('\n').slice(0, 3).join('\n') : ''}`);
    return { ok: true, telegram: enviado };
  } catch (e) { console.error('alertar', e.message); return { ok: false }; }
}
module.exports = { alertar, telegram, detectarChat, chat };
