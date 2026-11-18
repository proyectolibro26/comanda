// POST /api/mp-webhook  (Mercado Pago › Tus integraciones › Webhooks, eventos "Planes y suscripciones")
// Cada cobro aprobado de la suscripción suma 1 mes (o 12 si es anual) al abono del local.
// Nunca confía en el contenido de la notificación: vuelve a pedir el dato a Mercado Pago con el Access Token.
const { PERIODOS, sbRpc, mp, firmaValida, leerRef } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  const q = req.query || {};
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const tipo = body.type || q.type || q.topic || '';
  const id = String((body.data && body.data.id) || q['data.id'] || q.id || '');
  if (!id) return res.status(200).json({ ok: true });

  const secret = process.env.MP_WEBHOOK_SECRET;
  if (secret && !firmaValida(req.headers, q['data.id'] || id, secret)) return res.status(401).json({ error: 'firma inválida' });
  if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'sin configurar' });

  try {
    if (tipo === 'subscription_preapproval') {
      const pre = await mp(`/preapproval/${encodeURIComponent(id)}`);
      const ref = leerRef(pre.external_reference);
      if (ref.local) await sbRpc('taca_suscripcion_guardar', { p_local: ref.local, p_suscripcion: String(pre.id), p_estado: pre.status, p_abono: ref.plan });
    } else if (tipo === 'subscription_authorized_payment') {
      const ap = await mp(`/authorized_payments/${encodeURIComponent(id)}`);
      const pago = ap.payment || {};
      if (pago.status === 'approved' && ap.preapproval_id) {
        const pre = await mp(`/preapproval/${encodeURIComponent(ap.preapproval_id)}`);
        const ref = leerRef(pre.external_reference);
        if (ref.local) {
          const r = await sbRpc('taca_pago_registrar', {
            p_pago: 'mp-' + (pago.id || ap.id), p_local: ref.local, p_abono: ref.plan,
            p_meses: PERIODOS[ref.periodo].meses, p_monto: ap.transaction_amount || null, p_suscripcion: String(pre.id),
            p_detalle: { autorizado: ap.id, pago: pago.id, periodo: ref.periodo, email: pre.payer_email || null, fecha: ap.date_created || null }
          });
          console.log('pago registrado', ref.local, r);
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('mp-webhook', tipo, id, e.message);
    return res.status(500).json({ error: 'reintentar' }); // Mercado Pago vuelve a mandar la notificación
  }
};
