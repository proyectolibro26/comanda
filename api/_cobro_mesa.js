// Registra en caja un pago de Mercado Pago hecho por el cliente desde la mesa (checkout o QR de la mesa).
// Se llama solo después de confirmar el pago con Mercado Pago. Es idempotente: si el pago ya está, no lo duplica.
const crypto = require('crypto');
const { sbRpc } = require('./_lib');
const { sb } = require('./_mpl');
const uid = () => crypto.randomBytes(6).toString('base64url');

async function registrarPagoMesa(rec, pagoId, monto, como) {
  for (let intento = 0; intento < 5; intento++) {
    const [l] = await sb('GET', `taca_locales?select=id,data,version&id=eq.${encodeURIComponent(rec.local_id)}`);
    if (!l) return false;
    const d = l.data || {};
    d.cobros = d.cobros || []; d.audit = d.audit || [];
    if (d.cobros.some(c => c.mpPago === pagoId)) break;
    const peds = (d.pedidos || []).filter(x => rec.pedidos.includes(x.id) && !x.cobrado && !x.anulado);
    const c = { id: uid(), ts: Date.now(), turno: d.turno ? d.turno.id : null, por: 'Cliente (' + (como || 'QR') + ') · Mercado Pago', grupo: 'Mesa ' + rec.mesa,
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
  return true;
}
module.exports = { registrarPagoMesa };
