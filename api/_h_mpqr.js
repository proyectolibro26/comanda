// /api/mp-qr  Cobro en caja con QR de Mercado Pago (API de Orders, modo híbrido: QR en pantalla + QR fijo impreso).
//   POST { accion:'estado',   local }                         → { conectado, activo, estatico }
//   POST { accion:'activar',  local, dir:{calle,numero,ciudad,provincia,lat,lng} }   (solo el dueño) crea sucursal y caja
//   POST { accion:'cobrar',   local, monto, ref }             → { orden, qr, vence }
//   POST { accion:'consultar',local, orden }                  → { estado:'pendiente'|'pagado'|'cancelado'|'vencido', pago, monto }
//   POST { accion:'cancelar', local, orden }
// Quién: miembro del local (Bearer de Supabase) o equipo vinculado (x-equipo). La plata va directo a la cuenta del local.
const crypto = require('crypto');
const { sb, tokenLocal, mpCon, cuerpo } = require('./_mpl');
const { quien } = require('./_h_push');

const enc = encodeURIComponent;
const hash = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n).toUpperCase();
const idem = () => crypto.randomUUID();
const PROVINCIAS = ['Buenos Aires', 'Capital Federal', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];

async function cuenta(local) {
  const [c] = await sb('GET', `taca_mp_cuentas?select=mp_user_id,qr_store_id,qr_pos_id,qr_pos_ext,qr_estatico&local_id=eq.${enc(local)}`);
  return c || null;
}
function estadoOrden(o) {
  const pagos = (o.transactions && o.transactions.payments) || [];
  const ok = pagos.find(p => ['processed', 'approved', 'accredited'].includes(p.status) || p.status_detail === 'accredited');
  if (o.status === 'processed' || ok) return { estado: 'pagado', pago: String((ok || pagos[0] || {}).id || o.id), monto: +((ok || pagos[0] || {}).paid_amount || (ok || pagos[0] || {}).amount || o.total_paid_amount || o.total_amount || 0) };
  if (o.status === 'canceled') return { estado: 'cancelado' };
  if (o.status === 'expired') return { estado: 'vencido' };
  if (['refunded', 'reverted'].includes(o.status)) return { estado: 'devuelto' };
  return { estado: 'pendiente' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const b = cuerpo(req), ac = String(b.accion || ''), local = String(b.local || '');
    if (!local) return res.status(400).json({ error: 'Falta el local' });
    const q = await quien(req, local);
    if (!q) return res.status(403).json({ error: 'Sin acceso a ese local' });
    const c = await cuenta(local);
    if (ac === 'estado') return res.status(200).json({ conectado: !!c, activo: !!(c && c.qr_pos_ext), estatico: c && c.qr_estatico || null });
    if (!c) return res.status(409).json({ error: 'Primero conectá el Mercado Pago del local en Ajustes', codigo: 'no_conectado' });
    const token = await tokenLocal(local);
    if (!token) return res.status(409).json({ error: 'Primero conectá el Mercado Pago del local en Ajustes', codigo: 'no_conectado' });

    if (ac === 'activar') {
      if (!q.user) return res.status(403).json({ error: 'Solo el dueño puede activar el cobro con QR' });
      const [m] = await sb('GET', `taca_miembros?select=rol&local_id=eq.${enc(local)}&user_id=eq.${q.user}`);
      if (!m || m.rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño puede activar el cobro con QR' });
      const d = b.dir || {}, calle = String(d.calle || '').trim().slice(0, 80), numero = String(d.numero || '').trim().slice(0, 10), ciudad = String(d.ciudad || '').trim().slice(0, 60), prov = PROVINCIAS.includes(d.provincia) ? d.provincia : '';
      const lat = +d.lat, lng = +d.lng;
      if (!calle || !numero || !ciudad || !prov || !(lat >= -56 && lat <= -21) || !(lng >= -74 && lng <= -53)) return res.status(400).json({ error: 'Completá la dirección del local y su ubicación' });
      const [l] = await sb('GET', `taca_locales?select=data&id=eq.${enc(local)}`);
      const nombre = String((l && l.data && l.data.negocio) || 'Mi local').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Mi local';
      const uid = c.mp_user_id || String((await mpCon(token, '/users/me')).id);
      const extStore = 'TACA' + hash(local, 16), extPos = 'TACAPOS' + hash(local, 16);
      let storeId = c.qr_store_id;
      if (!storeId) {
        try {
          const st = await mpCon(token, `/users/${uid}/stores`, { method: 'POST', body: { name: nombre, external_id: extStore, location: { street_number: numero, street_name: calle, city_name: ciudad, state_name: prov, latitude: lat, longitude: lng, reference: '' } } });
          storeId = String(st.id);
        } catch (e) {
          const s = await mpCon(token, `/users/${uid}/stores/search?external_id=${extStore}`).catch(() => null);
          const r = s && (s.results || [])[0];
          if (!r) throw e;
          storeId = String(r.id);
        }
      }
      let pos;
      try {
        pos = await mpCon(token, '/v2/pos', { method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: { name: 'Caja ta-ca', store_id: storeId, external_store_id: extStore, external_id: extPos } });
      } catch (e) {
        const s = await mpCon(token, `/pos?external_id=${extPos}`).catch(() => null);
        pos = s && (s.results || [])[0];
        if (!pos) throw e;
      }
      const qr = (pos.qr_response && (pos.qr_response.qr_code || pos.qr_response.image)) || (pos.qr && (pos.qr.qr_code || pos.qr.image)) || null;
      await sb('PATCH', `taca_mp_cuentas?local_id=eq.${enc(local)}`, { qr_store_id: storeId, qr_pos_id: String(pos.id || ''), qr_pos_ext: extPos, qr_estatico: qr });
      return res.status(200).json({ ok: true, activo: true, estatico: qr });
    }

    if (!c.qr_pos_ext) return res.status(409).json({ error: 'Activá el cobro con QR en Ajustes', codigo: 'sin_activar' });

    if (ac === 'cobrar') {
      const monto = Math.round(+b.monto * 100) / 100;
      if (!(monto >= 1 && monto <= 50000000)) return res.status(400).json({ error: 'Monto inválido' });
      const [l] = await sb('GET', `taca_locales?select=data&id=eq.${enc(local)}`);
      const negocio = String((l && l.data && l.data.negocio) || 'ta-ca').slice(0, 40);
      const ref = 'tq_' + crypto.randomBytes(9).toString('base64url');
      const o = await mpCon(token, '/v1/orders', {
        method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: {
          type: 'qr', external_reference: ref, description: `${negocio} · ${String(b.ref || 'Consumo').slice(0, 40)}`,
          expiration_time: 'PT10M', total_amount: monto.toFixed(2),
          config: { qr: { external_pos_id: c.qr_pos_ext, mode: 'hybrid' } },
          transactions: { payments: [{ amount: monto.toFixed(2) }] }
        }
      });
      const qr = o.type_response && o.type_response.qr_data;
      if (!qr) { console.error('mp-qr sin qr_data', JSON.stringify(o).slice(0, 300)); return res.status(502).json({ error: 'Mercado Pago no devolvió el QR. Probá de nuevo' }); }
      return res.status(200).json({ orden: o.id, qr, monto, vence: Date.now() + 10 * 60e3 });
    }
    const orden = String(b.orden || '');
    if (!/^ORD[A-Z0-9]{10,40}$/.test(orden)) return res.status(400).json({ error: 'Orden inválida' });
    if (ac === 'consultar') {
      const o = await mpCon(token, `/v1/orders/${orden}`);
      if (!String(o.external_reference || '').startsWith('tq_')) return res.status(404).json({ error: 'No es un cobro de ta-ca' });
      return res.status(200).json(estadoOrden(o));
    }
    if (ac === 'cancelar') {
      try { await mpCon(token, `/v1/orders/${orden}/cancel`, { method: 'POST', headers: { 'X-Idempotency-Key': idem() } }); }
      catch (e) { if (e.status !== 409) throw e; const o = await mpCon(token, `/v1/orders/${orden}`); return res.status(200).json(estadoOrden(o)); }
      return res.status(200).json({ estado: 'cancelado' });
    }
    return res.status(400).json({ error: 'Acción inválida' });
  } catch (e) {
    console.error('mp-qr', e.message, JSON.stringify(e.mp || {}).slice(0, 300));
    if (e.status === 401) return res.status(409).json({ error: 'Se venció la conexión con Mercado Pago. Volvé a conectarlo en Ajustes', codigo: 'no_conectado' });
    return res.status(502).json({ error: 'Mercado Pago no respondió. Probá de nuevo o cobrá con otro medio' });
  }
};
