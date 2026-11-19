// POST /api/alerta { mensaje, detalle, local }   La app avisa un error (sin sesión: viene de cualquier equipo).
// GET  /api/alerta?lista=1                        (admin) últimos errores
// POST /api/alerta { prueba: true }               (admin) manda un aviso de prueba a Telegram
const { sbUsuario } = require('./_lib');
const { sb, cuerpo } = require('./_mpl');
const { alertar, telegram, detectarChat, chat } = require('./_alerta');

async function esAdmin(req) {
  const u = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!u || !u.id) return false;
  return (await sb('GET', `taca_admins?select=user_id&user_id=eq.${u.id}`)).length > 0;
}
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!(await esAdmin(req))) return res.status(403).json({ error: 'Solo Roman Web' });
      const l = await sb('GET', 'taca_errores?select=id,ts,ultimo,veces,origen,local_id,mensaje,detalle&order=ultimo.desc&limit=60');
      return res.status(200).json({ token: !!process.env.TELEGRAM_TOKEN, telegram: !!(process.env.TELEGRAM_TOKEN && await chat()), errores: l });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const b = cuerpo(req);
    if (b.detectar) {
      if (!(await esAdmin(req))) return res.status(403).json({ error: 'Solo Roman Web' });
      const r = await detectarChat();
      if (r.ok) await telegram(`✅ ta-ca: listo${r.nombre ? ', ' + r.nombre : ''}. Los avisos de errores van a llegar a este chat.`);
      return res.status(200).json(r);
    }
    if (b.prueba) {
      if (!(await esAdmin(req))) return res.status(403).json({ error: 'Solo Roman Web' });
      const ok = await telegram('✅ ta-ca: los avisos de errores llegan a este chat.');
      return res.status(200).json({ ok, telegram: !!(process.env.TELEGRAM_TOKEN && await chat()) });
    }
    const d = b.detalle && typeof b.detalle === 'object' ? b.detalle : {};
    const limpio = { donde: String(d.donde || '').slice(0, 200), rol: String(d.rol || '').slice(0, 20), stack: String(d.stack || '').slice(0, 800), navegador: String(req.headers['user-agent'] || '').slice(0, 160) };
    await alertar('app', String(b.mensaje || '').slice(0, 300), limpio, b.local ? String(b.local).slice(0, 80) : null);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('alerta', e.message);
    return res.status(200).json({ ok: false });
  }
};
