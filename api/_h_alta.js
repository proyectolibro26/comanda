// Aviso al Telegram de Roman Web cuando alguien crea un local nuevo en ta-ca.
// POST /api/aviso-alta { local } con el token de la sesión del dueño que lo acaba de crear.
const { sbUsuario } = require('./_lib');
const { sb } = require('./_mpl');
const { telegram } = require('./_alerta');

const avisados = new Set();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usá POST' });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const u = await sbUsuario(token);
    if (!u || !u.id) return res.status(401).json({ error: 'Entrá de nuevo' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(b.local || '').slice(0, 60);
    if (!id || avisados.has(id)) return res.status(200).json({ ok: true });
    // Solo el dueño de ese local, y solo si el local es recién creado.
    const [m] = await sb('GET', `taca_miembros?select=email,rol&local_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(u.id)}`);
    if (!m || m.rol !== 'dueno') return res.status(403).json({ error: 'No es tu local' });
    const [l] = await sb('GET', `taca_locales?select=nombre,creado,plan,prueba_hasta&id=eq.${encodeURIComponent(id)}`);
    if (!l || Date.now() - new Date(l.creado).getTime() > 15 * 60e3) return res.status(200).json({ ok: false });
    avisados.add(id);
    const admin = await sb('GET', `taca_admins?select=user_id&user_id=eq.${encodeURIComponent(u.id)}`);
    const otros = await sb('GET', `taca_miembros?select=local_id&user_id=eq.${encodeURIComponent(u.id)}&rol=eq.dueno`);
    const hora = new Date(l.creado).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const texto = [
      admin.length ? '🧪 Local nuevo (cuenta de Roman Web)' : '🎉 ¡Se registró un local nuevo en ta-ca!',
      `${l.nombre} — ${hora}`,
      `Dueño: ${m.email || u.email || 'sin mail'}`,
      otros.length > 1 ? `Ya tiene ${otros.length} locales en su cuenta.` : 'Arranca la prueba de 14 días.',
      'Llamalo hoy para ayudarlo a cargar la carta. Lo ves en el Panel Roman Web: https://ta-ca.com.ar/app'
    ].join('\n');
    const ok = await telegram(texto);
    return res.status(200).json({ ok });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo avisar' });
  }
};
