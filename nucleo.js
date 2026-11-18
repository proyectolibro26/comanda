/* ta-ca · núcleo compartido entre la app (navegador) y el servidor (api/ en Vercel).
   Trabaja sobre el estado global S del local. Lo que depende de la pantalla queda afuera y se provee desde cada lado:
   save() guarda el estado, audit(accion,detalle,monto) registra un movimiento. */
const ESTADO={nuevo:'Recibido',preparando:'En preparación',listo:'Listo',entregado:'Entregado',enviado:'En camino'};
const MEDIO={efectivo:'💵 Efectivo',mp:'Mercado Pago',tarjeta:'💳 Tarjeta',transferencia:'🏦 Transferencia'};
const norm=s=>String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
const fmt=n=>(n<0?'−$':'$')+Math.round(Math.abs(n)).toLocaleString('es-AR');
const r3=x=>Math.round(x*1000)/1000;
const uid=()=>Math.random().toString(36).slice(2,9);
const plato=id=>S.platos.find(p=>p.id===id);
const insumo=id=>S.insumos.find(i=>i.id===id);
const activos=()=>S.platos.filter(p=>p.activo!==false);
const disp=p=>{const e=Object.entries(p.receta);if(!e.length)return 999;return Math.max(0,Math.floor(Math.min(...e.map(([i,c])=>insumo(i)?insumo(i).stock/c:0))+1e-6))};
function lineInfo(l){
  const p=plato(l.id),mods=(l.mods||[]).map(m=>p.mods.find(x=>x.id===m)).filter(Boolean);
  const receta={...p.receta};
  mods.forEach(m=>{if(m.tipo==='quita')delete receta[m.ins];else receta[m.ins]=r3((receta[m.ins]||0)+m.cant)});
  return{p,mods,receta,precio:p.precio+mods.reduce((a,m)=>a+(+m.precio||0),0)};
}
function needFor(lines){const need={};lines.forEach(l=>{const{receta}=lineInfo(l);Object.entries(receta).forEach(([i,c])=>need[i]=r3((need[i]||0)+c*l.cant))});return need}
function faltante(lines){for(const [ins,c] of Object.entries(needFor(lines))){const i=insumo(ins);if(!i||i.stock<c-1e-9)return i?i:{nombre:ins}}return null}
function armarPedido(o){
  const f=faltante(o.lines);
  if(f){const pl=o.lines.map(l=>lineInfo(l)).find(x=>x.receta[f.id]);return{error:`No alcanza el stock para ${pl?pl.p.nombre:'el pedido'} (falta ${f.nombre})`}}
  const need=needFor(o.lines);
  const items=o.lines.map(l=>{const x=lineInfo(l);return{id:x.p.id,nombre:x.p.nombre,precio:x.precio,cant:l.cant,mods:x.mods.map(m=>m.nombre),modIds:l.mods||[],area:x.p.area||'cocina'}});
  const subtotal=items.reduce((a,i)=>a+i.precio*i.cant,0),envio=o.origen==='whatsapp'?S.envio:0;
  return{need,ped:{origen:o.origen,por:o.por||'',mesa:o.mesa||null,cliente:o.cliente||'',tel:o.tel||'',direccion:o.direccion||'',items,subtotal,envio,total:subtotal+envio,estado:'nuevo',medio:o.medio||null,cobrado:false,pideCuenta:false,consumo:need,anulado:false,nota:o.nota||''}};
}
function crearPedido(o){
  const a=armarPedido(o);if(a.error)return a;
  for(const [ins,c] of Object.entries(a.need)){const i=insumo(ins);i.stock=r3(i.stock-c)}
  const ped=Object.assign({id:uid(),num:S.nextNum++,ts:Date.now()},a.ped);
  S.pedidos.push(ped);save();return ped;
}
function fechaISO(d){d=d||new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
const fechaLinda=f=>{const [y,m,d]=f.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'})};
/* reservas por WhatsApp */
const DIAS=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
function leerReserva(t,r){
  const hoyD=new Date();hoyD.setHours(0,0,0,0);const mas=n=>{const d=new Date(hoyD);d.setDate(d.getDate()+n);return fechaISO(d)};
  if(/pasado manana/.test(t))r.fecha=mas(2);else if(/\bmanana\b/.test(t))r.fecha=mas(1);else if(/\bhoy\b|esta noche/.test(t))r.fecha=mas(0);
  else{const i=DIAS.findIndex(d=>new RegExp('\\b'+d+'\\b').test(t));if(i>=0)r.fecha=mas((i-hoyD.getDay()+7)%7);
    const m=t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);if(m){let y=m[3]?+m[3]:hoyD.getFullYear();if(y<100)y+=2000;const d=new Date(y,+m[2]-1,+m[1]);if(!m[3]&&d<hoyD)d.setFullYear(y+1);r.fecha=fechaISO(d)}}
  const sin=t.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g,' ');
  const h=sin.match(/a las? (\d{1,2})(?:[:.](\d{2}))?/)||sin.match(/\b(\d{1,2})[:.](\d{2})\b/)||sin.match(/\b(\d{1,2})\s*(?:hs|h|horas)\b/);
  if(h){let H=+h[1];const M=h[2]?+h[2]:0;if(H>=1&&H<=11&&!/manana|mediodia/.test(t.slice(h.index)))H+=12;if(H<=23&&M<=59)r.hora=String(H).padStart(2,'0')+':'+String(M).padStart(2,'0')}
  const p=sin.match(/para (\d{1,2})\b/)||sin.match(/\b(\d{1,2})\s*(?:personas|pers|comensales)\b/)||sin.match(/somos (\d{1,2})\b/);
  if(p)r.personas=+p[1];else{const w=sin.match(/(?:para|somos) (una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);if(w)r.personas=NUMS[w[1]]}
  return r;
}
function pasoReserva(txt){
  const wa=S.wa,r=leerReserva(norm(txt),wa.draft.res||{}),cl=cliente();wa.draft.res=r;
  if(wa.step==='res_nombre'){r.nombre=txt.trim().slice(0,40)}
  const falta=[!r.fecha&&'el día',!r.hora&&'la hora',!r.personas&&'cuántas personas'].filter(Boolean);
  if(falta.length){wa.step='res';return[`¡Dale! Pasame ${falta.join(', ').replace(/, ([^,]*)$/,' y $1')} 🙂\nPor ejemplo: *mañana a las 21:30 para 4*`]}
  if(r.fecha<fechaISO()||(r.fecha===fechaISO()&&r.hora<new Date().toTimeString().slice(0,5))){delete r.hora;wa.step='res';return['Esa hora ya pasó 😅 ¿Para qué otro horario?']}
  if(r.personas>20){wa.step='res';return['Para grupos de más de 20 personas escribinos y lo armamos especialmente 🙌']}
  const t=x=>{const[a,b]=x.split(':').map(Number);return a*60+b};
  if(S.reservas.filter(x=>x.fecha===r.fecha&&x.estado==='confirmada'&&Math.abs(t(x.hora)-t(r.hora))<90).length>=Math.ceil(S.mesas*.6)){delete r.hora;wa.step='res';return[`Uh, a esa hora estamos completos 😕 ¿Te sirve un poco antes o más tarde?`]}
  if(!r.nombre){const prev=S.reservas.filter(x=>x.tel===wa.tel).pop();if(cl)r.nombre=cl.nombre;else if(prev)r.nombre=prev.nombre;else{wa.step='res_nombre';return['¿A nombre de quién la anoto?']}}
  wa.step='res_ok';
  return[`📅 *Tu reserva*\n${fechaLinda(r.fecha).replace(/^./,c=>c.toUpperCase())} a las *${r.hora}*\n${r.personas} persona${r.personas>1?'s':''} · a nombre de *${r.nombre}*\n\nRespondé *SI* para confirmar.`];
}
function botReserva(t,txt){
  const wa=S.wa;
  if(/cancel\w* (la |mi )?reserva/.test(t)){
    const r=S.reservas.filter(x=>x.tel===wa.tel&&x.estado==='confirmada'&&x.fecha>=fechaISO()).sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora))[0];
    if(!r)return['No encontré reservas tuyas a confirmar 🤔'];
    r.estado='cancelada';audit('Reserva cancelada',`${r.nombre} · ${r.fecha} ${r.hora} (por WhatsApp)`);if(wa.step.startsWith('res'))wa.step='inicio';
    return[`Listo, cancelé tu reserva del ${fechaLinda(r.fecha)} a las ${r.hora}. ¡Gracias por avisar! 🙏`];
  }
  if(wa.step.startsWith('res')){
    if(/^(chau|salir|nada|olvidate|dejalo)/.test(t)){wa.step='inicio';wa.draft={};return['Listo 👍 Cuando quieras escribí *reservar* o pedí de la carta.']}
    if(!/reserv/.test(t)&&parsear(t).lines.length){wa.step='inicio';wa.draft={};return null}
  }
  if(wa.step==='res_ok'){
    if(/^(si|dale|ok|confirmo|de una)/.test(t)){const r=wa.draft.res;
      S.reservas.push({id:uid(),nombre:r.nombre,tel:wa.tel,personas:r.personas,fecha:r.fecha,hora:r.hora,mesa:null,nota:'Pidió por WhatsApp',estado:'confirmada',ts:Date.now(),por:'WhatsApp'});
      wa.step='inicio';wa.draft={};
      return[`✅ ¡Reserva confirmada! Te esperamos.\nSi no podés venir, escribí *cancelar reserva* así liberamos la mesa.`]}
    if(/^no\b|cancel/.test(t)){wa.step='inicio';wa.draft={};return['Listo, no la anoto. Si querés otro horario escribí *reservar*.']}
    return pasoReserva(txt);
  }
  if(wa.step.startsWith('res')){if(/^(cancel|salir|chau)/.test(t)){wa.step='inicio';wa.draft={};return['Listo 👍']}return pasoReserva(txt)}
  if(/reserv/.test(t)){wa.step='res';wa.draft={res:{}};const r=pasoReserva(txt);return r}
  return null;
}
/* ---------- asistente de WhatsApp ---------- */
const NUMS={un:1,una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10};
function lev(a,b){if(Math.abs(a.length-b.length)>2)return 9;const d=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return d[b.length]}
function parecido(seg,a){if(a.length<4)return false;return seg.split(/\s+/).some(w=>w.length>=4&&(lev(w,a)<=(a.length>=6?2:1)||(w.length>a.length&&lev(w.slice(0,a.length),a)<=1)))}
function sinDim(w){return w.length<6?w:w.replace(/quit([oa]s?)$/,'c$1').replace(/guit([oa]s?)$/,'g$1').replace(/cit([oa]s?)$/,'z$1').replace(/it([oa]s?)$/,'$1')}
function parsear(t){
  const out={},notas=[];t=norm(t).split(/(\s+)/).map(sinDim).join('');
  const cant='\\d+|una?|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez';
  const palabras=p=>norm(p.nombre).split(/\s+/).filter(w=>w.length>3&&!['con','del','para','sin'].includes(w));
  norm(t).split(/,|\by\b|\be\b|\n|\+|;/).flatMap(x=>x.split(new RegExp('\\s+(?=(?:'+cant+')\\s)'))).forEach(seg=>{
    seg=seg.trim();if(!seg)return;
    const ac=seg.match(/\b(sin|con|extra|bien|jugosa?|a punto)\b.*$/);
    const p=activos().find(p=>(p.alias||[]).some(a=>seg.includes(a)))||activos().find(p=>!(p.alias||[]).length&&palabras(p).some(w=>seg.includes(w)))
      ||activos().find(p=>(p.alias||[]).concat(palabras(p)).some(a=>parecido(seg,a)));
    if(!p){if(ac&&/^(una?|la|el)?\s*(sin|con|extra|bien)/.test(seg))notas.push(seg.replace(/^(una?|la|el)\s+/,''));return}
    let q=1;const m=seg.match(/(\d+)/);
    if(m)q=+m[1];else{for(const w in NUMS)if(new RegExp('\\b'+w+'\\b').test(seg)){q=NUMS[w];break}}
    out[p.id]=(out[p.id]||0)+q;
    if(ac&&!(p.alias||[]).some(a=>ac[0].includes(a)))notas.push(p.nombre+': '+ac[0]);
  });
  return{lines:Object.entries(out).map(([id,cant])=>({id,cant,mods:[]})),nota:notas.join(' · ')};
}
function cartaTxt(){const ps=activos(),cats=[...new Set(ps.map(p=>p.cat))];return'📋 *Nuestra carta*\n'+cats.map(c=>`\n*${c}*\n`+ps.filter(p=>p.cat===c).map(p=>`• ${p.nombre} — ${fmt(p.precio)}${disp(p)<=0?' (agotado)':''}`).join('\n')).join('\n')+`\n\n🛵 Envío: ${fmt(S.envio)}`}
function resumenItems(lines){const sub=lines.reduce((a,l)=>a+lineInfo(l).precio*l.cant,0);return lines.map(l=>`• ${l.cant}× ${plato(l.id).nombre} — ${fmt(lineInfo(l).precio*l.cant)}`).join('\n')+`\n• Envío — ${fmt(S.envio)}\n*Total: ${fmt(sub+S.envio)}*`}
function cliente(){return S.clientes[S.wa.tel]}
function pasoResumen(lines,nota){
  const f=faltante(lines);
  if(f){S.wa.step='pedido';const pl=lines.map(lineInfo).find(x=>x.receta[f.id]);return[`Uy, ${pl?'de '+pl.p.nombre:'eso'} no nos queda suficiente hoy 😕 (quedan ${pl?disp(pl.p):0}). ¿Querés cambiar algo?`]}
  S.wa.draft={lines,nota};const cl=cliente();
  const out=['Perfecto, te anoto:\n'+resumenItems(lines)+(nota?`\n📝 ${nota}`:'')];
  if(cl){S.wa.draft.cliente=cl.nombre;S.wa.draft.direccion=cl.dir;S.wa.step='pago';out.push(`Te lo mandamos a *${cl.dir}* como siempre (si es otra, escribí *otra dirección*).\n¿Cómo vas a pagar?\n1️⃣ Efectivo\n2️⃣ Transferencia\n3️⃣ Mercado Pago`)}
  else{S.wa.step='datos';out.push('¿A nombre de quién y a qué dirección lo mandamos? (por ejemplo: *Juan, San Martín 1234*)')}
  return out;
}
// respuestas cuando no entiende: productos que no están en la carta, preguntas y pase a una persona
const NO_PRODUCTO=['algo','mas','pedido','carta','menu','nada','eso','esto','otra','otro','no','si','hambre','delivery','envio','reserva','mesa','lugar','abierto'];
function noEntiendo(t){
  const wa=S.wa;wa._ne=true;wa.noEnt=(wa.noEnt||0)+1;
  const m=t.match(/\b(?:quiero|queria|quisiera|dame|mandame|traeme|hay|tienen|tenes|venden|hacen|sale|salen)\s+(?:un|una|unos|unas|el|la|los|las|de)?\s*([a-zñ]{3,}(?:\s+(?!en\b|la\b|de\b|para\b|quiero\b)[a-zñ]{3,})?)/)
    ||t.match(/\b(?:un|una|unos|unas|\d+)\s+([a-zñ]{3,})\b/);
  const nombres=activos().map(p=>p.nombre).join(', ');
  if(m&&!NO_PRODUCTO.includes(m[1].split(' ')[0])){wa.consulta=m[1];wa.noEnt=0;return[`No tenemos *${wa.consulta}* en la carta 😕\nLo que hay: ${nombres}.\n¿Te tienta algo de eso?`]}
  if(wa.consulta&&/(hay|tienen|tenes)\b.*\??$|^(si o no|y\??|entonces)\b/.test(t))return[`No, *${wa.consulta}* no tenemos 😕 Lo que hay: ${nombres}.`];
  const ayuda=wa.noEnt>=2?'\nSi preferís, escribí *persona* y te responde alguien del local.':'';
  return['No te entendí 🙈. Decime qué querés de la carta, por ejemplo: *1 pizza y 2 cervezas*. O escribí *menú* para verla.'+ayuda];
}
function bot(txt){
  const t0=norm(txt),w0=S.wa;w0._ne=false;
  if(/^(persona|humano|alguien|una persona|atencion|hablar con (alguien|una persona|el local|un humano))\b/.test(t0)){w0.humano=Date.now();w0.noEnt=0;return['Listo 🙌 Le aviso al local y te responden por acá en un ratito.']}
  if(w0.humano&&Date.now()-w0.humano<30*60e3&&!/^(menu|carta|asistente|bot)\b/.test(t0))return[];
  w0.humano=null;
  const r=botCore(txt);if(!w0._ne)w0.noEnt=0;return r;
}
function botCore(txt){
  const t=norm(txt),wa=S.wa,cl=cliente();
  const rv=botReserva(t,txt);if(rv)return rv;
  if(/\bcancel/.test(t)){wa.step='inicio';wa.draft={};return['Listo, cancelé el pedido. Cuando quieras escribí *menú* para empezar de nuevo.']}
  if(wa.ultimo&&/^estado\b|^(como|que tal) (va|viene)\b|(como va|como viene|donde esta|que paso con|y) mi pedido|cuanto (falta|tarda|demora)|ya (sale|salio|viene|esta)\b|^y\s?\?*$/.test(t)||/^estado\b|(como va|como viene|donde esta) mi pedido/.test(t)){const p=S.pedidos.find(p=>p.id===wa.ultimo);return[p?`Tu pedido *#${p.num}* está: *${ESTADO[p.estado]}*${p.anulado?' (anulado)':''}.`:'Todavía no tenés pedidos hechos. Escribí *menú* para ver la carta.']}
  if(/^(menu|carta)\b/.test(t)){wa.step='pedido';return[cartaTxt(),'Escribí lo que querés, por ejemplo: *2 hamburguesas y 1 coca*']}
  if(/lo de siempre|lo mismo|repetir/.test(t)&&!/\bno\b|\bnada\b|\botra cosa\b/.test(t)){if(cl&&cl.ultItems)return pasoResumen(cl.ultItems.filter(l=>plato(l.id)),'');return['Todavía no tengo un pedido tuyo guardado 🙂 Decime qué querés, o escribí *menú*.']}
  // un saludo siempre arranca de cero (no seguir un pedido viejo a medio hacer)
  if(/^(hola|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal)\b/.test(t)&&t.split(' ').length<=4&&wa.step!=='inicio'){wa.step='inicio';wa.draft={}}
  // sumar cosas al último pedido (si todavía no salió)
  const ult=wa.ultimo&&S.pedidos.find(p=>p.id===wa.ultimo);
  const totalJunto=()=>ult?S.pedidos.filter(p=>(p.id===ult.id||p.agregaA===ult.id)&&!p.anulado).reduce((a,p)=>a+p.total,0):0;
  const ofrecerSuma=r=>{const sub=r.lines.reduce((a,l)=>a+lineInfo(l).precio*l.cant,0);wa.step='agregar';wa.draft={lines:r.lines,nota:r.nota};
    return[`Te sumo al pedido *#${ult.num}*:\n${r.lines.map(l=>{const x=lineInfo(l);return`• ${l.cant}× ${x.p.nombre} — ${fmt(x.precio*l.cant)}`}).join('\n')}\nSin envío extra: sale todo junto.\nTotal a pagar: *${fmt(totalJunto()+sub)}*\n\nRespondé *SI* para sumarlo o *NO* si es un pedido aparte.`]};
  if(wa.step==='agregar'&&ult&&!wa.draft.lines){const r=parsear(t);if(r.lines.length)return ofrecerSuma(r);if(!/^(no|nada|cancel)/.test(t))return['No te entendí qué sumar 🙈. Decime por ejemplo: *1 cerveza* o *2 papas*. O escribí *nada* si no querés agregar.'];wa.step='inicio';wa.draft={};return['Dale, dejamos el pedido como estaba 👍']}
  if(wa.step==='agregar'){
    if(/^(si|dale|ok|sumalo|de una|agregalo)/.test(t)&&ult&&wa.draft.lines){
      const r=crearPedido({origen:'whatsapp',por:'WhatsApp',cliente:ult.cliente,direccion:ult.direccion,tel:wa.tel,lines:wa.draft.lines,medio:ult.medio,nota:`➕ Va con el pedido #${ult.num}${wa.draft.nota?' · '+wa.draft.nota:''}`});
      if(r.error){wa.step='inicio';wa.draft={};return['Uy, justo se nos acabó: '+r.error+'.']}
      r.envio=0;r.total=r.subtotal;r.agregaA=ult.id;
      const c=S.clientes[wa.tel];if(c)c.gastado=(c.gastado||0)+r.total;
      wa.step='inicio';wa.draft={};save();
      return[`✅ ¡Listo! Sumé ${r.items.map(i=>i.cant+'× '+i.nombre).join(', ')} a tu pedido *#${ult.num}*. Sale todo junto.
Total a pagar: *${fmt(ult.total+r.total)}*.`];
    }
    if(/^no\b/.test(t)&&wa.draft.lines){const d=wa.draft;wa.draft={};wa.step='inicio';return pasoResumen(d.lines,d.nota)}
    wa.step='inicio';wa.draft={};
  }
  if(wa.step==='inicio'&&ult&&!ult.anulado&&['nuevo','preparando'].includes(ult.estado)&&Date.now()-ult.ts<90*60e3){
    const r=parsear(t),quiereSumar=/agreg|sumal|suma\b|sumame|tambien|ademas|me olvide|falto|otra cosa|y una?\b/.test(t);
    if(r.lines.length&&(quiereSumar||Date.now()-ult.ts<30*60e3))return ofrecerSuma(r);
    if(quiereSumar){wa.step='agregar';wa.draft={};return[`¿Qué querés que le sume a tu pedido *#${ult.num}*? Decime por ejemplo: *1 cerveza*.`]}
  }
  if(wa.step==='inicio'||(wa.step==='pedido'&&/^(hola|buenas|buen dia)/.test(t))){
    const r=parsear(t);if(r.lines.length)return pasoResumen(r.lines,r.nota);
    const saludo=/^(hola|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|hey|ey)\b/.test(t);
    if(!saludo&&(wa.ultimo||(cl&&cl.ult&&Date.now()-cl.ult<864e5))){wa.step='pedido';return noEntiendo(t)}
    wa.step='pedido';
    if(cl&&cl.ultItems)return[`¡Hola ${cl.nombre}! 👋 Qué bueno verte de nuevo.\n¿Te mando *lo de siempre*? (${cl.ultItems.map(l=>l.cant+'× '+(plato(l.id)||{}).nombre).join(', ')})\nO escribí *menú* para ver la carta.`];
    return[`¡Hola! 👋 Soy el asistente de *${S.negocio}*. Te tomo el pedido para delivery o te anoto una reserva.`,cartaTxt(),'Escribí lo que querés, por ejemplo: *2 hamburguesas sin tomate y 1 coca*\nPara reservar mesa escribí *reservar*.'];
  }
  if(wa.step==='pedido'){const r=parsear(t);if(!r.lines.length)return noEntiendo(t);return pasoResumen(r.lines,r.nota)}
  // en medio del pedido: sumar cosas, preguntar por un producto o pedir agregar algo
  if(['datos','pago','confirmar','mas'].includes(wa.step)&&wa.draft.lines){
    const paso=wa.step==='mas'?wa.draft.volver:wa.step;
    const pregunta=()=>paso==='datos'?'¿A nombre de quién y a qué dirección lo mandamos? (por ejemplo: *Juan, San Martín 1234*)':paso==='pago'?'¿Cómo vas a pagar?\n1️⃣ Efectivo\n2️⃣ Transferencia\n3️⃣ Mercado Pago':'Respondé *SI* para confirmar o *cancelar*.';
    const esPago=/^[123]\b|^ef|efect|cash|contado|transf|alias|cbu|mercado|^mp\b/.test(t),esSi=/^(si|dale|ok|confirmo|de una)\b/.test(t);
    const tieneDir=paso==='datos'&&(txt.includes(',')||/\d{2,}/.test(t));
    const r=(wa.step==='mas'||(!esPago&&!esSi&&!tieneDir&&!(paso==='datos'&&!/^(y|agrega|suma|tambien|ademas)\b/.test(t))))?parsear(t):{lines:[]};
    if(r.lines.length){
      const ls=wa.draft.lines.map(l=>({...l}));r.lines.forEach(n=>{const e=ls.find(l=>l.id===n.id&&!(l.mods||[]).length);if(e)e.cant+=n.cant;else ls.push(n)});
      const f=faltante(ls);if(f){wa.step=paso;return['Uy, de eso no nos queda suficiente hoy 😕. Seguimos con lo que tenías.\n'+pregunta()]}
      wa.draft.lines=ls;if(r.nota)wa.draft.nota=[wa.draft.nota,r.nota].filter(Boolean).join(' · ');wa.step=paso;delete wa.draft.volver;
      return['Listo, lo sumo ✅\n'+resumenItems(ls)+(wa.draft.nota?`\n📝 ${wa.draft.nota}`:''),pregunta()];
    }
    if(wa.step==='mas'){
      if(/^(no|nada|listo|eso|asi esta)\b/.test(t)){wa.step=paso;delete wa.draft.volver;return['Dale 👍 '+pregunta()]}
      const ne=noEntiendo(t);return[ne[0].replace(/\n¿Te tienta.*$|Decime qué querés.*$/,'')+'\nDecime qué sumar (ej: *1 coca*) o escribí *nada* para seguir.']}
    if(!esPago&&!esSi&&!tieneDir&&/agreg|sumar|suma\b|sumame|tambien|ademas|me olvide|falto|algo mas|otra cosa|cambiar el pedido/.test(t)){wa.draft.volver=paso;wa.step='mas';return['Dale, ¿qué le sumo? Decime por ejemplo: *1 coca* o *2 papas*.']}
    const q=!esPago&&!esSi&&!tieneDir&&(t.match(/^(?:y|y (?:un|una|unos|unas|el|la))\s+([a-zñ]{3,})\s*\??$/)||t.match(/\b(?:hay|tienen|tenes|venden|hacen)\s+(?:un|una|unos|unas)?\s*([a-zñ]{3,})/));
    if(q&&!NO_PRODUCTO.includes(q[1])){wa.consulta=q[1];return[`No tenemos *${q[1]}* en la carta 😕 Lo que hay: ${activos().map(p=>p.nombre).join(', ')}.`,pregunta()]}
  }
  if(wa.step==='datos'){
    if(t.length<5)return['Pasame nombre y dirección completa, por favor 🙏'];
    const i=txt.indexOf(',');wa.draft.cliente=i>0?txt.slice(0,i).trim():(wa.perfil||'Cliente');wa.draft.direccion=i>0?txt.slice(i+1).trim():txt.trim();
    wa.step='pago';return[`Genial, ${wa.draft.cliente}. ¿Cómo vas a pagar?\n1️⃣ Efectivo\n2️⃣ Transferencia\n3️⃣ Mercado Pago`];
  }
  if(wa.step==='pago'){
    if(/otra direc|cambiar direc/.test(t)){wa.step='datos';return['Dale, pasame nombre y la dirección nueva (ej: *Juan, San Martín 1234*).']}
    const m=/^1\b|^ef|efect|cash|contado|billete/.test(t)?'efectivo':/^2\b|transf|^trans|alias|cbu/.test(t)?'transferencia':/^3\b|mercado|^mp\b|^merc/.test(t)?'mp':null;
    if(!m)return['Respondé *1*, *2* o *3* para elegir la forma de pago. Si querés sumar algo, decime qué (ej: *1 coca*).'];
    wa.draft.medio=m;wa.step='confirmar';
    return[`📝 *Resumen del pedido*\n${resumenItems(wa.draft.lines)}${wa.draft.nota?`\n📝 ${wa.draft.nota}`:''}\n📍 ${wa.draft.direccion}\n💳 ${MEDIO[m]}${m==='transferencia'?`\nAlias: ${S.alias}`:''}${m==='mp'?'\nTe mandamos el link de pago al confirmar.':''}\n\nRespondé *SI* para confirmar o *cancelar*.`];
  }
  if(wa.step==='confirmar'){
    if(/^(si|dale|ok|confirmo|de una)/.test(t)){
      const d=wa.draft,r=crearPedido({origen:'whatsapp',por:'WhatsApp',cliente:d.cliente,direccion:d.direccion,tel:wa.tel,lines:d.lines,medio:d.medio,nota:d.nota});
      if(r.error){wa.step='pedido';return['Uy, justo se nos acabó algo: '+r.error+'. ¿Querés pedir otra cosa?']}
      const c=S.clientes[wa.tel]||{tel:wa.tel,pedidos:0,gastado:0};
      Object.assign(c,{nombre:d.cliente,dir:d.direccion,pedidos:c.pedidos+1,gastado:c.gastado+r.total,ult:Date.now(),ultItems:d.lines});S.clientes[wa.tel]=c;
      wa.ultimo=r.id;wa.step='inicio';wa.draft={};
      return[`✅ ¡Pedido *#${r.num}* confirmado y enviado a la cocina!\nDemora estimada: 35 a 45 min.\nEscribí *estado* cuando quieras saber cómo va.`];
    }
    if(/^no\b/.test(t)){wa.step='inicio';wa.draft={};return['Listo, no lo confirmo. Si querés empezar de nuevo escribí *menú*.']}
    return['Respondé *SI* para confirmar o *cancelar*.'];
  }
  wa.step='inicio';return bot(txt);
}
if(typeof module!=='undefined'&&module.exports)module.exports={};
