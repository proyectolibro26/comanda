// POST /api/mp-mesa?c=<cobro>   Aviso de Mercado Pago de un pago hecho desde la mesa.
// No se confía en el aviso: se consulta el pago a Mercado Pago con la cuenta del local y recién ahí se cobra en caja.
const { sbRpc } = require('./_lib');
const { sb, tokenLocal, mpCon } = require('./_mpl');
const crypto = require('crypto');
const uid = () => crypto.randomBytes(6).toString('base64url');

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

    for (let intento = 0; intento < 5; intento++) {
      const [l] = await sb('GET', `taca_locales?select=id,data,version&id=eq.${encodeURIComponent(rec.local_id)}`);
      if (!l) return res.status(200).json({ ignorado: true });
      const d = l.data || {};
      d.cobros = d.cobros || []; d.audit = d.audit || [];
      if (d.cobros.some(c => c.mpPago === pagoId)) break;
      const peds = (d.pedidos || []).filter(x => rec.pedidos.includes(x.id) && !x.cobrado && !x.anulado);
      const c = { id: uid(), ts: Date.now(), turno: d.turno ? d.turno.id : null, por: 'Cliente (QR) · Mercado Pago', grupo: 'Mesa ' + rec.mesa,
        pedidos: peds.map(x => x.id), subtotal: monto, descPct: 0, descuento: 0, propina: 0, total: monto,
        pagos: { efectivo: 0, mp: monto, tarjeta: 0, transferencia: 0 }, anulado: false, mpPago: pagoId };
      peds.forEach(x => { x.cobrado = true; x.cobroId = c.id; x.pideCuenta = false; });
      d.cobros.push(c);
      if (peds.length < rec.pedidos.length)
        d.audit.push({ id: uid(), ts: Date.now(), por: 'Mercado Pago', accion: 'Revisar pago de mesa', detalle: `Mesa ${rec.mesa}: entró un pago por Mercado Pago (#${pagoId}) de pedidos que ya estaban cobrados o anulados. Revisá si hay que devolverlo.`, monto });
      d.llamados = (d.llamados || []).filter(x => x.mesa !== rec.mesa);
      const g = await sbRpc('taca_guardar_servidor', { p_id: l.id, p_data: d, p_version: l.version });
      if (g && g.ok) break;
      if (intento === 4) throw new Error('no se pudo guardar');
    }
    await sb('PATCH', `taca_mp_mesa?id=eq.${encodeURIComponent(rec.id)}`, { estado: 'pagado', pago_id: pagoId });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('mp-mesa', e.message);
    return res.status(500).json({ error: 'reintentar' });
  }
};
