// GET  /api/mp-cuenta?local=ID                    ¿el local tiene su Mercado Pago conectado?
// POST /api/mp-cuenta { local, accion: 'conectar' | 'desconectar' }
// Solo el dueño del local (Authorization: Bearer <sesión de Supabase>).
const { sbUsuario } = require('./_lib');
const { listo, urlAutorizar, sb, cuerpo } = require('./_mpl');

module.exports = async (req, res) => {
  if (!listo()) return res.status(503).json({ error: 'Mercado Pago para mesas todavía no está configurado' });
  try {
    const b = req.method === 'POST' ? cuerpo(req) : (req.query || {});
    const local = String(b.local || '');
    if (!local) return res.status(400).json({ error: 'Falta el local' });
    const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return res.status(401).json({ error: 'Iniciá sesión de nuevo' });
    const m = await sb('GET', `taca_miembros?select=rol&local_id=eq.${encodeURIComponent(local)}&user_id=eq.${user.id}`);
    if (!m.length) return res.status(403).json({ error: 'Sin acceso a ese local' });
    if (req.method === 'GET') {
      const [c] = await sb('GET', `taca_mp_cuentas?select=mp_user_id,conectado&local_id=eq.${encodeURIComponent(local)}`);
      return res.status(200).json({ conectado: !!c, cuenta: c ? c.mp_user_id : null, desde: c ? c.conectado : null });
    }
    if (req.method !== 'POST') return res.status(405).end();
    if (m[0].rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño puede conectar Mercado Pago' });
    if (b.accion === 'conectar') return res.status(200).json({ url: urlAutorizar(local, user.id) });
    if (b.accion === 'desconectar') {
      await sb('DELETE', `taca_mp_cuentas?local_id=eq.${encodeURIComponent(local)}`);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Acción inválida' });
  } catch (e) {
    console.error('mp-cuenta', e.message);
    return res.status(502).json({ error: 'No se pudo completar' });
  }
};
