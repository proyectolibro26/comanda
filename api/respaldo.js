// Respaldo de todos los locales.
//   GET  (Vercel Cron, todas las madrugadas)       guarda una copia en taca_respaldos y borra las de más de 30 días
//   GET  ?descargar=ultimo|<id>  (admin, Bearer)   descarga una copia en JSON
//   GET  ?lista=1                (admin, Bearer)   lista las copias guardadas
//   POST                         (admin, Bearer)   hace una copia ahora
const { sbUsuario } = require('./_lib');
const { sb } = require('./_mpl');

async function esAdmin(req) {
  const u = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!u || !u.id) return false;
  const a = await sb('GET', `taca_admins?select=user_id&user_id=eq.${u.id}`);
  return a.length > 0;
}
async function hacerCopia() {
  const [locales, miembros, wa, pagos] = await Promise.all([
    sb('GET', 'taca_locales?select=*'),
    sb('GET', 'taca_miembros?select=*'),
    sb('GET', 'taca_wa?select=*'),
    sb('GET', 'taca_pagos?select=*')
  ]);
  const data = { creado: new Date().toISOString(), locales, miembros, wa, pagos };
  await sb('POST', 'taca_respaldos', [{ locales: locales.length, data }]);
  await sb('DELETE', `taca_respaldos?creado=lt.${new Date(Date.now() - 30 * 864e5).toISOString()}`);
  return { ok: true, locales: locales.length, bytes: JSON.stringify(data).length };
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const cron = process.env.CRON_SECRET
      ? req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET
      : /vercel-cron/i.test(req.headers['user-agent'] || '');
    if (req.method === 'GET' && !q.descargar && !q.lista) {
      if (!cron) return res.status(403).json({ error: 'Solo el respaldo automático' });
      const [ult] = await sb('GET', 'taca_respaldos?select=creado&order=creado.desc&limit=1');
      if (ult && Date.now() - Date.parse(ult.creado) < 20 * 3600e3) return res.status(200).json({ ok: true, ya: ult.creado });
      return res.status(200).json(await hacerCopia());
    }
    if (!(await esAdmin(req))) return res.status(403).json({ error: 'Solo Roman Web' });
    if (req.method === 'POST') return res.status(200).json(await hacerCopia());
    if (q.lista) return res.status(200).json(await sb('GET', 'taca_respaldos?select=id,creado,locales&order=creado.desc&limit=40'));
    const filtro = q.descargar === 'ultimo' ? 'order=creado.desc&limit=1' : `id=eq.${parseInt(q.descargar, 10) || 0}`;
    const [r] = await sb('GET', `taca_respaldos?select=id,creado,data&${filtro}`);
    if (!r) return res.status(404).json({ error: 'No hay copias todavía' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ta-ca-respaldo-${r.creado.slice(0, 10)}.json"`);
    return res.status(200).send(JSON.stringify(r.data));
  } catch (e) {
    console.error('respaldo', e.message);
    return res.status(500).json({ error: 'No se pudo hacer el respaldo' });
  }
};
