// Varias funciones chicas en una sola (el plan gratis de Vercel permite hasta 12).
// Las direcciones de siempre siguen andando por las reglas de vercel.json:
//   /api/alerta  /api/respaldo  /api/estado  /api/wa-suscribir  /api/ia  /api/push  /api/consulta  /api/mp-qr  /api/equipo
const H = {
  alerta: require('./_h_alerta'),
  respaldo: require('./_h_respaldo'),
  estado: require('./_h_estado'),
  'wa-suscribir': require('./_h_wa_suscribir'),
  ia: require('./_h_ia'),
  push: require('./_h_push'),
  consulta: require('./_h_consulta'),
  'mp-qr': require('./_h_mpqr'),
  equipo: require('./_h_equipo')
};
module.exports = (req, res) => {
  const r = String((req.query && req.query.r) || '');
  const h = H[r];
  if (!h) return res.status(404).json({ error: 'No existe' });
  if (req.query) delete req.query.r;
  return h(req, res);
};
