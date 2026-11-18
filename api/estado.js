// GET /api/estado — chequeo de solo lectura: ¿las claves de Mercado Pago y Supabase funcionan? (no crea ni cobra nada)
const { mp, sbSelect } = require('./_lib');

module.exports = async (req, res) => {
  const out = { mercadopago: false, supabase: false, webhook_firma: !!process.env.MP_WEBHOOK_SECRET, produccion: null };
  try { const u = await mp('/users/me'); out.mercadopago = !!u.id; out.produccion = !String(process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-'); } catch (e) { out.mercadopago_error = e.status || 'sin conexión'; }
  try { await sbSelect('taca_locales?select=id&limit=1'); out.supabase = true; } catch (e) { out.supabase_error = String(e.message).slice(0, 60); }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
