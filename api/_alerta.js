// Avisos de errores: se guardan en taca_errores y, si están las variables, llegan al Telegram de Roman Web.
//   TELEGRAM_TOKEN  token del bot (el de @BotFather)
//   TELEGRAM_CHAT   chat id donde avisar
// El mismo error no avisa de nuevo por 30 minutos (solo suma "veces"); como mucho 30 avisos por hora.
const crypto = require('crypto');
const { sb } = require('./_mpl');

async function telegram(texto) {
  const t = process.env.TELEGRAM_TOKEN, c = process.env.TELEGRAM_CHAT;
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
module.exports = { alertar, telegram };
