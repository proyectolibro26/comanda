// Factura electrónica ARCA (ex AFIP) sin librerías externas.
// Roman Web tiene UN certificado de ARCA; cada local delega el servicio "Facturación Electrónica" al CUIT de Roman Web
// y crea un punto de venta tipo Web Services. ta-ca factura en nombre del CUIT del local.
// La llave privada la genera el servidor y queda en Supabase (tabla solo-servidor): nunca pasa por el navegador ni por el chat.
const crypto = require('crypto');
const https = require('https');

/* ---------- ASN.1 / DER mínimo ---------- */
function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...parts) => { const v = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), len(v.length), v]); };
const SEQ = (...p) => tlv(0x30, ...p), SET = (...p) => tlv(0x31, ...p);
const NULL = Buffer.from([0x05, 0x00]);
function OID(s) {
  const a = s.split('.').map(Number), out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) { const b = [n & 127]; let x = n >> 7; while (x > 0) { b.unshift((x & 127) | 128); x >>= 7; } out.push(...b); }
  return tlv(0x06, Buffer.from(out));
}
function INT(n) { let h = BigInt(n).toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); }
const OCT = b => tlv(0x04, b), BIT = b => tlv(0x03, Buffer.from([0]), b);
const UTF8 = s => tlv(0x0c, Buffer.from(s, 'utf8')), PRINT = s => tlv(0x13, Buffer.from(s, 'ascii'));
const CTX = (n, ...p) => tlv(0xa0 + n, ...p);
function UTCTIME(d) { const p = x => String(x).padStart(2, '0'); return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); }

// lector DER: devuelve {tag, inicio, cabecera, largo, fin}
function leer(buf, i) {
  const tag = buf[i]; let l = buf[i + 1], h = 2;
  if (l & 0x80) { const n = l & 127; l = 0; for (let k = 0; k < n; k++) l = l * 256 + buf[i + 2 + k]; h = 2 + n; }
  return { tag, i, h, l, fin: i + h + l };
}
function hijos(buf, nodo) { const out = []; let i = nodo.i + nodo.h; while (i < nodo.fin) { const c = leer(buf, i); out.push(c); i = c.fin; } return out; }
const pemDer = pem => Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const derPem = (der, t) => `-----BEGIN ${t}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${t}-----\n`;

// emisor y número de serie del certificado (para el SignerInfo)
function emisorYSerie(certDer) {
  const cert = leer(certDer, 0), tbs = hijos(certDer, cert)[0], c = hijos(certDer, tbs);
  const k = c[0].tag === 0xa0 ? 1 : 0;
  const serie = certDer.subarray(c[k].i, c[k].fin), emisor = certDer.subarray(c[k + 2].i, c[k + 2].fin);
  return { serie, emisor };
}

/* ---------- llave y pedido de certificado (PKCS#10) ---------- */
function nuevaLlave() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}
function pedidoCertificado(keyPem, cuit, org) {
  const key = crypto.createPrivateKey(keyPem), spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const rdn = (oid, val) => SET(SEQ(OID(oid), val));
  const subject = SEQ(rdn('2.5.4.6', PRINT('AR')), rdn('2.5.4.10', UTF8(org || 'Roman Web')), rdn('2.5.4.3', UTF8('ta-ca')), rdn('2.5.4.5', PRINT('CUIT ' + cuit)));
  const info = SEQ(INT(0), subject, spki, CTX(0));
  const firma = crypto.sign('sha256', info, key);
  return derPem(SEQ(info, SEQ(OID('1.2.840.113549.1.1.11'), NULL), BIT(firma)), 'CERTIFICATE REQUEST');
}

