// /api/push  Notificaciones con la app cerrada.
//   GET                                   → { clave } pública para suscribir el navegador
//   POST { accion:'suscribir', local, sub }   guarda este equipo para recibir avisos del local
//   POST { accion:'quitar', endpoint }
//   POST { accion:'avisar', local, titulo, avisos:[{clave,texto}], excepto }   avisa a los equipos del local
//   POST { accion:'prueba', local }
// Quién: sesión de Supabase de un miembro del local (Authorization: Bearer …) o un equipo vinculado (x-equipo: token).
const crypto = require('crypto');
const { sbUsuario } = require('./_lib');
const { sb } = require('./_mpl');
const { vapid, enviar, endpointOk } = require('./_webpush');

const enc = encodeURIComponent;
async function quien(req, local) {
  const eq = String(req.headers['x-equipo'] || '');
  if (eq) {
    const h = crypto.createHash('sha256').update(eq).digest('hex');
    const [e] = await sb('GET', `taca_equipos?select=id,local_id&token_hash=eq.${h}&activo=eq.true`);
    return e && e.local_id === local ? { equipo: e.id } : null;
  }
  const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!user || !user.id) return null;
  const m = await sb('GET', `taca_miembros?select=rol&local_id=eq.${enc(local)}&user_id=eq.${user.id}`);
  return m.length ? { user: user.id } : null;
}
async function mandar(local, datos, excepto) {
  const subs = await sb('GET', `taca_push?select=endpoint,p256dh,auth&local_id=eq.${enc(local)}`);
  let ok = 0;
  await Promise.all(subs.filter(s => s.endpoint !== excepto).map(async s => {
    try {
      const st = await enviar({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, datos);
      if (st === 404 || st === 410) await sb('DELETE', `taca_push?endpoint=eq.${enc(s.endpoint)}`);
      else if (st >= 200 && st < 300) ok++;
      else console.error('push', st, new URL(s.endpoint).hostname);
    } catch (e) { console.error('push', e.message); }
  }));
  return { equipos: subs.length, enviados: ok };
}

const handler = async (req, res) => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'Sin configurar' });
  try {
    if (req.method === 'GET') return res.status(200).json({ clave: vapid().publica });
    if (req.method !== 'POST') return res.status(405).end();
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ac = String(b.accion || '');
    if (ac === 'quitar') {
      if (endpointOk(b.endpoint)) await sb('DELETE', `taca_push?endpoint=eq.${enc(b.endpoint)}`);
      return res.status(200).json({ ok: true });
    }
    const local = String(b.local || '');
    if (!local) return res.status(400).json({ error: 'Falta el local' });
    const q = await quien(req, local);
    if (!q) return res.status(403).json({ error: 'Sin acceso a ese local' });

    if (ac === 'suscribir') {
      const s = b.sub || {}, k = s.keys || {};
      if (!endpointOk(s.endpoint) || !/^[\w-]{80,100}$/.test(k.p256dh || '') || !/^[\w-]{16,30}$/.test(k.auth || '')) return res.status(400).json({ error: 'Suscripción inválida' });
      await sb('POST', 'taca_push?on_conflict=endpoint', [{ endpoint: s.endpoint, local_id: local, p256dh: k.p256dh, auth: k.auth, user_id: q.user || null, equipo_id: q.equipo || null }], 'resolution=merge-duplicates,return=minimal');
      return res.status(200).json({ ok: true });
    }
    if (ac === 'prueba') {
      const r = await mandar(local, { titulo: 'ta-ca', cuerpo: 'Listo: así te van a llegar los avisos de stock.', tag: 'taca-prueba', url: '/app' });
      return res.status(200).json(Object.assign({ ok: true }, r));
    }
    if (ac === 'avisar') {
      const avisos = (Array.isArray(b.avisos) ? b.avisos : []).slice(0, 20).map(a => ({ clave: String(a.clave || '').slice(0, 80), texto: String(a.texto || '').slice(0, 120) })).filter(a => a.clave && a.texto);
      if (!avisos.length) return res.status(400).json({ error: 'Nada para avisar' });
      // el mismo aviso una sola vez cada 30 minutos (varios equipos lo detectan a la vez)
      const desde = new Date(Date.now() - 30 * 60000).toISOString();
      const ya = await sb('GET', `taca_push_avisos?select=clave&local_id=eq.${enc(local)}&ts=gte.${desde}&clave=in.(${avisos.map(a => '"' + a.clave.replace(/"/g, '') + '"').join(',')})`);
      const nuevos = avisos.filter(a => !ya.some(y => y.clave === a.clave));
      if (!nuevos.length) return res.status(200).json({ ok: true, repetido: true });
      await sb('POST', 'taca_push_avisos?on_conflict=local_id,clave', nuevos.map(a => ({ local_id: local, clave: a.clave, ts: new Date().toISOString() })), 'resolution=merge-duplicates,return=minimal');
      const titulo = String(b.titulo || 'Aviso de stock').slice(0, 60);
      const cuerpo = nuevos.map(a => a.texto).join('\n');
      const r = await mandar(local, { titulo, cuerpo, tag: 'taca-stock', url: '/app' }, String(b.excepto || ''));
      return res.status(200).json(Object.assign({ ok: true }, r));
    }
    return res.status(400).json({ error: 'Acción inválida' });
  } catch (e) {
    console.error('push', e.message);
    return res.status(500).json({ error: 'No se pudo completar' });
  }
};
module.exports = handler;
module.exports.quien = quien;
