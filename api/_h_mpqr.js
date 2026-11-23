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
const { sbRpc } = require('./_lib');
const { registrarPagoMesa } = require('./_cobro_mesa');
const { telegram } = require('./_alerta');

const enc = encodeURIComponent;
const hash = (s, n) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n).toUpperCase();
const idem = () => crypto.randomUUID();
const PROVINCIAS = ['Buenos Aires', 'Capital Federal', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];

const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\([^)]*\)/g, ' ').replace(/[^a-zA-Z ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function valoresValidos(e, campo) {
  const causas = (e && e.mp && e.mp.causes) || [];
  const txt = causas.map(c => c.description || '').concat([(e && e.mp && e.mp.message) || '']).find(t => t.includes(campo) && /Valid values are:/i.test(t));
  if (!txt) return null;
  const lista = txt.split(/Valid values are:/i)[1].replace(/\.\s*$/, '').split(',').map(x => x.trim()).filter(Boolean);
  return lista.length ? lista.slice(0, 400) : null;
}
function parecida(ciudad, lista) {
  const n = norm(ciudad);
  if (!n) return null;
  return lista.find(v => norm(v) === n) || lista.find(v => norm(v).startsWith(n) || n.startsWith(norm(v))) || null;
}

async function cuenta(local) {
  const [c] = await sb('GET', `taca_mp_cuentas?select=mp_user_id,qr_store_id,qr_pos_id,qr_pos_ext,qr_estatico,qr_mesas&local_id=eq.${enc(local)}`);
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

// Que el QR no deje escribir un monto a mano: solo cobra lo que ta-ca le manda.
async function fijarMonto(token, local, c, clave, posId) {
  const m = Object.assign({}, c.qr_mesas || {});
  if (!posId || (m[clave] && m[clave].fijo)) return;
  try { await mpCon(token, `/pos/${posId}`, { method: 'PUT', body: { fixed_amount: true } }); }
  catch (e) { console.error('mp-qr fixed_amount', clave, e.message); return; }
  m[clave] = Object.assign({}, m[clave], { fijo: true });
  c.qr_mesas = m;
  await sb('PATCH', `taca_mp_cuentas?local_id=eq.${enc(local)}`, { qr_mesas: m });
}

function qrsMesas(c) {
  const m = (c && c.qr_mesas) || {};
  const o = {};
  Object.keys(m).forEach(k => { if (m[k] && m[k].qr) o[k] = m[k].qr; });
  return o;
}

// El cliente de la mesa (sin cuenta) paga con el QR de Mercado Pago pegado en su mesa.
// El monto sale de los pedidos abiertos de la mesa en el servidor, nunca del celular.
async function mesaPublica(req, res, b, ac, local) {
  const c = await cuenta(local);
  const token = c && await tokenLocal(local);
  if (!c || !token) return res.status(409).json({ error: 'Este local no tiene el pago con QR activo. Pedile la cuenta al mozo.' });
  if (ac === 'mesa-cobrar') {
    const mesa = parseInt(b.mesa, 10);
    if (!(mesa > 0 && mesa <= 200)) return res.status(400).json({ error: 'Mesa inválida' });
    const pos = (c.qr_mesas || {})[mesa];
    if (!pos || !pos.ext) return res.status(409).json({ error: 'Esta mesa todavía no tiene QR de pago. Pedile la cuenta al mozo.' });
    const [l] = await sb('GET', `taca_locales?select=data,plan,prueba_hasta,pagado_hasta&id=eq.${enc(local)}`);
    if (!l) return res.status(404).json({ error: 'No encontramos el local' });
    const est = await sbRpc('taca_estado_plan', { p_plan: l.plan, p_prueba: l.prueba_hasta, p_pagado: l.pagado_hasta });
    if (est === 'bloqueado' || l.plan === 'suspendido') return res.status(409).json({ error: 'Este local no está tomando pagos por QR. Pedile la cuenta al mozo.' });
    const d = l.data || {};
    const peds = (d.pedidos || []).filter(p => p.origen === 'mesa' && +p.mesa === mesa && !p.anulado && !p.cobrado);
    const total = Math.round(peds.reduce((a, p) => a + (+p.total || 0), 0) * 100) / 100;
    if (!peds.length || total <= 0) return res.status(409).json({ error: 'La mesa no tiene nada para pagar' });
    const ids = peds.map(p => p.id).sort();
    // un solo cobro abierto por mesa: si había otro con QR, se reusa (mismo total) o se cancela
    const prev = await sb('GET', `taca_mp_mesa?select=*&local_id=eq.${enc(local)}&mesa=eq.${mesa}&estado=eq.pendiente&orden=not.is.null&order=creado.desc&limit=3`);
    for (const r of prev) {
      const o = await mpCon(token, `/v1/orders/${r.orden}`).catch(() => null);
      const e = o ? estadoOrden(o) : { estado: 'vencido' };
      if (e.estado === 'pagado') { if (e.monto + 0.01 >= +r.total) await registrarPagoMesa(r, e.pago, e.monto, 'QR de la mesa'); return res.status(409).json({ error: 'Esta mesa ya está pagada', pagado: true }); }
      if (e.estado === 'pendiente' && +r.total === total && JSON.stringify(r.pedidos) === JSON.stringify(ids) && Date.now() - Date.parse(r.creado) < 9 * 60e3)
        return res.status(200).json({ cobro: r.id, total, vence: Date.parse(r.creado) + 10 * 60e3 });
      if (e.estado === 'pendiente') await mpCon(token, `/v1/orders/${r.orden}/cancel`, { method: 'POST', headers: { 'X-Idempotency-Key': idem() } }).catch(() => null);
      await sb('PATCH', `taca_mp_mesa?id=eq.${enc(r.id)}`, { estado: 'cancelado' });
    }
    await fijarMonto(token, local, c, String(mesa), pos.id);
    const id = 'mm_' + crypto.randomBytes(9).toString('base64url');
    const o = await mpCon(token, '/v1/orders', {
      method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: {
        type: 'qr', external_reference: id, description: `${String(d.negocio || 'ta-ca').slice(0, 40)} · Mesa ${mesa}`,
        expiration_time: 'PT10M', total_amount: total.toFixed(2),
        config: { qr: { external_pos_id: pos.ext, mode: 'static' } },
        transactions: { payments: [{ amount: total.toFixed(2) }] }
      }
    });
    await sb('POST', 'taca_mp_mesa', [{ id, local_id: local, mesa, pedidos: ids, total, orden: o.id }]);
    return res.status(200).json({ cobro: id, total, vence: Date.now() + 10 * 60e3 });
  }
  // mesa-consultar
  const cobro = String(b.cobro || '');
  if (!/^mm_[\w-]{6,30}$/.test(cobro)) return res.status(400).json({ error: 'Cobro inválido' });
  const [rec] = await sb('GET', `taca_mp_mesa?select=*&id=eq.${enc(cobro)}&local_id=eq.${enc(local)}`);
  if (!rec || !rec.orden) return res.status(404).json({ error: 'No encontramos ese cobro' });
  if (rec.estado === 'pagado') return res.status(200).json({ estado: 'pagado' });
  if (rec.estado !== 'pendiente') return res.status(200).json({ estado: rec.estado });
  const o = await mpCon(token, `/v1/orders/${rec.orden}`);
  if (o.external_reference !== rec.id) return res.status(404).json({ error: 'No encontramos ese cobro' });
  const e = estadoOrden(o);
  if (e.estado === 'pagado') {
    if (e.monto + 0.01 < +rec.total) { console.error('mp-qr mesa monto distinto', rec.id, e.monto, rec.total); return res.status(200).json({ estado: 'revisar' }); }
    await registrarPagoMesa(rec, e.pago, e.monto, 'QR de la mesa');
    return res.status(200).json({ estado: 'pagado' });
  }
  if (['cancelado', 'vencido'].includes(e.estado)) await sb('PATCH', `taca_mp_mesa?id=eq.${enc(rec.id)}`, { estado: e.estado });
  return res.status(200).json({ estado: e.estado });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const b = cuerpo(req), ac = String(b.accion || ''), local = String(b.local || '');
    if (!local) return res.status(400).json({ error: 'Falta el local' });
    if (ac === 'mesa-cobrar' || ac === 'mesa-consultar') return await mesaPublica(req, res, b, ac, local);
    const q = await quien(req, local);
    if (!q) return res.status(403).json({ error: 'Sin acceso a ese local' });
    const c = await cuenta(local);
    if (ac === 'estado') return res.status(200).json({ conectado: !!c, activo: !!(c && c.qr_pos_ext), estatico: c && c.qr_estatico || null, mesas: qrsMesas(c) });
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
        const crear = (city) => mpCon(token, `/users/${uid}/stores`, { method: 'POST', body: { name: nombre, external_id: extStore, location: { street_number: numero, street_name: calle, city_name: city, state_name: prov, latitude: lat, longitude: lng, reference: '' } } });
        try {
          let st;
          try { st = await crear(ciudad); }
          catch (e) {
            // MP solo acepta su lista de ciudades por provincia (en el interior suelen ser departamentos o partidos).
            const validas = valoresValidos(e, 'city_name');
            if (!validas) throw e;
            const elegida = parecida(ciudad, validas);
            if (!elegida) return res.status(400).json({ error: `Mercado Pago no reconoce "${ciudad}". Elegí tu ciudad, partido o departamento de la lista`, codigo: 'ciudad', ciudades: validas });
            st = await crear(elegida);
          }
          storeId = String(st.id);
        } catch (e) {
          if (valoresValidos(e, 'city_name') || valoresValidos(e, 'state_name')) throw e;
          const s = await mpCon(token, `/users/${uid}/stores/search?external_id=${extStore}`).catch(() => null);
          const r = s && (s.results || [])[0];
          if (!r) throw e;
          storeId = String(r.id);
        }
      }
      let pos;
      try {
        pos = await mpCon(token, '/v2/pos', { method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: { name: 'Caja ta-ca', store_id: storeId, external_store_id: extStore, external_id: extPos, fixed_amount: true } });
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

    if (ac === 'mesas') {
      // Un QR fijo de Mercado Pago por mesa (cada mesa es una "caja" en la sucursal del local).
      if (!q.user) return res.status(403).json({ error: 'Solo el dueño puede crear los QR de las mesas' });
      const [m] = await sb('GET', `taca_miembros?select=rol&local_id=eq.${enc(local)}&user_id=eq.${q.user}`);
      if (!m || m.rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño puede crear los QR de las mesas' });
      const [l] = await sb('GET', `taca_locales?select=data&id=eq.${enc(local)}`);
      const total = Math.max(1, Math.min(60, parseInt((l && l.data && l.data.mesas) || 0, 10) || 1));
      const extStore = 'TACA' + hash(local, 16), base = 'TACAPOS' + hash(local, 16) + 'M';
      const mesas = Object.assign({}, c.qr_mesas || {});
      const inicio = Date.now();
      for (let n = 1; n <= total; n++) {
        if (mesas[n] && mesas[n].qr) continue;
        if (Date.now() - inicio > 40e3) break; // el resto en la próxima llamada
        const ext = base + n;
        let pos;
        try { pos = await mpCon(token, '/v2/pos', { method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: { name: 'Mesa ' + n, store_id: c.qr_store_id, external_store_id: extStore, external_id: ext, fixed_amount: true } }); }
        catch (e) { const r = await mpCon(token, `/pos?external_id=${ext}`).catch(() => null); pos = r && (r.results || [])[0]; if (!pos) throw e; }
        const qr = (pos.qr_response && (pos.qr_response.qr_code || pos.qr_response.image)) || (pos.qr && (pos.qr.qr_code || pos.qr.image)) || null;
        mesas[n] = { id: String(pos.id || ''), ext, qr, fijo: pos.fixed_amount !== false };
        await sb('PATCH', `taca_mp_cuentas?local_id=eq.${enc(local)}`, { qr_mesas: mesas });
      }
      const faltan = Array.from({ length: total }, (_, i) => i + 1).filter(n => !(mesas[n] && mesas[n].qr)).length;
      return res.status(200).json({ ok: true, mesas: qrsMesas({ qr_mesas: mesas }), faltan });
    }

    if (ac === 'revisar') {
      // Respaldo: si el cliente pagó con el QR de la mesa y cerró el celular, la caja lo registra igual.
      const recs = await sb('GET', `taca_mp_mesa?select=*&local_id=eq.${enc(local)}&estado=eq.pendiente&orden=not.is.null&creado=gte.${new Date(Date.now() - 3 * 3600e3).toISOString()}&order=creado.desc&limit=10`);
      let pagados = 0;
      for (const rec of recs) {
        const o = await mpCon(token, `/v1/orders/${rec.orden}`).catch(() => null);
        if (!o || o.external_reference !== rec.id) continue;
        const e = estadoOrden(o);
        if (e.estado === 'pagado' && e.monto + 0.01 >= +rec.total) { await registrarPagoMesa(rec, e.pago, e.monto, 'QR de la mesa'); pagados++; }
        else if (['cancelado', 'vencido'].includes(e.estado)) await sb('PATCH', `taca_mp_mesa?id=eq.${enc(rec.id)}`, { estado: e.estado });
      }
      return res.status(200).json({ ok: true, pagados });
    }

    if (ac === 'cobrar') {
      const monto = Math.round(+b.monto * 100) / 100;
      if (!(monto >= 1 && monto <= 50000000)) return res.status(400).json({ error: 'Monto inválido' });
      const [l] = await sb('GET', `taca_locales?select=data&id=eq.${enc(local)}`);
      const negocio = String((l && l.data && l.data.negocio) || 'ta-ca').slice(0, 40);
      const ref = 'tq_' + crypto.randomBytes(9).toString('base64url');
      // si el cobro es de una mesa con QR propio, el monto va a ese QR (también se muestra en pantalla)
      const nm = parseInt(b.mesa, 10), pm = nm > 0 && (c.qr_mesas || {})[nm];
      let posExt = c.qr_pos_ext;
      if (pm && pm.ext) {
        posExt = pm.ext;
        const prev = await sb('GET', `taca_mp_mesa?select=id,orden&local_id=eq.${enc(local)}&mesa=eq.${nm}&estado=eq.pendiente&orden=not.is.null`);
        for (const r of prev) {
          await mpCon(token, `/v1/orders/${r.orden}/cancel`, { method: 'POST', headers: { 'X-Idempotency-Key': idem() } }).catch(() => null);
          await sb('PATCH', `taca_mp_mesa?id=eq.${enc(r.id)}`, { estado: 'cancelado' });
        }
        await fijarMonto(token, local, c, String(nm), pm.id);
      } else await fijarMonto(token, local, c, '_caja', c.qr_pos_id);
      const o = await mpCon(token, '/v1/orders', {
        method: 'POST', headers: { 'X-Idempotency-Key': idem() }, body: {
          type: 'qr', external_reference: ref, description: `${negocio} · ${String(b.ref || 'Consumo').slice(0, 40)}`,
          expiration_time: 'PT10M', total_amount: monto.toFixed(2),
          config: { qr: { external_pos_id: posExt, mode: 'hybrid' } },
          transactions: { payments: [{ amount: monto.toFixed(2) }] }
        }
      });
      const qr = o.type_response && o.type_response.qr_data;
      if (!qr) { console.error('mp-qr sin qr_data', JSON.stringify(o).slice(0, 300)); return res.status(502).json({ error: 'Mercado Pago no devolvió el QR. Probá de nuevo' }); }
      return res.status(200).json({ orden: o.id, qr, monto, vence: Date.now() + 10 * 60e3, mesa: pm ? nm : null });
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
    if (valoresValidos(e, 'state_name')) return res.status(400).json({ error: 'Mercado Pago no reconoce esa provincia. Elegí otra de la lista' });
    if (e.status === 400 && e.mp && e.mp.message) return res.status(400).json({ error: 'Mercado Pago rechazó los datos: ' + String(e.mp.message).slice(0, 160) });
    if (e.status === 401) return res.status(409).json({ error: 'Se venció la conexión con Mercado Pago. Volvé a conectarlo en Ajustes', codigo: 'no_conectado' });
    // Detalle real de Mercado Pago, para el aviso a Roman Web y para mostrarlo en pantalla.
    const m = e.mp || {}, er = (Array.isArray(m.errors) && m.errors[0]) || {};
    const det = [e.status, er.code || m.error || m.code, er.message || m.message || e.message].filter(Boolean).join(' · ').slice(0, 220);
    try { const bb = cuerpo(req); await telegram(`⚠️ QR Mercado Pago falló\nLocal: ${String(bb.local || '?').slice(0, 60)}\nAcción: ${String(bb.accion || '?').slice(0, 20)}\n${det}\n${JSON.stringify(m).slice(0, 600)}`); } catch (x) {}
    if (e.status === 403) return res.status(403).json({ error: 'Mercado Pago no habilita el cobro con QR en esta cuenta (' + det + '). Revisá que la cuenta esté validada o cobrá con otro medio' });
    if (e.status && e.status < 500) return res.status(400).json({ error: 'Mercado Pago rechazó el cobro: ' + det });
    return res.status(502).json({ error: 'Mercado Pago no respondió (' + (det || 'sin detalle') + '). Probá de nuevo o cobrá con otro medio' });
  }
};
