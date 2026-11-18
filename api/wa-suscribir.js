// POST /api/wa-suscribir  { waba }   (Authorization: Bearer <sesión de Supabase de un admin de Roman Web>)
// Suscribe la cuenta de WhatsApp Business (WABA) a la app ta-ca para que Meta mande los mensajes al webhook,
// y devuelve los números de esa cuenta con su Phone number ID (para conectarlos a un local desde el panel).
const { sbSelect, sbUsuario } = require('./_lib');

const GRAPH = 'https://graph.facebook.com/v21.0';
async function g(path, method) {
  const r = await fetch(GRAPH + path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Meta ${r.status}`);
  return j;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.WA_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'WhatsApp sin configurar' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const waba = String(b.waba || '').trim();
    if (!/^\d{6,25}$/.test(waba)) return res.status(400).json({ error: 'Identificador de la cuenta de WhatsApp inválido' });
    const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return res.status(401).json({ error: 'Iniciá sesión de nuevo' });
    const adm = await sbSelect(`taca_admins?select=user_id&user_id=eq.${user.id}`);
    if (!adm.length) return res.status(403).json({ error: 'Solo Roman Web' });
    const sub = await g(`/${waba}/subscribed_apps`, 'POST');
    const apps = await g(`/${waba}/subscribed_apps`);
    const nums = await g(`/${waba}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`);
    return res.status(200).json({ ok: !!sub.success, apps: (apps.data || []).map(a => (a.whatsapp_business_api_data || {}).name || a.name || 'app'), numeros: (nums.data || []).map(n => ({ id: n.id, numero: n.display_phone_number, nombre: n.verified_name })) });
  } catch (e) {
    console.error('wa-suscribir', e.message);
    return res.status(502).json({ error: 'Meta respondió: ' + e.message });
  }
};
