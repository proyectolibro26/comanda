// GET /api/mp-oauth?code=...&state=...   Mercado Pago vuelve acá cuando el dueño autoriza su cuenta.
const { sb, leerEstado, verificador, oauthToken, guardarCuenta, listo, REDIRECT, BASE } = require('./_mpl');

module.exports = async (req, res) => {
  const volver = (r, local) => { res.statusCode = 302; res.setHeader('Location', `${BASE}/?mpcuenta=${r}`); res.end(); };
  if (!listo()) return volver('error');
  const q = req.query || {};
  let st = null;
  try { st = leerEstado(q.state); } catch (e) { st = null; }
  if (!st) return volver('vencido');
  if (q.error || !q.code) return volver('cancelado', st.l);
  try {
    // el que autoriza tiene que seguir siendo dueño de ese local
    const m = await sb('GET', `taca_miembros?select=rol&local_id=eq.${encodeURIComponent(st.l)}&user_id=eq.${encodeURIComponent(st.u)}`);
    if (!m.length || m[0].rol !== 'dueno') return volver('error', st.l);
    const tok = await oauthToken({ grant_type: 'authorization_code', code: String(q.code), redirect_uri: REDIRECT, code_verifier: verificador(st.n) });
    await guardarCuenta(st.l, tok, st.u);
    return volver('ok', st.l);
  } catch (e) {
    console.error('mp-oauth', e.message, JSON.stringify(e.mp || {}).slice(0, 300));
    await require('./_alerta').alertar('conectar Mercado Pago', e.message, null, st && st.l);
    return volver('error', st.l);
  }
};
