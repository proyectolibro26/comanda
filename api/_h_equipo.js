// App del equipo de ventas: avisa al Telegram de Roman Web cuando alguien agenda una cita (demo).
// POST /api/equipo  { accion:'cita', contacto }  con el token de la sesión del integrante.
const { sbUsuario } = require('./_lib');
const { sb } = require('./_mpl');
const { telegram } = require('./_alerta');

const ultimo = new Map(); // mismo integrante + mismo bar: un aviso cada 2 minutos como mucho

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usá POST' });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const u = await sbUsuario(token);
    const mail = u && u.email ? String(u.email).toLowerCase() : '';
    if (!mail) return res.status(401).json({ error: 'Entrá de nuevo' });
    const [yo] = await sb('GET', `taca_vt_equipo?select=id,nombre&activo=is.true&email=ilike.${encodeURIComponent(mail)}`);
    if (!yo) return res.status(403).json({ error: 'No estás en el equipo' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.accion !== 'cita') return res.status(400).json({ error: 'Acción desconocida' });
    const id = String(b.contacto || '').slice(0, 60);
    const [c] = await sb('GET', `taca_vt_contactos?select=nombre,direccion,zona,telefono,whatsapp,fecha,hora,proximo,vendedor,estado&id=eq.${encodeURIComponent(id)}`);
    if (!c || c.estado !== 'Demo agendada' || !c.fecha) return res.status(200).json({ ok: false });
    const k = yo.id + '|' + id + '|' + c.fecha + '|' + (c.hora || '');
    if (ultimo.has(k) && Date.now() - ultimo.get(k) < 120e3) return res.status(200).json({ ok: true, repetido: true });
    ultimo.set(k, Date.now());
    let quien = yo.nombre;
    if (c.vendedor && c.vendedor !== yo.id) { const [v] = await sb('GET', `taca_vt_equipo?select=nombre&id=eq.${encodeURIComponent(c.vendedor)}`); if (v) quien = v.nombre + ' (la cargó ' + yo.nombre + ')'; }
    const dia = new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
    const texto = ['📅 Nueva cita del equipo',
      `${c.nombre} — ${dia}${c.hora ? ' a las ' + c.hora : ''}`,
      `Va: ${quien}`,
      c.proximo ? `Qué: ${c.proximo}` : '',
      [c.direccion, c.zona].filter(Boolean).join(', '),
      c.whatsapp ? 'WhatsApp: https://wa.me/' + c.whatsapp : (c.telefono ? 'Tel: ' + c.telefono : ''),
      'https://ta-ca.com.ar/equipo/'].filter(Boolean).join('\n');
    const ok = await telegram(texto);
    return res.status(200).json({ ok });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo avisar' });
  }
};
