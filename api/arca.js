// POST /api/arca { accion, ... }   Factura electrónica ARCA.
//   info                         (público)   CUIT de Roman Web para que el local delegue, y si está listo
//   estado | csr | cert | activar (admin)    certificado de Roman Web
//   probar  { local }            (dueño)     revisa que el local delegó y tiene el punto de venta
//   facturar { local, cobro, receptor }  (dueño o caja)  pide el CAE y lo guarda en el cobro
//   nc { local, cobro }          (dueño o caja)  nota de crédito de esa factura
// Equipos vinculados mandan su llave en el encabezado X-Taca-Equipo; los demás, la sesión (Authorization: Bearer).
const { sbRpc, sbUsuario } = require('./_lib');
const { sb, cuerpo } = require('./_mpl');
const A = require('./_arca');

async function config(env) {
  const q = env ? `env=eq.${env}` : 'activo=eq.true';
  const [c] = await sb('GET', `taca_arca_config?select=*&${q}&limit=1`);
  return c || null;
}
async function esAdmin(req) {
  const u = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!u || !u.id) return false;
  return (await sb('GET', `taca_admins?select=user_id&user_id=eq.${u.id}`)).length > 0;
}
// rol de quien pide en ese local: 'dueno' | 'cajera' | ... | null
async function rolEn(req, local) {
  const eq = req.headers['x-taca-equipo'];
  if (eq) { const i = await sbRpc('taca_eq_info', { p_token: String(eq) }); return i && i.local === local ? i.rol : null; }
  const u = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!u || !u.id) return null;
  const m = await sb('GET', `taca_miembros?select=rol&local_id=eq.${encodeURIComponent(local)}&user_id=eq.${u.id}`);
  return m.length ? 'dueno' : null;
}
async function ta(c) {
  const [t] = await sb('GET', `taca_arca_ta?select=*&env=eq.${c.env}`);
  if (t && Date.parse(t.expira) - Date.now() > 10 * 60e3) return t;
  const n = await A.login(c.env, c.cert_pem, c.key_pem);
  await sb('POST', 'taca_arca_ta?on_conflict=env', [{ env: c.env, token: n.token, sign: n.sign, expira: n.expira }], 'resolution=merge-duplicates');
  return n;
}
// errores de ARCA en castellano de mostrador
function amable(m) {
  m = String(m || '');
  if (/no autorizado|not authorized|no se encuentra autorizado|representad|delega|relaci/i.test(m)) return 'ARCA dice que este CUIT no delegó la facturación a Roman Web. Revisá el paso de "Delegar" en ARCA. (' + m + ')';
  if (/punto de venta|PtoVta/i.test(m)) return 'El punto de venta no está dado de alta como "Web Services" en ARCA, o el número no coincide. (' + m + ')';
  if (/TA valido|ya posee/i.test(m)) return 'ARCA está renovando la conexión. Probá de nuevo en unos minutos.';
  if (/certificad|cms|firma/i.test(m)) return 'Hay un problema con el certificado de Roman Web en ARCA. (' + m + ')';
  if (/no respondió|ECONN|ETIMEDOUT|socket|ENOTFOUND/i.test(m)) return 'ARCA no responde en este momento. El cobro quedó guardado: podés facturarlo más tarde.';
  return m || 'ARCA rechazó el comprobante';
}
// guarda la factura dentro del cobro (todos los equipos la ven al instante)
async function guardarEnCobro(local, cobroId, cambio) {
  for (let i = 0; i < 6; i++) {
    const [l] = await sb('GET', `taca_locales?select=id,data,version&id=eq.${encodeURIComponent(local)}`);
    const d = l.data || {}, c = (d.cobros || []).find(x => x.id === cobroId);
    if (!c) return false;
    cambio(c, d);
    const g = await sbRpc('taca_guardar_servidor', { p_id: local, p_data: d, p_version: l.version });
    if (g && g.ok) return true;
  }
  throw new Error('No se pudo guardar la factura en el cobro');
}
const cuitOk = s => /^\d{11}$/.test(String(s || '').replace(/\D/g, ''));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const b = cuerpo(req), acc = b.accion;
  try {
    if (acc === 'info') {
      const c = await config();
      return res.status(200).json({ listo: !!(c && c.cert_pem && c.key_pem), cuit: c ? c.cuit : null, prueba: c ? c.env === 'homo' : null });
    }

    /* ---- certificado de Roman Web (solo admin) ---- */
    if (['estado', 'csr', 'cert', 'activar'].includes(acc)) {
      if (!(await esAdmin(req))) return res.status(403).json({ error: 'Solo Roman Web' });
      if (acc === 'estado') {
        const l = await sb('GET', 'taca_arca_config?select=env,cuit,cert_pem,key_pem,csr_pem,activo,actualizado');
        return res.status(200).json(l.map(c => ({ env: c.env, cuit: c.cuit, activo: c.activo, llave: !!c.key_pem, pedido: c.csr_pem || null, cert: c.cert_pem ? A.datosCert(c.cert_pem) : null })));
      }
      const env = b.env === 'prod' ? 'prod' : 'homo';
      if (acc === 'csr') {
        const cuit = String(b.cuit || '').replace(/\D/g, '');
        if (!cuitOk(cuit)) return res.status(400).json({ error: 'El CUIT tiene que tener 11 números' });
        const prev = await config(env);
        const key = prev && prev.key_pem && !b.nueva ? prev.key_pem : A.nuevaLlave();
        const csr = A.pedidoCertificado(key, cuit, 'Roman Web');
        await sb('POST', 'taca_arca_config?on_conflict=env', [{ env, cuit, key_pem: key, csr_pem: csr, cert_pem: prev && prev.key_pem === key ? prev.cert_pem : null, activo: prev ? prev.activo : false, actualizado: new Date().toISOString() }], 'resolution=merge-duplicates');
        return res.status(200).json({ ok: true, pedido: csr });
      }
      if (acc === 'cert') {
        const c = await config(env);
        if (!c || !c.key_pem) return res.status(400).json({ error: 'Primero generá el pedido de certificado' });
        const pem = String(b.cert || '').trim();
        if (!A.datosCert(pem)) return res.status(400).json({ error: 'Eso no parece un certificado. Pegá todo el texto, desde -----BEGIN CERTIFICATE-----' });
        if (!A.certEsDeLaLlave(pem, c.key_pem)) return res.status(400).json({ error: 'Ese certificado no corresponde al último pedido que generaste acá' });
        await sb('PATCH', `taca_arca_config?env=eq.${env}`, { cert_pem: pem, actualizado: new Date().toISOString() });
        await sb('PATCH', `taca_arca_ta?env=eq.${env}`, { expira: new Date(0).toISOString() });
        let prueba = null;
        try { const t = await ta(Object.assign({}, c, { cert_pem: pem })); prueba = { ok: true, vence: t.expira }; }
        catch (e) { prueba = { ok: false, error: amable(e.arca || e.message) }; }
        return res.status(200).json({ ok: true, cert: A.datosCert(pem), prueba });
      }
      if (acc === 'activar') {
        const c = await config(env);
        if (!c || !c.cert_pem) return res.status(400).json({ error: 'Ese ambiente todavía no tiene certificado' });
        await sb('PATCH', 'taca_arca_config?activo=eq.true', { activo: false });
        await sb('PATCH', `taca_arca_config?env=eq.${env}`, { activo: true });
        return res.status(200).json({ ok: true });
      }
    }

    /* ---- locales ---- */
    const local = String(b.local || '');
    if (!local) return res.status(400).json({ error: 'Falta el local' });
    const rol = await rolEn(req, local);
    if (!rol || !['dueno', 'cajera'].includes(rol)) return res.status(403).json({ error: 'Solo el dueño o la caja pueden facturar' });
    const c = await config();
    if (!c || !c.cert_pem) return res.status(409).json({ error: 'La factura electrónica todavía no está activa en ta-ca' });
    const [l] = await sb('GET', `taca_locales?select=data&id=eq.${encodeURIComponent(local)}`);
    const f = (l && l.data && l.data.arca) || {};
    const cuit = String(f.cuit || '').replace(/\D/g, ''), pto = parseInt(f.ptoVta, 10), ri = f.condicion === 'RI', alic = [21, 10.5, 27, 0].includes(+f.iva) ? +f.iva : 21;
    if (!cuitOk(cuit) || !(pto > 0 && pto < 100000)) return res.status(400).json({ error: 'Completá el CUIT y el punto de venta del local en QR y ajustes › Factura electrónica' });
    const t = await ta(c);

    if (acc === 'probar') {
      const n = await A.ultimo(c.env, t, cuit, pto, ri ? 6 : 11);
      return res.status(200).json({ ok: true, ultimo: n, tipo: ri ? 'Factura B' : 'Factura C', prueba: c.env === 'homo' });
    }

    const cob = ((l.data.cobros) || []).find(x => x.id === b.cobro);
    if (!cob) return res.status(404).json({ error: 'No encontramos ese cobro. Esperá un segundo a que se guarde y probá de nuevo.' });

    if (acc === 'facturar') {
      if (cob.anulado) return res.status(409).json({ error: 'Ese cobro está anulado' });
      const prev = await sb('GET', `taca_facturas?select=data&local_id=eq.${encodeURIComponent(local)}&cobro_id=eq.${encodeURIComponent(cob.id)}&env=eq.${c.env}&order=id.asc`);
      const facturas = prev.map(x => x.data), yaFact = facturas.filter(x => A.NC[x.tipo]).pop();   // la última factura (no nota de crédito)
      if (yaFact && !facturas.some(x => x.asoc && x.asoc.nro === yaFact.nro && x.asoc.tipo === yaFact.tipo))
        return res.status(200).json({ ok: true, factura: yaFact, ya: true });
      const r = b.receptor || {}, nro = String(r.nro || '').replace(/\D/g, '');
      let doc = { tipo: 99, nro: 0 }, cond = 5;
      if (r.doc === 'cuit') { if (!cuitOk(nro)) return res.status(400).json({ error: 'El CUIT del cliente tiene que tener 11 números' }); doc = { tipo: 80, nro }; cond = [1, 4, 6, 13].includes(+r.cond) ? +r.cond : 1; }
      else if (r.doc === 'dni') { if (!/^\d{7,8}$/.test(nro)) return res.status(400).json({ error: 'El DNI tiene que tener 7 u 8 números' }); doc = { tipo: 96, nro }; }
      const tipo = !ri ? 11 : (doc.tipo === 80 && (cond === 1 || cond === 13) ? 1 : 6);
      const total = Math.round((+cob.total || 0) * 100) / 100;   // la propina no se factura (cob.total ya viene sin propina)
      if (total <= 0) return res.status(409).json({ error: 'El cobro no tiene importe para facturar' });
      const fx = await A.autorizar(c.env, t, { tipo, ptoVta: pto, cuit, total, iva: alic, doc, condRec: cond });
      fx.qr = A.qr(cuit, fx); fx.env = c.env; fx.cliente = r.nombre ? String(r.nombre).slice(0, 60) : '';
      await sb('POST', 'taca_facturas', [{ local_id: local, cobro_id: cob.id, env: c.env, tipo: fx.tipo, pto: fx.pto, nro: fx.nro, cae: fx.cae, total: fx.total, data: fx }]);
      await guardarEnCobro(local, cob.id, x => { x.factura = fx; });
      return res.status(200).json({ ok: true, factura: fx });
    }

    if (acc === 'nc') {
      const fa = cob.factura;
      if (!fa || !A.NC[fa.tipo]) return res.status(409).json({ error: 'Ese cobro no tiene factura' });
      if (fa.nc) return res.status(200).json({ ok: true, nc: fa.nc, ya: true });
      const nc = await A.autorizar(c.env, t, { tipo: A.NC[fa.tipo], ptoVta: pto, cuit, total: fa.total, iva: fa.alicuota || alic, doc: fa.doc, condRec: fa.condRec || 5, asoc: { tipo: fa.tipo, pto: fa.pto, nro: fa.nro, fecha: fa.fecha } });
      nc.qr = A.qr(cuit, nc); nc.env = c.env; nc.asoc = { tipo: fa.tipo, nro: fa.nro };
      await sb('POST', 'taca_facturas', [{ local_id: local, cobro_id: cob.id, env: c.env, tipo: nc.tipo, pto: nc.pto, nro: nc.nro, cae: nc.cae, total: nc.total, data: nc }]);
      await guardarEnCobro(local, cob.id, (x, d) => {
        x.factura.nc = nc;
        (d.audit = d.audit || []).push({ id: 'nc' + nc.nro, ts: Date.now(), por: rol === 'dueno' ? 'Dueño' : 'Caja', accion: 'Nota de crédito', detalle: `${nc.nombre} ${String(nc.pto).padStart(5, '0')}-${String(nc.nro).padStart(8, '0')} por la ${fa.nombre} ${String(fa.pto).padStart(5, '0')}-${String(fa.nro).padStart(8, '0')}`, monto: nc.total });
      });
      return res.status(200).json({ ok: true, nc });
    }
    return res.status(400).json({ error: 'Acción inválida' });
  } catch (e) {
    console.error('arca', acc, e.message);
    if (!e.arca) require('./_alerta').alertar('arca ' + acc, e.message, null, b.local);
    return res.status(502).json({ error: amable(e.arca || e.message) });
  }
};
