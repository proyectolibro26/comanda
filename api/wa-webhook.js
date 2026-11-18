// GET  /api/wa-webhook  verificación de Meta (hub.challenge)
// POST /api/wa-webhook  mensajes que llegan a los números de WhatsApp de los locales
// El bot de ta-ca contesta, arma pedidos y reservas y los guarda en el local (la cocina los ve al instante).
const { sbRpc, sbSelect } = require('./_lib');
const { correrBot, enviarTexto, firmaMetaValida, leerCuerpo } = require('./_wa');

function planHabilitado(l) {
  if (l.plan === 'suspendido') return false;
  const vence = l.plan === 'activo' ? l.pagado_hasta : l.prueba_hasta;
  if (vence && Date.parse(vence) + 3 * 864e5 < Date.now()) return false; // en pausa por falta de pago
  return l.plan !== 'activo' || l.abono === 'encendido';               // pagando: solo el plan Encendido trae WhatsApp
}

async function procesar(phoneId, msg, contacto) {
  const [w] = await sbSelect(`taca_wa?select=local_id&phone_number_id=eq.${encodeURIComponent(phoneId)}`);
  if (!w) return console.log('wa: número sin local', phoneId);
  const tel = msg.from;
  let texto = '';
  if (msg.type === 'text') texto = msg.text.body;
  else if (msg.type === 'interactive') texto = (msg.interactive.button_reply || msg.interactive.list_reply || {}).title || '';
  else if (msg.type === 'button') texto = msg.button.text;

  for (let intento = 0; intento < 4; intento++) {
    const [l] = await sbSelect(`taca_locales?select=id,data,version,plan,prueba_hasta,pagado_hasta,abono&id=eq.${encodeURIComponent(w.local_id)}`);
    if (!l) return;
    const data = l.data || {};
    data.waVistos = data.waVistos || [];
    if (data.waVistos.includes(msg.id)) return; // Meta reintenta: no contestar dos veces
    if (!planHabilitado(l)) {
      if (intento === 0) await enviarTexto(phoneId, tel, `Gracias por escribir a ${data.negocio || 'nuestro local'} 🙌 En este momento no estamos tomando pedidos por acá. Llamanos o acercate al local.`).catch(() => {});
      return;
    }
    let respuestas;
    if (!texto) respuestas = ['Por ahora solo entiendo mensajes de texto 🙂 Escribí *menú* para ver la carta o *reservar* para pedir una mesa.'];
    else respuestas = correrBot(data, tel, texto, contacto && contacto.profile && contacto.profile.name);
    data.waVistos = data.waVistos.concat(msg.id).slice(-200);
    if (!texto) { data.waConv = data.waConv || {}; }
    const g = await sbRpc('taca_guardar_servidor', { p_id: l.id, p_data: data, p_version: l.version });
    if (g && g.ok) {
      for (const t of respuestas) await enviarTexto(phoneId, tel, t);
      return;
    }
    // otro equipo guardó justo al mismo tiempo: se vuelve a leer y se corre de nuevo
  }
  console.error('wa: no se pudo guardar después de 4 intentos', w.local_id);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && q['hub.verify_token'] === process.env.WA_VERIFY_TOKEN)
      return res.status(200).send(String(q['hub.challenge'] || ''));
    return res.status(403).send('no');
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.WA_TOKEN || !process.env.WA_APP_SECRET || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'sin configurar' });
  const raw = await leerCuerpo(req);
  if (!firmaMetaValida(raw, req.headers['x-hub-signature-256'], process.env.WA_APP_SECRET)) return res.status(401).json({ error: 'firma inválida' });
  let body; try { body = JSON.parse(raw || '{}'); } catch (e) { return res.status(400).end(); }
  try {
    for (const entry of body.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const phoneId = v.metadata && v.metadata.phone_number_id;
      for (const m of v.messages || []) {
        const c = (v.contacts || []).find(x => x.wa_id === m.from);
        await procesar(phoneId, m, c);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('wa-webhook', e.message);
    return res.status(500).json({ error: 'reintentar' });
  }
};
