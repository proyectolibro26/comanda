// POST /api/ia  { tipo: 'carta' | 'plano', archivos: [{ mime, data }] }   (Authorization: Bearer <sesión de Supabase>)
// Lee fotos o PDF con Claude (Anthropic) y devuelve la carta o el plano del salón como datos.
// Clave en Vercel › Settings › Environment Variables: ANTHROPIC_API_KEY. Opcional: TACA_IA_MODELO.
const { sbUsuario } = require('./_lib');

const MODELO = process.env.TACA_IA_MODELO || 'claude-sonnet-5-5';
const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_ARCHIVOS = 4, MAX_B64 = 4_000_000; // Vercel acepta hasta ~4,5 MB por pedido
const USO = new Map(); // límite por usuario (por instancia): 15 lecturas cada 24 h
function limitar(id) {
  const ahora = Date.now(), l = (USO.get(id) || []).filter(t => ahora - t < 864e5);
  if (l.length >= 15) return false;
  l.push(ahora); USO.set(id, l); return true;
}

const HERR = {
  carta: {
    name: 'cargar_carta',
    description: 'Carga en el sistema todos los productos que aparecen en la carta.',
    input_schema: {
      type: 'object',
      properties: {
        platos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string', description: 'Nombre tal como está en la carta' },
              precio: { type: 'number', description: 'Precio en pesos, número entero sin puntos. 0 si no figura.' },
              categoria: { type: 'string', description: 'Sección de la carta (Entradas, Pizzas, Bebidas...)' },
              descripcion: { type: 'string', description: 'Ingredientes o aclaración, si figura. Vacío si no.' },
              area: { type: 'string', enum: ['cocina', 'barra'], description: 'barra para bebidas, tragos, café y postres de heladera; cocina para el resto' }
            },
            required: ['nombre', 'precio', 'categoria', 'area']
          }
        },
        avisos: { type: 'string', description: 'Algo que el dueño tenga que revisar (precios ilegibles, partes cortadas). Vacío si no hay.' }
      },
      required: ['platos']
    }
  },
  factura: {
    name: 'cargar_compra',
    description: 'Carga en el stock la mercadería de una factura o remito de proveedor.',
    input_schema: {
      type: 'object',
      properties: {
        proveedor: { type: 'string', description: 'Nombre o razón social del proveedor' },
        numero: { type: 'string', description: 'Número de factura o remito, si figura' },
        fecha: { type: 'string', description: 'Fecha del comprobante (dd/mm/aaaa), si figura' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              descripcion: { type: 'string', description: 'Producto tal como figura en la factura' },
              cantidad: { type: 'number', description: 'Cantidad facturada' },
              unidad: { type: 'string', description: 'Unidad facturada (u, kg, g, l, caja, bulto, pack...)' },
              total: { type: 'number', description: 'Importe total de la línea en pesos, con descuentos aplicados' },
              insumo_id: { type: 'string', description: 'id del insumo de la lista que es este producto. Vacío si no está en la lista.' },
              cantidad_insumo: { type: 'number', description: 'La cantidad expresada en la unidad del insumo (ej.: 2 cajas de 12 = 24 u; 5000 g = 5 kg)' },
              unidad_insumo: { type: 'string', enum: ['u', 'kg', 'l'], description: 'Unidad del insumo (la del insumo de la lista o la más lógica si es nuevo)' }
            },
            required: ['descripcion', 'cantidad', 'total', 'cantidad_insumo', 'unidad_insumo']
          }
        },
        avisos: { type: 'string' }
      },
      required: ['items']
    }
  },
  plano: {
    name: 'armar_plano',
    description: 'Arma el plano del salón con mesas y elementos.',
    input_schema: {
      type: 'object',
      properties: {
        alto: { type: 'number', description: 'Alto del plano si el ancho mide 100 (entre 40 y 100)' },
        mesas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              forma: { type: 'string', enum: ['cuad', 'red', 'larga'] },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              sillas: { type: 'integer' },
              numero: { type: 'integer', description: 'Número de mesa si se ve; si no, omitir' }
            },
            required: ['forma', 'x', 'y', 'w', 'h', 'sillas']
          }
        },
        elementos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['barra', 'cocina', 'zona', 'pared', 'puerta', 'bano', 'planta'] },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              nombre: { type: 'string' }
            },
            required: ['tipo', 'x', 'y', 'w', 'h']
          }
        },
        avisos: { type: 'string' }
      },
      required: ['alto', 'mesas', 'elementos']
    }
  }
};
const PROMPT = {
  carta: `Sos el asistente de carga de ta-ca, un sistema para bares y restaurantes de Argentina. Te paso la carta de un local (fotos o PDF). Pasá TODOS los productos con la herramienta cargar_carta.
Reglas:
- Copiá los nombres como están escritos, corrigiendo solo mayúsculas raras. No inventes productos ni precios.
- Precios en pesos argentinos como número entero: "$ 12.500" es 12500; "12,5" en una carta en miles es 12500 solo si el resto de la carta usa miles.
- Si un producto tiene varios tamaños o variantes con precio propio (chica/grande, copa/botella, 6 u./12 u.), cargá uno por cada uno: "Pizza muzzarella (grande)".
- La categoría es la sección donde aparece. Si no hay secciones, usá una general razonable (Platos, Bebidas, Postres).
- area: "barra" para bebidas, tragos, cervezas, vinos, café e infusiones; "cocina" para el resto.
- Si un precio no se lee, poné 0 y avisalo en avisos.`,
  factura: `Sos el asistente de ta-ca, un sistema para bares y restaurantes de Argentina. Te paso la factura, remito o ticket de un proveedor. Cargá cada línea de mercadería con la herramienta cargar_compra.
Reglas:
- Una línea por producto. No inventes productos; si algo no se lee, avisalo en avisos.
- total = importe final de la línea en pesos como número entero (sin puntos), con descuentos e IVA de la línea si figuran por línea.
- Relacioná cada producto con el insumo de la lista del local cuando sea claramente lo mismo (ej.: "Coca Cola 500cc x12" con "Gaseosa 500 ml"; "Muzzarella La Serenísima" con "Muzzarella"). Si no hay uno parecido, dejá insumo_id vacío.
- cantidad_insumo es la cantidad en la unidad del insumo: cajas o packs se multiplican por las unidades que traen; gramos se pasan a kg; cc o ml a litros.
- Ignorá líneas que no son mercadería (fletes, percepciones, totales, subtotales).`,
  plano: `Sos el asistente de ta-ca, un sistema para bares y restaurantes. Te paso un plano, croquis o foto del salón de un local. Armá el plano con la herramienta armar_plano.
Coordenadas: el ancho total mide 100 y el alto lo elegís vos (campo alto) para respetar las proporciones del local. x e y son la esquina superior izquierda; w y h, el ancho y el alto. Todo tiene que quedar dentro de 0..100 en x y 0..alto en y, sin superponerse (salvo las zonas, que van debajo).
Mesas: forma "cuad" (cuadrada, unos 7x7), "red" (redonda, unos 7x7) o "larga" (rectangular, unos 14x7 o 7x14). Contá las sillas que se ven; si no se ven, 2 a 4 para chicas y 6 a 8 para largas. Si las mesas tienen número visible, ponelo.
Elementos: barra, cocina, baño, puerta o entrada, paredes divisorias (finas: h o w de 1 a 1,5), zonas con nombre (Salón, Terraza, Patio, Vereda) y plantas.
Si es una foto en perspectiva, imaginá la vista desde arriba. Separá las mesas al menos 3 unidades. Si algo es dudoso, avisalo en avisos.`
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'La lectura con IA todavía no está activada', codigo: 'sin_clave' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const tipo = ['plano', 'factura'].includes(b.tipo) ? b.tipo : 'carta';
    const archivos = Array.isArray(b.archivos) ? b.archivos.slice(0, MAX_ARCHIVOS) : [];
    if (!archivos.length) return res.status(400).json({ error: 'Subí al menos una foto o un PDF' });
    let total = 0;
    for (const a of archivos) {
      if (!TIPOS_OK.includes(a.mime) || typeof a.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(a.data.slice(0, 200))) return res.status(400).json({ error: 'Formato no soportado: usá fotos (JPG, PNG) o PDF' });
      total += a.data.length;
    }
    if (total > MAX_B64) return res.status(413).json({ error: 'Los archivos son muy pesados. Probá con menos fotos o un PDF más liviano' });
    const user = await sbUsuario((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || !user.id) return res.status(401).json({ error: 'Iniciá sesión para usar la lectura con IA' });
    if (!limitar(user.id)) return res.status(429).json({ error: 'Llegaste al límite de lecturas con IA por hoy. Probá mañana o escribinos por WhatsApp' });

    const contenido = archivos.map(a => a.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: a.mime, data: a.data } }
      : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    const ins = tipo === 'factura' && Array.isArray(b.insumos) ? b.insumos.slice(0, 300).map(i => `${String(i.id).slice(0, 40)} | ${String(i.nombre).slice(0, 60)} | ${['u', 'kg', 'l'].includes(i.u) ? i.u : 'u'}`).join('\n') : '';
    contenido.push({ type: 'text', text: (tipo === 'carta' ? 'Esta es la carta del local.' : tipo === 'factura' ? `Esta es la factura del proveedor. Insumos del local (id | nombre | unidad):\n${ins || '(todavía no cargó insumos)'}\n` : 'Este es el salón del local.') + ` Respondé únicamente llamando a la herramienta ${HERR[tipo].name}, sin texto aparte.` });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELO, max_tokens: tipo === 'plano' ? 6000 : 12000, system: PROMPT[tipo], tools: [HERR[tipo]], messages: [{ role: 'user', content: contenido }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('ia', r.status, JSON.stringify(j).slice(0, 300));
      const msg = r.status === 529 || r.status === 503 ? 'El servicio de IA está ocupado. Probá de nuevo en un minuto' : r.status === 400 && /credit|balance/i.test(JSON.stringify(j)) ? 'La lectura con IA no tiene saldo. Avisale a Roman Web' : 'No pudimos leer el archivo. Probá con otra foto';
      return res.status(502).json({ error: msg });
    }
    let uso = (j.content || []).find(c => c.type === 'tool_use' && c.name === HERR[tipo].name);
    if (!uso) { // por si respondió con el JSON en texto
      const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), m = t.match(/\{[\s\S]*\}/);
      try { if (m) uso = { input: JSON.parse(m[0]) }; } catch (e) {}
    }
    if (!uso || !uso.input) return res.status(502).json({ error: 'No encontramos nada para cargar. Probá con una foto más clara' });
    console.log('ia ok', tipo, user.id, j.usage && JSON.stringify(j.usage));
    return res.status(200).json({ ok: true, tipo, datos: uso.input, cortado: j.stop_reason === 'max_tokens' });
  } catch (e) {
    console.error('ia', e.message);
    return res.status(500).json({ error: 'Algo falló leyendo el archivo. Probá de nuevo' });
  }
};