/* ---------- firma CMS (PKCS#7 SignedData) del pedido de acceso ---------- */
function firmarCMS(contenido, certPem, keyPem) {
  const certDer = pemDer(certPem), key = crypto.createPrivateKey(keyPem), data = Buffer.from(contenido, 'utf8');
  const { serie, emisor } = emisorYSerie(certDer);
  const sha256 = SEQ(OID('2.16.840.1.101.3.4.2.1'), NULL);
  const attrs = [
    SEQ(OID('1.2.840.113549.1.9.3'), SET(OID('1.2.840.113549.1.7.1'))),
    SEQ(OID('1.2.840.113549.1.9.5'), SET(UTCTIME(new Date()))),
    SEQ(OID('1.2.840.113549.1.9.4'), SET(OCT(crypto.createHash('sha256').update(data).digest())))
  ];
  const attrsSet = SET(...attrs);                     // lo que se firma (etiqueta SET)
  const firma = crypto.sign('sha256', attrsSet, key);
  const attrsImpl = Buffer.concat([Buffer.from([0xa0]), attrsSet.subarray(1)]); // mismo contenido con etiqueta [0]
  const signer = SEQ(INT(1), SEQ(emisor, serie), sha256, attrsImpl, SEQ(OID('1.2.840.113549.1.1.1'), NULL), OCT(firma));
  const signed = SEQ(INT(1), SET(sha256), SEQ(OID('1.2.840.113549.1.7.1'), CTX(0, OCT(data))), CTX(0, certDer), SET(signer));
  return SEQ(OID('1.2.840.113549.1.7.2'), CTX(0, signed)).toString('base64');
}

function datosCert(certPem) {
  try { const x = new crypto.X509Certificate(certPem); return { vence: new Date(x.validTo).toISOString(), sujeto: x.subject, emisor: x.issuer }; }
  catch (e) { return null; }
}
function certEsDeLaLlave(certPem, keyPem) {
  try { return new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem)); } catch (e) { return false; }
}

