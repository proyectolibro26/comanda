// POST /api/mp-mesa?c=<cobro>   Aviso de Mercado Pago de un pago hecho desde la mesa.
// No se confía en el aviso: se consulta el pago a Mercado Pago con la cuenta del local y recién ahí se cobra en caja.
const { sb, tokenLocal, mpCon } = require('./_mpl');
const { registrarPagoMesa } = require('./_cobro_mesa');

module.exports = async (req, res) => {
  const q = req.query || {};
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
  const tipo = b.type || q.type || q.topic;
  const pagoId = String((b.data && b.data.id) || q['data.id'] || (q.topic === 'payment' ? q.id : '') || '');
  const cobro = String(q.c || '');
  if (tipo !== 'payment' || !/^\d+$/.test(pagoId) || !/^mm_[\w-]+$/.test(cobro)) return res.status(200).json({ ignorado: true });
  try {
    const [rec] = await sb('GET', `taca_mp_mesa?select=*&id=eq.${encodeURIComponent(cobro)}`);
    if (!rec) return res.status(200).json({ ignorado: true });
    if (rec.estado === 'pagado') return res.status(200).json({ ok: true, ya: true });
    const token = await tokenLocal(rec.local_id);
    if (!token) return res.status(200).json({ ignorado: true });
    const p = await mpCon(token, `/v1/payments/${pagoId}`);
    if (p.external_reference !== rec.id) return res.status(200).json({ ignorado: true });
    if (p.status !== 'approved') return res.status(200).json({ estado: p.status });
    const monto = +p.transaction_amount || 0;
    if (p.currency_id !== 'ARS' || monto + 0.01 < +rec.total) { console.error('mp-mesa monto distinto', cobro, monto, rec.total); return res.status(200).json({ revisar: true }); }

    await registrarPagoMesa(rec, pagoId, monto, 'QR');
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('mp-mesa', e.message);
    await require('./_alerta').alertar('aviso de pago en la mesa', e.message, { donde: 'cobro ' + cobro });
    return res.status(500).json({ error: 'reintentar' });
  }
};
