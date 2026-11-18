// POST /api/wa-enviar  { local, tel, texto }   (Authorization: Bearer <sesión de Supabase de alguien del local>)
// Avisos al cliente cuando su pedido cambia de estado ("en preparación", "salió para tu casa").
// Solo dentro de la ventana de 24 h que abre el propio cliente al escribir (regla de WhatsApp).
const { sbSelect, sbUsuario } = require('./_lib');
const { enviarTexto } = require('./_wa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.WA_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'WhatsApp sin configurar' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { local, tel } = b, texto = String(b.texto || '').slice(0, 1000);
    if (!local || !/^\d{8,15}$/.test(String(tel || '')) || !texto) return res.status(400).json({ error: 'Datos inválidos' });
    const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return res.status(401).json({ error: 'Iniciá sesión de nuevo' });
    const m = await sbSelect(`taca_miembros?select=rol&local_id=eq.${encodeURIComponent(local)}&user_id=eq.${user.id}`);
    if (!m.length) return res.status(403).json({ error: 'Sin acceso a ese local' });
    const [w] = await sbSelect(`taca_wa?select=phone_number_id&activo=eq.true&local_id=eq.${encodeURIComponent(local)}`);
    if (!w) return res.status(404).json({ error: 'El local no tiene WhatsApp conectado' });
    // solo a clientes que le escribieron al local (evita usarlo para mandar mensajes a cualquiera)
    const [l] = await sbSelect(`taca_locales?select=ult:data->waUlt&id=eq.${encodeURIComponent(local)}`);
    const ult = l && l.ult && l.ult[tel];
    if (!ult || Date.now() - ult > 24 * 3600e3) return res.status(409).json({ error: 'Pasaron más de 24 h desde el último mensaje del cliente' });
    await enviarTexto(w.phone_number_id, tel, texto);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('wa-enviar', e.message);
    return res.status(502).json({ error: 'No se pudo enviar el WhatsApp' });
  }
};
