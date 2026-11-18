// POST /api/mesa-pagar { local, mesa }   El cliente de la mesa (QR) paga su cuenta con Mercado Pago.
// Arma el cobro con los pedidos abiertos de la mesa y abre el checkout con la cuenta de MP del local.
const { sbRpc } = require('./_lib');
const { BASE, listo, sb, tokenLocal, mpCon, cuerpo } = require('./_mpl');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!listo()) return res.status(409).json({ error: 'no_conectado' });
  try {
    const b = cuerpo(req), local = String(b.local || ''), mesa = parseInt(b.mesa, 10);
    if (!local || !(mesa > 0 && mesa <= 200)) return res.status(400).json({ error: 'Datos inválidos' });
    const token = await tokenLocal(local);
    if (!token) return res.status(409).json({ error: 'no_conectado' });
    const [l] = await sb('GET', `taca_locales?select=data,plan,prueba_hasta,pagado_hasta&id=eq.${encodeURIComponent(local)}`);
    if (!l) return res.status(404).json({ error: 'No encontramos el local' });
    const est = await sbRpc('taca_estado_plan', { p_plan: l.plan, p_prueba: l.prueba_hasta, p_pagado: l.pagado_hasta });
    if (est === 'bloqueado' || l.plan === 'suspendido') return res.status(409).json({ error: 'Este local no está tomando pagos por QR. Pedile la cuenta al mozo.' });
    const d = l.data || {};
    const peds = (d.pedidos || []).filter(p => p.origen === 'mesa' && +p.mesa === mesa && !p.anulado && !p.cobrado);
    const total = Math.round(peds.reduce((a, p) => a + (+p.total || 0), 0) * 100) / 100;
    if (!peds.length || total <= 0) return res.status(409).json({ error: 'La mesa no tiene nada para pagar' });
    const ids = peds.map(p => p.id).sort();

    // si ya había un cobro igual sin pagar (tocó dos veces), se reusa
    const prev = await sb('GET', `taca_mp_mesa?select=id,pedidos,total,creado&local_id=eq.${encodeURIComponent(local)}&mesa=eq.${mesa}&estado=eq.pendiente&order=creado.desc&limit=1`);
    let id = prev[0] && +prev[0].total === total && JSON.stringify(prev[0].pedidos) === JSON.stringify(ids) && Date.now() - Date.parse(prev[0].creado) < 60 * 60e3 ? prev[0].id : null;
    if (!id) {
      id = 'mm_' + crypto.randomBytes(9).toString('base64url');
      await sb('POST', 'taca_mp_mesa', [{ id, local_id: local, mesa, pedidos: ids, total }]);
    }
    const volver = r => `${BASE}/?l=${encodeURIComponent(local)}&mesa=${mesa}&mpmesa=${r}`;
    const pref = await mpCon(token, '/checkout/preferences', {
      method: 'POST', body: {
        items: [{ id: 'mesa-' + mesa, title: `Mesa ${mesa} · ${String(d.negocio || 'Consumo').slice(0, 60)}`, quantity: 1, unit_price: total, currency_id: 'ARS' }],
        external_reference: id,
        notification_url: `${BASE}/api/mp-mesa?c=${id}`,
        back_urls: { success: volver('ok'), pending: volver('pendiente'), failure: volver('error') },
        auto_return: 'approved',
        statement_descriptor: String(d.negocio || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22) || undefined,
        expires: true, expiration_date_to: new Date(Date.now() + 2 * 3600e3).toISOString()
      }
    });
    return res.status(200).json({ url: pref.init_point, total });
  } catch (e) {
    console.error('mesa-pagar', e.message, JSON.stringify(e.mp || {}).slice(0, 300));
    if (e.status === 401) return res.status(409).json({ error: 'no_conectado' });
    return res.status(502).json({ error: 'No se pudo abrir Mercado Pago. Pedile la cuenta al mozo.' });
  }
};