/* ---------- conexión con ARCA ---------- */
const URLS = {
  homo: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx' },
  prod: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' }
};
// Los servidores de ARCA usan claves DH viejas: Node 17+ las rechaza salvo que se baje el nivel de seguridad solo para ellos.
const agente = new https.Agent({ keepAlive: true, ciphers: 'DEFAULT@SECLEVEL=1', minVersion: 'TLSv1.2' });
function soap(url, accion, cuerpo) {
  return new Promise((ok, ko) => {
    const u = new URL(url), body = Buffer.from(cuerpo, 'utf8');
    const r = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', agent: agente, timeout: 25000,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: accion, 'Content-Length': body.length } }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => ok({ status: res.statusCode, xml: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('ARCA no respondió a tiempo')));
    r.on('error', ko); r.end(body);
  });
}
const tag = (xml, t) => { const m = String(xml).match(new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`)); return m ? m[1] : null; };
const tags = (xml, t) => [...String(xml).matchAll(new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'g'))].map(m => m[1]);
const desc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function login(env, certPem, keyPem) {
  const ahora = new Date(), id = Math.floor(ahora.getTime() / 1000);
  const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${id}</uniqueId><generationTime>${new Date(ahora - 600e3).toISOString()}</generationTime><expirationTime>${new Date(+ahora + 600e3).toISOString()}</expirationTime></header><service>wsfe</service></loginTicketRequest>`;
  const cms = firmarCMS(tra, certPem, keyPem);
  const r = await M.soap(URLS[env].wsaa, '', `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`);
  const ret = tag(r.xml, 'loginCmsReturn');
  if (!ret) { const f = desc(tag(r.xml, 'faultstring')) || `ARCA respondió ${r.status}`; const e = new Error(f); e.arca = f; throw e; }
  const ta = desc(ret);
  return { token: tag(ta, 'token'), sign: tag(ta, 'sign'), expira: tag(ta, 'expirationTime') };
}

const NS = 'http://ar.gov.afip.dif.FEV1/';
const auth = (ta, cuit) => `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>`;
async function wsfe(env, metodo, inner) {
  const r = await M.soap(URLS[env].wsfe, NS + metodo, `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}"><soapenv:Header/><soapenv:Body><ar:${metodo}>${inner}</ar:${metodo}></soapenv:Body></soapenv:Envelope>`);
  if (r.status >= 500 && !/Result>/.test(r.xml)) { const e = new Error(desc(tag(r.xml, 'faultstring')) || `ARCA respondió ${r.status}`); e.arca = e.message; throw e; }
  return r.xml;
}
const errores = xml => {
  const bloques = [tag(xml, 'Errors'), tag(xml, 'Observaciones')].filter(Boolean).join('');
  return tags(bloques || '', 'Msg').map(desc);
};

async function ultimo(env, ta, cuit, ptoVta, tipo) {
  const xml = await wsfe(env, 'FECompUltimoAutorizado', `${auth(ta, cuit)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${tipo}</ar:CbteTipo>`);
  const n = tag(xml, 'CbteNro');
  if (n == null) { const e = new Error(errores(xml).join(' · ') || 'Sin respuesta de ARCA'); e.arca = e.message; throw e; }
  return +n;
}

// tipos: 1 A · 6 B · 11 C · notas de crédito 3 A · 8 B · 13 C
const NC = { 1: 3, 6: 8, 11: 13 };
const LETRA = { 1: 'A', 6: 'B', 11: 'C', 3: 'A', 8: 'B', 13: 'C' };
const NOMBRE = { 1: 'Factura A', 6: 'Factura B', 11: 'Factura C', 3: 'Nota de crédito A', 8: 'Nota de crédito B', 13: 'Nota de crédito C' };
const r2 = n => Math.round(n * 100) / 100;
const fecha = d => { const x = new Date(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })); return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`; };
const IVA_ID = { 0: 3, 10.5: 4, 21: 5, 27: 6 };

// arma y pide el CAE. c = {tipo, ptoVta, cuit (local), total, iva (alícuota), doc:{tipo,nro}, condRec, asoc:{tipo,pto,nro,fecha}}
async function autorizar(env, ta, c) {
  const nro = (await ultimo(env, ta, c.cuit, c.ptoVta, c.tipo)) + 1;
  const total = r2(c.total), conIva = LETRA[c.tipo] !== 'C';
  const neto = conIva ? r2(total / (1 + c.iva / 100)) : total, iva = conIva ? r2(total - neto) : 0, hoy = fecha(new Date());
  const ivaXml = conIva ? `<ar:Iva><ar:AlicIva><ar:Id>${IVA_ID[c.iva] || 5}</ar:Id><ar:BaseImp>${neto.toFixed(2)}</ar:BaseImp><ar:Importe>${iva.toFixed(2)}</ar:Importe></ar:AlicIva></ar:Iva>` : '';
  const asoc = c.asoc ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${c.asoc.tipo}</ar:Tipo><ar:PtoVta>${c.asoc.pto}</ar:PtoVta><ar:Nro>${c.asoc.nro}</ar:Nro><ar:Cuit>${c.cuit}</ar:Cuit><ar:CbteFch>${c.asoc.fecha}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>` : '';
  const det = `<ar:FECAEDetRequest><ar:Concepto>1</ar:Concepto><ar:DocTipo>${c.doc.tipo}</ar:DocTipo><ar:DocNro>${c.doc.nro}</ar:DocNro><ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${hoy}</ar:CbteFch><ar:ImpTotal>${total.toFixed(2)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${neto.toFixed(2)}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${iva.toFixed(2)}</ar:ImpIVA><ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${c.condRec}</ar:CondicionIVAReceptorId>${asoc}${ivaXml}</ar:FECAEDetRequest>`;
  const xml = await wsfe(env, 'FECAESolicitar', `${auth(ta, c.cuit)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:CbteTipo>${c.tipo}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq>${det}</ar:FeDetReq></ar:FeCAEReq>`);
  const res = tag(xml, 'Resultado'), cae = tag(tag(xml, 'FECAEDetResponse') || '', 'CAE');
  if (res !== 'A' || !cae) { const e = new Error(errores(xml).join(' · ') || 'ARCA rechazó el comprobante'); e.arca = e.message; throw e; }
  return { tipo: c.tipo, nombre: NOMBRE[c.tipo], letra: LETRA[c.tipo], pto: c.ptoVta, nro, cae, caeVto: tag(xml, 'CAEFchVto'), fecha: hoy, total, neto, iva, alicuota: conIva ? c.iva : 0,
    doc: c.doc, condRec: c.condRec, obs: errores(xml) };
}
// datos del QR obligatorio de ARCA
function qr(cuit, f) {
  const j = { ver: 1, fecha: `${f.fecha.slice(0, 4)}-${f.fecha.slice(4, 6)}-${f.fecha.slice(6, 8)}`, cuit: +cuit, ptoVta: f.pto, tipoCmp: f.tipo, nroCmp: f.nro, importe: f.total, moneda: 'PES', ctz: 1, tipoDocRec: f.doc.tipo, nroDocRec: +f.doc.nro, tipoCodAut: 'E', codAut: +f.cae };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(j)).toString('base64');
}

const M = module.exports = { soap, nuevaLlave, pedidoCertificado, firmarCMS, datosCert, certEsDeLaLlave, login, ultimo, autorizar, qr, NC, LETRA, NOMBRE, URLS, esc, pemDer };
