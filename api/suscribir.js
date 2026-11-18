// POST /api/suscribir  { local, plan: 'local'|'encendido', periodo: 'mensual'|'anual', email }
// Header: Authorization: Bearer <token de sesión de Supabase del dueño>
// Crea la suscripción en Mercado Pago y devuelve el link para que el dueño cargue su tarjeta.
const { PLANES, PERIODOS, sbRpc, sbSelect, sbUsuario, mp } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(503).json({ error: 'El cobro con Mercado Pago todavía no está configurado. Escribinos y te pasamos los datos para pagar.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { local, plan, periodo } = body;
    if (!local || !PLANES[plan] || !PERIODOS[periodo]) return res.status(400).json({ error: 'Datos inválidos' });

    const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return res.status(401).json({ error: 'Iniciá sesión de nuevo' });
    const m = await sbSelect(`taca_miembros?select=rol&local_id=eq.${encodeURIComponent(local)}&user_id=eq.${user.id}`);
    if (!m.length || m[0].rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño del local puede contratar el plan' });
    const [l] = await sbSelect(`taca_locales?select=nombre,mp_suscripcion,mp_estado&id=eq.${encodeURIComponent(local)}`);
    if (!l) return res.status(404).json({ error: 'No existe ese local' });
    if (l.mp_suscripcion && l.mp_estado === 'authorized')
      return res.status(409).json({ error: 'Ya tenés una suscripción activa. Si querés cambiar de plan, escribinos y lo hacemos sin cobrarte doble.' });

    const pl = PLANES[plan], pe = PERIODOS[periodo];
    const email = String(body.email || user.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Poné un email válido' });
    const origen = (req.headers.origin && /^https:\/\//.test(req.headers.origin)) ? req.headers.origin : 'https://' + req.headers.host;

    const pre = await mp('/preapproval', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `${local}-${plan}-${periodo}-${Date.now()}` },
      body: {
        reason: `ta-ca · Plan ${pl.nombre} ${periodo === 'anual' ? 'anual' : 'mensual'} · ${l.nombre || local}`.slice(0, 250),
        external_reference: `${local}|${plan}|${periodo}`,
        payer_email: email,
        auto_recurring: { frequency: pe.meses, frequency_type: 'months', transaction_amount: pl.precio * pe.factor, currency_id: 'ARS' },
        back_url: `${origen}/?pago=ok`,
        status: 'pending'
      }
    });
    await sbRpc('taca_suscripcion_guardar', { p_local: local, p_suscripcion: String(pre.id), p_estado: pre.status || 'pending', p_abono: plan });
    return res.status(200).json({ url: pre.init_point, id: pre.id });
  } catch (e) {
    console.error('suscribir', e.message, e.mp || '');
    const msg = e.status ? `Mercado Pago no aceptó la suscripción: ${e.message}` : 'No se pudo iniciar el pago. Probá de nuevo en un rato.';
    return res.status(502).json({ error: msg });
  }
};
