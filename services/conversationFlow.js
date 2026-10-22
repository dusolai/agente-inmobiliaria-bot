const config = require('../config/config');
const leadManager = require('./leadManager');
const messaging = require('./messaging');
const activityLog = require('./activityLog');
const messages = require('../templates/messages');

/**
 * Flujo conversacional de reactivación de leads (reunión 29-05).
 *
 * 1. Al lead se le envía la pregunta de filtrado (mensajeReactivacion) y queda
 *    en estado ESPERANDO_CUALIFICACION.
 * 2. Cuando responde por WhatsApp, este módulo interpreta la respuesta:
 *      - profesional  → landing para agentes inmobiliarios
 *      - emprendedor  → landing para emprendedores/colaboradores
 *    y lo pasa a VIDEO_ENVIADO enviándole la landing correspondiente.
 * 3. Si la respuesta no se entiende, se le re-pregunta sin cambiar de estado.
 */

const { LEAD_STATES, LEAD_PROFILES } = leadManager;

// Normaliza: minúsculas, sin acentos, sin espacios sobrantes.
// Rango ̀-ͯ = marcas diacríticas combinantes (tras normalize NFD).
function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const KEYWORDS_PROFESIONAL = ['agente', 'inmobiliaria', 'inmobiliario', 'profesional', 'agencia'];
const KEYWORDS_EMPRENDEDOR = ['sobresueldo', 'ingreso', 'extra', 'emprendedor', 'oportunidad', 'colaborador', 'plan b'];

/**
 * Interpreta la respuesta del lead a la pregunta de filtrado.
 * @returns {'profesional'|'emprendedor'|null}
 */
function interpretarRespuesta(texto) {
  const t = normalizar(texto);
  const tokens = t.split(/\s+/);

  // Opción numérica explícita
  if (tokens.includes('1')) return LEAD_PROFILES.PROFESIONAL;
  if (tokens.includes('2')) return LEAD_PROFILES.EMPRENDEDOR;

  // Negación del sector: "no trabajo en inmobiliaria", "no soy agente",
  // "nunca he trabajado en el sector"… → NO es profesional (16-10: Nuria
  // escribió "No trabajo en inmobiliaria" y recibió la landing de agentes).
  const NIEGA_SECTOR = /\b(no|nunca|ni)\b[^.?!]{0,25}\b(trabajo|trabaje|he trabajado|soy|estoy|me dedico)\b[^.?!]{0,25}\b(inmobiliari\w*|agente|agencia|sector)/;
  if (NIEGA_SECTOR.test(t)) return LEAD_PROFILES.EMPRENDEDOR;

  const esProfesional = KEYWORDS_PROFESIONAL.some((k) => t.includes(k));
  const esEmprendedor = KEYWORDS_EMPRENDEDOR.some((k) => t.includes(k));

  // Si solo coincide una rama, la usamos
  if (esProfesional && !esEmprendedor) return LEAD_PROFILES.PROFESIONAL;
  if (esEmprendedor && !esProfesional) return LEAD_PROFILES.EMPRENDEDOR;

  return null;
}

/**
 * Construye el enlace de la landing según el perfil, con el lead embebido
 * para el seguimiento de visualización del vídeo.
 */
function enlaceLandingPorPerfil(perfil, leadId) {
  const base = perfil === LEAD_PROFILES.PROFESIONAL
    ? config.landing.landingProfesionalUrl
    : config.landing.landingEmprendedorUrl;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}lead=${leadId}`;
}

/**
 * Punto de entrada para mensajes entrantes de WhatsApp.
 * @param {string} telefono – número sin sufijo (ej. "34666...")
 * @param {string} texto    – cuerpo del mensaje recibido
 */
// Interpreta una respuesta numérica (1 o 2) para la opción Ver ahora / Reservar.
function interpretarOpcionVerReservar(texto) {
  const t = normalizar(texto);
  const tokens = t.split(/\s+/);
  if (tokens.includes('1') || /\b(ver(la)?\s+ahora|ahora|ya)\b/.test(t)) return 'ver_ahora';
  if (tokens.includes('2') || /\b(reserv|agend|m[aá]s\s+tarde|despu[eé]s)\w*/.test(t)) return 'reservar';
  return null;
}

// Palabras de baja: si el lead pide que paremos, paramos — en cualquier estado.
// Evita denuncias de spam (aceleran el baneo del número) y cumple RGPD.
const OPTOUT_REGEX = /\b(baja|stop|unsubscribe|no me interesa|no interesa|no quiero|no estoy interesad[oa]|no gracias|no mas mensajes|no me escrib\w*|dejame en paz|dejadme en paz|no molestar|no molestes|borrame|borradme)\b/;

function esOptOut(texto) {
  return OPTOUT_REGEX.test(normalizar(texto));
}

// "Sí, envíamelo" (botón de la plantilla actual), "vale", "me interesa"…:
// el lead quiere la info pero no ha dicho si es agente o busca ingresos. En la
// prueba 31 personas pulsaron ese botón y el agente les volvió a preguntar
// 1/2: fricción justo cuando estaban calientes.
const AFIRMATIVO_REGEX = /^(si|sii+|vale|ok|okey|claro|por supuesto|adelante|perfecto|genial|envi(a|e)?(me)?(lo|la)?|mand(a|e)(me)?(lo|la)?|quiero|me interesa|info|informacion|dale)\b/;
function esAfirmativo(texto) {
  return AFIRMATIVO_REGEX.test(normalizar(texto));
}

/**
 * Perfil deducido de las respuestas del formulario de Meta (campaña de
 * captación de agentes inmobiliarios): todos se interesaron por trabajar en
 * el sector, así que van a la landing PROFESIONAL. Sin respuestas → null.
 */
function perfilDesdeFormulario(lead) {
  const r = lead && lead.respuestas;
  if (!r || !Object.keys(r).length) return null;
  return LEAD_PROFILES.PROFESIONAL;
}

// Respuestas automáticas de cuentas de empresa ("Gracias por comunicarte con
// nosotros…"). En la prueba el agente IA les contestaba: conversación con un
// robot. Se registran y no se responden.
const AUTORESPUESTA_REGEX = /(gracias por (tu|su) mensaje|gracias por comunicarte|gracias por contactar|gracias por escribir(nos)?|mensaje automatico|respuesta automatica|en este momento no (podemos|puedo|estamos)|fuera (del|de) (nuestro )?horario|te (responderemos|contestaremos)|le (responderemos|atenderemos)|nos pondremos en contacto contigo lo antes posible)/;
function esAutoRespuesta(texto) {
  return AUTORESPUESTA_REGEX.test(normalizar(texto));
}

// Saludos sueltos ("ei", "hola", "buenas"…). Si ya le hicimos la pregunta 1/2,
// un saludo no se contesta: la pregunta está justo encima. Pasaba al escribir
// "ei" + "hola" seguidos: el primero lanzaba la bienvenida y el segundo un
// "Perdona, igual no me he explicado bien" (parecía un mensaje duplicado).
const PIDE_ENLACE_REGEX = /\b(pasame|mandame|enviame|dame|pasa|manda|envia)( me)? (el )?(enlace|link)\b/;
// Botones de los avisos de la sesión reservada (sesion_hoy / sesion_preparacion)
const SESION_CONFIRMA_REGEX = /^(alli estare|ahi estare|alli estaremos|confirmo|confirmado|cuenta conmigo|cuenta(d)? conmigo|si,? (alli|ahi) estare|si,? confirmo|si,? voy|voy|ok,? (alli|ahi) estare)\b/;
const SESION_CAMBIAR_REGEX = /(cambiar (de )?dia|cambiar (la )?(fecha|hora|cita)|otro dia|no (voy a )?poder|no puedo (ir|asistir|conectarme)?|me ha surgido|reprogramar)/;
const SESION_YA_VISTA_REGEX = /^(ya la he visto|ya la vi|ya lo he visto|ya lo vi|la he visto)\b/;
const SESION_PIDE_PRESENTACION_REGEX = /(pasame|mandame|enviame|dame) (la )?presentacion/;
const SALUDO_REGEX = /^(e+i+|e+y+|hey+|hola+|holi+s?|buenas+|buenos dias|buenas (tardes|noches)|hi|hello|que tal|saludos)( (que tal|buenas|hola))?[\s!.?¡¿👋😊🙂]*$/u;
function esSaludo(texto) {
  return SALUDO_REGEX.test(normalizar(texto));
}

// ─── Alta automática de números desconocidos ─────────────────────
// Reunión 24-09: el número del agente va en el formulario de Karen y hay
// gente que, en vez de esperar, escribe directamente. Antes se ignoraba; ahora
// se da de alta en la campaña activa como lead "directo" y se le hace la
// pregunta de filtrado como texto libre (él ha escrito primero: la ventana de
// 24h está abierta y no hace falta plantilla). Límite por hora para que un
// bot o un spammer no nos llene el CRM.
const _altasRecientes = [];
function _puedeAutoAlta() {
  const ahora = Date.now();
  while (_altasRecientes.length && ahora - _altasRecientes[0] > 3600 * 1000) _altasRecientes.shift();
  if (_altasRecientes.length >= config.flujo.autoAltaMaxPorHora) return false;
  _altasRecientes.push(ahora);
  return true;
}

async function _autoAlta(telefono, texto, extra) {
  if (!config.flujo.autoAltaWhatsapp) return null;
  if (messaging.esTelegram(telefono)) return null;
  if (esOptOut(texto)) return null;
  if (!_puedeAutoAlta()) {
    console.warn(`⚠️  [Flujo] Alta automática de ${telefono} bloqueada: límite por hora (${config.flujo.autoAltaMaxPorHora})`);
    return null;
  }
  const nombre = (extra && extra.nombre && String(extra.nombre).trim()) || 'Sin nombre';
  const lead = leadManager.createLead({ nombre, telefono, fuente: 'whatsapp_entrante', segmento: 'directo' });
  leadManager.transitionState(lead.id, LEAD_STATES.ESPERANDO_CUALIFICACION);
  leadManager.updateLead(lead.id, {
    recordatorios: { ...lead.recordatorios, fase1: { enviados: 0, ultimoEnvio: new Date().toISOString() } },
  });
  activityLog.appendActivity(lead.id, 'auto_alta', { texto: String(texto).slice(0, 200), nombrePerfil: nombre });
  activityLog.appendActivity(lead.id, 'message_received', { texto });
  console.log(`🆕 [Flujo] ${nombre} (${telefono}) escribió sin ser lead → alta automática como "directo"`);
  return leadManager.getLeadById(lead.id);
}

async function _darDeBaja(lead, texto, via = 'palabra') {
  const result = leadManager.transitionState(lead.id, LEAD_STATES.DESCARTADO);
  if (result.error) {
    // Estado terminal sin transición válida: forzamos el descarte igualmente
    leadManager.updateLead(lead.id, { estado: LEAD_STATES.DESCARTADO, descartadoAt: new Date().toISOString() });
  }
  activityLog.appendActivity(lead.id, 'opt_out', { texto, via });
  console.log(`🛑 [Flujo] ${lead.nombre} pidió la baja (${via}) → descartado`);
  await messaging.sendTextMessage(
    lead.telefono,
    `Entendido ${lead.nombre}, no te escribimos más. Si algún día quieres retomarlo, aquí estaremos. Un abrazo.`,
    { delaySeconds: 0 }
  );
}

// ─── Derivación directa a Arkaitz (reunión 21-10) ───────────────
// Quien se pierde (pide una persona, no abre enlaces, da vueltas sin avanzar
// o pregunta lo mismo tras ya haberle contestado) recibe el WhatsApp directo
// de Arkaitz con el mensaje ya escrito (wa.me). Le atiende él en persona: su
// WhatsApp Business le saluda al momento. Nunca en el primer intercambio y
// una sola vez por lead. Se registra como `derivado_arkaitz` (lo ve el CRM).
function enlaceWhatsappArkaitz(lead, punto) {
  const tel = String(config.agent.directorWhatsapp || '').replace(/[^\d]/g, '');
  if (!tel) return null;
  const nombre = lead.nombre && lead.nombre !== 'Sin nombre' ? lead.nombre : '';
  const texto = `Hola ${config.agent.directorNombre}, soy ${nombre || '…'}. Vengo de la campaña de ${config.agent.empresaNombre}` +
    (punto ? ` y me he quedado en ${punto}.` : ' y tengo una duda.');
  return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
}

function _puntoDelEmbudo(lead) {
  switch (lead.estado) {
    case LEAD_STATES.ESPERANDO_CUALIFICACION: return 'la primera pregunta';
    case LEAD_STATES.VIDEO_ENVIADO: return 'la presentación';
    case LEAD_STATES.VIDEO_VISTO: return 'la reserva de la sesión';
    case LEAD_STATES.REUNION_REGISTRADO: return 'la sesión de dudas';
    default: return '';
  }
}

function _puedeDerivar(lead) {
  if (!config.flujo.derivacion.activa || !enlaceWhatsappArkaitz(lead)) return false;
  if (lead.derivadoArkaitzAt) return false;
  const recibidos = activityLog.getActivityByLead(lead.id).filter((e) => e.type === 'message_received').length;
  // Nunca a las primeras de cambio: ya dijo su perfil o lleva 2+ mensajes
  return Boolean(lead.perfil && lead.perfil !== 'sin_definir') || recibidos >= 2;
}

async function derivarAArkaitz(lead, motivo, texto) {
  if (!_puedeDerivar(lead)) return false;
  const now = new Date(Date.now()).toISOString();
  const enlace = enlaceWhatsappArkaitz(lead, _puntoDelEmbudo(lead));
  leadManager.updateLead(lead.id, { derivadoArkaitzAt: now, pideHumanoAt: lead.pideHumanoAt || now });
  activityLog.appendActivity(lead.id, 'derivado_arkaitz', { motivo, texto: String(texto || '').slice(0, 200) });
  console.log(`🙋 [Flujo] ${lead.nombre} → WhatsApp directo de ${config.agent.directorNombre} (${motivo})`);
  await messaging.sendTextMessage(lead.telefono, messages.mensajeDerivacionArkaitz({ nombre: lead.nombre, enlace }));
  return true;
}

// ¿Parece perdido? (a) da vueltas: ya ha recibido N respuestas automáticas en
// esta misma fase sin haber abierto la presentación ni Calendly; (b) "poco
// tecnológico": tiene la presentación desde hace 48 h, contesta, y nunca la
// abrió. Devuelve el motivo o null. Con sesión reservada, nunca.
function _pareceperdido(lead) {
  const D = config.flujo.derivacion;
  if (!D.activa) return null;
  if (![LEAD_STATES.VIDEO_ENVIADO, LEAD_STATES.VIDEO_VISTO].includes(lead.estado)) return null;
  if (lead.sesion && lead.sesion.estado === 'reservada') return null;
  const ev = activityLog.getActivityByLead(lead.id);
  if (ev.some((e) => /^(landing_view|video_play|calendly_intent)/.test(e.type))) return null;
  const respuestas = ev.filter((e) => e.type === 'router_reply' && e.meta && e.meta.estado === lead.estado).length;
  if (respuestas >= D.respuestasSinAvanzar) return 'da vueltas sin abrir la presentación';
  const envio = (lead.historial || []).filter((h) => h.estado === LEAD_STATES.VIDEO_ENVIADO).pop();
  const horas = envio ? (Date.now() - new Date(envio.fecha).getTime()) / 3600000 : 0;
  if (respuestas >= 1 && horas >= D.horasSinAbrir) return `no abre la presentación (${Math.round(horas)} h)`;
  return null;
}

// ─── La presentación es la LLAVE del Zoom (21-10) ────────────────
// Con sesión reservada, el acceso al Zoom se desbloquea al terminar la
// presentación (evento de la landing) o al contar en una frase qué le ha
// parecido (WhatsApp). Si la sesión es en menos de 3 h, el Zoom sale al momento.
async function enviarZoom(lead, via = 'scheduler') {
  const s = lead.sesion;
  if (!s || s.estado !== 'reservada') return false;
  const calendlySync = require('./calendlySync');
  let envio = null;
  if (messaging.dentroDeVentana(lead.telefono)) {
    envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionUnaHora({
      nombre: lead.nombre, hora: calendlySync.horaDe(s.inicio), joinUrl: s.joinUrl,
    }));
  } else if (config.whatsapp.templateSesionZoom && s.joinUrl) {
    // Plantilla con botón de enlace: la base es fija, va solo el sufijo
    const sufijo = String(s.joinUrl).split('zoom.us/j/')[1];
    if (sufijo) {
      envio = await messaging.sendTemplate(lead.telefono, [lead.nombre, calendlySync.describirCuando(s.inicio, { relativo: true })], {
        name: config.whatsapp.templateSesionZoom, lang: config.whatsapp.templateLang, varNames: ['nombre', 'cuando'], botonUrl: sufijo,
      });
    }
  }
  const ok = Boolean(envio) && envio.success !== false;
  if (ok) {
    const fresco = leadManager.getLeadById(lead.id);
    leadManager.updateLead(lead.id, { sesion: { ...fresco.sesion, avisos: { ...(fresco.sesion.avisos || {}), zoomEnviado: new Date(Date.now()).toISOString() } } });
    activityLog.appendActivity(lead.id, 'sesion_zoom_enviado', { via, inicio: s.inicio });
  }
  return ok;
}

async function presentacionCompletada(lead, via = 'landing') {
  const s = lead.sesion;
  if (!s || s.estado !== 'reservada') return false;
  if (!s.formado) {
    leadManager.updateLead(lead.id, { sesion: { ...s, formado: true, formadoAt: new Date(Date.now()).toISOString() } });
    activityLog.appendActivity(lead.id, 'sesion_formado', { via });
    console.log(`🎓 [Flujo] ${lead.nombre} llega formado a la sesión (${via})`);
  }
  const faltan = new Date(s.inicio).getTime() - Date.now();
  if (faltan > 0 && faltan <= 3 * 3600 * 1000 && !(s.avisos && s.avisos.zoomEnviado)) {
    return enviarZoom(leadManager.getLeadById(lead.id), via);
  }
  return true;
}

// Reservar primero: enlace de la sesión para el mensaje tras cualificar
// (null si RESERVA_PRIMERO=false o si ya tiene una sesión reservada).
function _enlaceSesionSiReservaPrimero(lead) {
  if (!config.flujo.reservaPrimero) return null;
  if (lead.sesion && lead.sesion.estado === 'reservada') return null;
  return enlaceRedirectorCalendly(lead, 'grupal');
}

function _textoLanding(perfil, lead) {
  const enlaceLanding = enlaceLandingPorPerfil(perfil, lead.id);
  return perfil === LEAD_PROFILES.PROFESIONAL
    ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) })
    : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) });
}

/**
 * Mensaje fuera de guion → el router decide qué hacer (responder, perfil,
 * baja, humano o silencio). Devuelve el perfil si el router lo ha deducido,
 * para que la fase de cualificación siga como si hubiera dicho 1/2.
 */
async function _rutear(lead, texto, { textoPorDefecto = null, silenciar = false } = {}) {
  // Mensaje intermedio de una ráfaga: no se decide nada; el último del lote
  // pasa por el router con todos en el historial y contesta una vez.
  if (silenciar) return null;
  const responder = require('./responder');
  const d = await responder.decidir(lead, texto);
  switch (d.accion) {
    case 'perfil':
      return d.perfil;
    case 'baja':
      await _darDeBaja(lead, texto, 'router');
      return null;
    case 'humano':
      leadManager.updateLead(lead.id, { pideHumanoAt: new Date().toISOString() });
      activityLog.appendActivity(lead.id, 'pide_humano', { texto: String(texto).slice(0, 200) });
      if (silenciar) return null;
      // Pide una persona / no abre enlaces → WhatsApp directo de Arkaitz.
      // Si aún no toca derivar (primer intercambio), la respuesta de reglas.
      if (await derivarAArkaitz(lead, 'pide una persona', texto)) return null;
      if (d.texto) await messaging.sendTextMessage(lead.telefono, d.texto);
      return null;
    case 'silencio':
      return null;
    default: {
      const t = d.texto || textoPorDefecto;
      if (t && !silenciar) await messaging.sendTextMessage(lead.telefono, t);
      return null;
    }
  }
}

// ─── Mensajes en ráfaga ─────────────────────────────────────────
// La gente escribe en varios mensajes seguidos ("Ok" + "Gracias", o "Soy
// agente" + "pero ando liado"). Cada uno llegaba en su propia petición del
// webhook y se procesaba EN PARALELO: dos landings a la vez, o dos respuestas
// casi iguales (17-10: Rosana, tina, Diego Emanuel). Ahora se agrupan por
// teléfono: se espera AGRUPAR_MENSAJES_SEGUNDOS sin mensajes nuevos y se
// procesan EN ORDEN; solo el último del lote recibe respuesta del router (que
// ve todos en el historial). Los botones, el perfil y la baja se aplican igual.
const _lotes = new Map();
function _segundosAgrupar() {
  const v = parseInt(process.env.AGRUPAR_MENSAJES_SEGUNDOS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 6;
}

function recibir(telefono, texto, extra = {}) {
  const tel = String(telefono);
  let lote = _lotes.get(tel);
  if (!lote) {
    lote = { mensajes: [], timer: null, cadena: Promise.resolve() };
    _lotes.set(tel, lote);
  }
  lote.mensajes.push({ texto, extra });
  if (lote.timer) clearTimeout(lote.timer);
  return new Promise((resolve) => {
    lote.timer = setTimeout(() => {
      const pendientes = lote.mensajes.splice(0);
      lote.timer = null;
      lote.cadena = lote.cadena.then(async () => {
        for (let i = 0; i < pendientes.length; i++) {
          const { texto: t, extra: x } = pendientes[i];
          try {
            await handleIncoming(tel, t, { ...x, silenciar: i < pendientes.length - 1 });
          } catch (err) {
            console.error('❌ [Flujo] Error procesando mensaje entrante:', err.message);
          }
        }
        if (!lote.timer && lote.mensajes.length === 0) _lotes.delete(tel);
      });
      lote.cadena.then(resolve);
    }, _segundosAgrupar() * 1000);
  });
}

async function handleIncoming(telefono, texto, extra = {}) {
  let lead = leadManager.getLeadByPhone(telefono);
  if (!lead) {
    lead = await _autoAlta(telefono, texto, extra);
    if (!lead) {
      // No es un lead conocido y no procede el alta: no respondemos, pero lo
      // dejamos dicho en el log para que "no responde" nunca sea un misterio.
      console.log(`🤷 [Flujo] Mensaje de ${telefono} SIN lead asociado — ignorado: "${String(texto).slice(0, 50)}"`);
      return;
    }
    // Recién creado: si ya nos dice 1/2 se procesa abajo como cualquier lead;
    // si no, le hacemos la pregunta de filtrado (texto libre, ventana abierta).
    if (!interpretarRespuesta(texto)) {
      activityLog.appendActivity(lead.id, 'welcome_sent', null);
      await messaging.sendTextMessage(
        lead.telefono,
        messages.mensajeReactivacion({ nombre: lead.nombre, segmento: 'directo' })
      );
      return;
    }
  } else {
    // Registramos toda la actividad inbound del lead, esté en el estado que esté
    activityLog.appendActivity(lead.id, 'message_received', { texto });
  }

  // ─── Opt-out: prioridad absoluta sobre cualquier fase ───────────
  if (esOptOut(texto) && lead.estado !== LEAD_STATES.DESCARTADO) {
    await _darDeBaja(lead, texto);
    return;
  }

  // ─── Respuestas automáticas de empresas: no se contestan ────────
  if (esAutoRespuesta(texto)) {
    activityLog.appendActivity(lead.id, 'auto_respuesta', { texto: String(texto).slice(0, 200) });
    console.log(`🤖 [Flujo] ${lead.nombre}: respuesta automática de su WhatsApp → no se contesta`);
    return;
  }

  // ─── Fase A: respuesta a la pregunta de cualificación ──────────
  // Tras cualificar enviamos la LANDING directamente (con sus vídeos). En la
  // landing ven primero el VSL, luego el webinar, y al terminarlo aparece el
  // botón de reservar la 1-a-1. El Calendly grupal se ofrece como OPCIÓN.
  if (lead.estado === LEAD_STATES.ESPERANDO_CUALIFICACION) {
    let perfil = interpretarRespuesta(texto);
    if (!perfil && esAfirmativo(texto)) {
      perfil = perfilDesdeFormulario(lead);
      if (perfil) activityLog.appendActivity(lead.id, 'perfil_por_formulario', { texto: String(texto).slice(0, 80), perfil });
    }
    if (!perfil) {
      // ¿Ya recibió la bienvenida? Si NO (caso típico: el lead escribe "hola"
      // primero, sin que le hayamos escrito), le mandamos el mensaje de
      // bienvenida COMPLETO — no una respuesta corta del LLM.
      const yaBienvenida = activityLog.getActivityByLead(lead.id).some((e) => e.type === 'welcome_sent');
      if (!yaBienvenida) {
        activityLog.appendActivity(lead.id, 'welcome_sent', null);
        console.log(`👋 [Flujo] ${lead.nombre} escribió sin bienvenida previa → enviando bienvenida completa`);
        await messaging.sendTextMessage(
          lead.telefono,
          messages.mensajeReactivacion({ nombre: lead.nombre, segmento: lead.segmento })
        );
        return;
      }
      // Mensajes que se cruzan con la bienvenida (escribió dos seguidos, p. ej.
      // "ei" + "hola"): la pregunta acaba de salir, no se contesta nada.
      const eventos = activityLog.getActivityByLead(lead.id);
      const ultimaBienvenida = eventos.filter((e) => e.type === 'welcome_sent' || e.type === 'message_sent').pop();
      const hace = ultimaBienvenida ? Date.now() - new Date(ultimaBienvenida.ts).getTime() : Infinity;
      const corto = !String(texto).includes('?') && String(texto).trim().split(/\s+/).length <= 3;
      if (hace < 2 * 60 * 1000 && (corto || esSaludo(texto))) {
        console.log(`🤫 [Flujo] ${lead.nombre}: "${String(texto).slice(0, 30)}" se cruzó con la pregunta → sin respuesta`);
        return;
      }
      // Ya tiene la bienvenida y sigue sin decir 1/2 → el router decide: quizá
      // nos ha dicho su perfil con otras palabras, quiere la baja, pregunta
      // algo… Si no hay nada mejor, se repite la pregunta 1/2.
      perfil = await _rutear(lead, texto, {
        textoPorDefecto: messages.mensajeReintentarCualificacion({ nombre: lead.nombre }),
        silenciar: Boolean(extra.silenciar),
      });
      if (!perfil) return;
      activityLog.appendActivity(lead.id, 'perfil_por_router', { texto: String(texto).slice(0, 80), perfil });
    }
    leadManager.updateLead(lead.id, { perfil });
    activityLog.appendActivity(lead.id, 'profile_set', { perfil });

    // ─── Modo PRESENTACIÓN EN DIRECTO (reunión 01-10) ─────────────
    // En vez de la landing, invitación a reservar la presentación en directo
    // (Calendly grupal). Estado "video_enviado" = invitación enviada; al
    // reservar (webhook de Calendly) pasa a "video_visto" = plaza reservada.
    if (config.flujo.trasCualificar === 'presentacion') {
      const r = leadManager.transitionState(lead.id, LEAD_STATES.VIDEO_ENVIADO);
      if (r.error) {
        console.error(`❌ [Flujo] No se pudo avanzar el lead ${lead.id}: ${r.error}`);
        return;
      }
      const enlaceGrupal = enlaceRedirectorCalendly(lead, 'grupal');
      console.log(`🔀 [Flujo] Lead ${lead.nombre} cualificado como ${perfil} → invitación a la presentación en directo`);
      await messaging.sendTextMessage(
        lead.telefono,
        messages.mensajeInvitacionPresentacion({ nombre: lead.nombre, enlaceGrupal })
      );
      return;
    }

    // Se le ENVÍA la landing, pero AÚN NO la ha visto → estado "video_enviado".
    // Solo pasa a "video_visto" cuando la propia landing (vsl.js) avise de que
    // realmente ha visto el VSL (evento de progreso 90% / completado). Así el
    // CRM no marca "vídeo visto" nada más responder 1/2.
    const result = leadManager.transitionState(lead.id, LEAD_STATES.VIDEO_ENVIADO);
    if (result.error) {
      console.error(`❌ [Flujo] No se pudo avanzar el lead ${lead.id}: ${result.error}`);
      return;
    }
    const enlaceLanding = enlaceLandingPorPerfil(perfil, lead.id);
    const texto2 = perfil === LEAD_PROFILES.PROFESIONAL
      ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) })
      : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) });
    console.log(`🔀 [Flujo] Lead ${lead.nombre} cualificado como ${perfil} → landing ENVIADA (pdte. de ver)`);
    await messaging.sendTextMessage(lead.telefono, texto2);
    return;
  }

  // ─── Sesión RESERVADA: botones de los avisos y feedback ─────────
  if (lead.sesion && lead.sesion.estado === 'reservada') {
    const t = normalizar(texto);
    const s = lead.sesion;
    if (SESION_CONFIRMA_REGEX.test(t)) {
      leadManager.updateLead(lead.id, { sesion: { ...s, confirmada: true, confirmadaAt: new Date().toISOString() } });
      activityLog.appendActivity(lead.id, 'sesion_confirmada', { texto: String(texto).slice(0, 80) });
      await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionConfirmada({ nombre: lead.nombre }));
      return;
    }
    if (SESION_CAMBIAR_REGEX.test(t)) {
      activityLog.appendActivity(lead.id, 'sesion_cambiar_dia', { texto: String(texto).slice(0, 80) });
      const enlace = s.rescheduleUrl || enlaceRedirectorCalendly(lead, 'grupal');
      await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionCambiarDia({ nombre: lead.nombre, enlace }));
      return;
    }
    if (SESION_YA_VISTA_REGEX.test(t)) {
      leadManager.updateLead(lead.id, { esperandoFeedback: true });
      activityLog.appendActivity(lead.id, 'sesion_presentacion_vista', { texto: String(texto).slice(0, 80) });
      await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionPideFeedback({ nombre: lead.nombre }));
      return;
    }
    if (SESION_PIDE_PRESENTACION_REGEX.test(t)) {
      await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionPreparacion({
        nombre: lead.nombre, enlaceLanding: enlaceLandingPorPerfil(lead.perfil, lead.id),
      }));
      return;
    }
    // Lo que escriba tras "Ya la he visto" (o tras el aviso de preparación)
    // es su opinión / su duda para Arkaitz: se guarda en la ficha del lead.
    if (lead.esperandoFeedback && String(texto).trim().length >= 3) {
      const feedback = [...(lead.feedbackSesion || []), { texto: String(texto).slice(0, 1000), ts: new Date().toISOString() }];
      leadManager.updateLead(lead.id, { esperandoFeedback: false, feedbackSesion: feedback });
      activityLog.appendActivity(lead.id, 'feedback_sesion', { texto: String(texto).slice(0, 300) });
      await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionFeedbackApuntado({ nombre: lead.nombre }));
      // Su opinión vale como "presentación vista": desbloquea el Zoom
      await presentacionCompletada(leadManager.getLeadById(lead.id), 'whatsapp');
      return;
    }
  }

  // ─── Botón "Pásame el enlace" de los recordatorios ──────────────
  // Quien lo pulsa quiere apuntarse: se le manda el enlace de la sesión de
  // dudas (Calendly) directamente, sin volver a pasar por la landing.
  if (PIDE_ENLACE_REGEX.test(normalizar(texto))) {
    const enlaceSesion = enlaceRedirectorCalendly(lead, 'grupal');
    activityLog.appendActivity(lead.id, 'pide_enlace_sesion', { texto: String(texto).slice(0, 80) });
    console.log(`📅 [Flujo] ${lead.nombre} pidió el enlace → sesión de dudas enviada`);
    await messaging.sendTextMessage(lead.telefono, messages.mensajeEnlaceSesion({ nombre: lead.nombre, enlaceSesion }));
    return;
  }

  // ─── Lead curioso: ya cualificó pero pide ver también la OTRA rama ──
  // Si escribe algo que se interpreta como un perfil ("1"/"2", "soy agente",
  // "busco ingreso extra"...), le enviamos ESA landing igualmente, sin cambiar
  // su estado ni su perfil principal. Así quien tiene curiosidad puede ver las
  // dos presentaciones (antes, tras elegir una, la otra quedaba blindada).
  const pideOtraRama = interpretarRespuesta(texto);
  if (pideOtraRama) {
    const enlaceLanding = enlaceLandingPorPerfil(pideOtraRama, lead.id);
    const texto2 = pideOtraRama === LEAD_PROFILES.PROFESIONAL
      ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) })
      : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding, enlaceSesion: _enlaceSesionSiReservaPrimero(lead) });
    console.log(`🔎 [Flujo] ${lead.nombre} (curioso) pidió la rama ${pideOtraRama} → landing enviada`);
    await messaging.sendTextMessage(lead.telefono, texto2);
    return;
  }

  // ─── Resto de estados: router de decisión ───────────────────────
  // El lead ya está dentro del embudo (landing, 1-a-1...) y escribe algo
  // ("dale", una duda, "llámame"…). El router decide: contestar y recordarle
  // su siguiente paso, pasarlo a una persona, darle de baja o no decir nada.
  // Con IA decide el modelo; sin IA, reglas fijas — nunca se queda colgado.
  const motivoPerdido = _pareceperdido(lead);
  if (motivoPerdido && !extra.silenciar && await derivarAArkaitz(lead, motivoPerdido, texto)) return;

  const perfilRouter = await _rutear(lead, texto, { silenciar: Boolean(extra.silenciar) });
  if (perfilRouter) {
    console.log(`🔎 [Flujo] ${lead.nombre}: el router entiende que quiere la rama ${perfilRouter} → landing enviada`);
    await messaging.sendTextMessage(lead.telefono, _textoLanding(perfilRouter, lead));
  }
}

/**
 * Construye un enlace de Calendly personalizado por lead.
 *
 * Añade al enlace base parámetros que viajan con la reserva:
 *  - utm_source / utm_medium / utm_content=lead_<id>  (visibles en el panel de
 *    Calendly y en webhooks; permiten saber qué lead reservó qué).
 *  - name / email (rellenan automáticamente el formulario de Calendly).
 *
 * En cuanto Calendly Standard esté activo, el webhook de Calendly recibirá
 * estos datos y el endpoint /tracking/calendly-booked podrá mover al lead a
 * "reunion_registrado" automáticamente.
 */
function enlaceCalendlyConTracking(baseUrl, lead) {
  if (!baseUrl || baseUrl === '#') return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('utm_source', 'embudo');
    url.searchParams.set('utm_medium', 'whatsapp');
    url.searchParams.set('utm_content', `lead_${lead.id}`);
    if (lead.nombre && lead.nombre !== 'Sin nombre') url.searchParams.set('name', lead.nombre);
    if (lead.email) url.searchParams.set('email', lead.email);
    return url.toString();
  } catch (e) {
    // Si la URL no es válida, devolvemos la original tal cual
    return baseUrl;
  }
}

/**
 * Construye la URL del redirector propio que el bot manda al lead.
 * Esta URL es la que va por WhatsApp/Telegram. El backend registra el clic
 * y redirige a la URL real de Calendly (ya con UTMs + prefill).
 *
 *   tipo: 'grupal' | 'individual'
 *   resultado: https://<backend>/r/<tipo>?l=<leadId>
 */
function enlaceRedirectorCalendly(lead, tipo) {
  const base = config.backendPublicUrl.replace(/\/$/, '');
  return `${base}/r/${tipo}?l=${encodeURIComponent(lead.id)}`;
}

/**
 * Extrae el leadId de un valor utm_content del tipo "lead_<uuid>".
 */
function leadIdDesdeUtm(utmContent) {
  if (!utmContent || typeof utmContent !== 'string') return null;
  const m = utmContent.match(/^lead_(.+)$/);
  return m ? m[1] : null;
}

/**
 * Reserva en el Calendly GRUPAL confirmada (webhook de Calendly o página de
 * confirmación). Qué significa depende del modo:
 *  - landing: reservó la sesión grabada → le llega el acceso a la landing
 *  - presentacion: reservó la presentación en directo → confirmación; el
 *    1-a-1 se le manda cuando asista (webhook de Zoom)
 * Solo actúa si el lead está en video_enviado; si no, no-op (idempotente con
 * el redirect y el webhook, que pueden llegar los dos).
 */
async function procesarReservaGrupal(lead, { via = 'webhook', evento = null, inicio = null } = {}) {
  if (!lead || lead.estado !== LEAD_STATES.VIDEO_ENVIADO) return false;
  leadManager.transitionState(lead.id, LEAD_STATES.VIDEO_VISTO);
  if (config.flujo.trasCualificar === 'presentacion') {
    leadManager.updateLead(lead.id, { presentacionAt: inicio || null, presentacionReservadaAt: new Date().toISOString() });
    activityLog.appendActivity(lead.id, 'presentacion_reservada', { via, evento, inicio });
    console.log(`📅 [Flujo] ${lead.nombre} reservó la PRESENTACIÓN en directo (${inicio || 'hora sin informar'})`);
    await messaging.sendTextMessage(lead.telefono, messages.mensajeReservaPresentacionConfirmada({ nombre: lead.nombre }));
    return true;
  }
  const enlaceLanding = enlaceLandingPorPerfil(lead.perfil, lead.id);
  console.log(`📅 [Flujo] Reserva GRUPAL de ${lead.nombre} (${via}) → landing enviada`);
  await messaging.sendTextMessage(
    lead.telefono,
    messages.mensajeAccesoVideoTrasReserva({ nombre: lead.nombre, enlaceLanding, perfil: lead.perfil })
  );
  return true;
}

/**
 * El lead ASISTIÓ a una reunión de Zoom (webhook de Zoom o botón del CRM).
 *  - modo presentación + estado video_visto (plaza reservada): asistió a la
 *    presentación en directo → se le manda el enlace del 1-a-1 (cierre) y
 *    pasa a reunion_registrado (la Fase 3 le recuerda reservar).
 *  - en cualquier otro caso la reunión ES el 1-a-1 → reunion_asistio, sin
 *    reenviar nada (ya lo tiene y acaba de asistir).
 */
async function procesarAsistenciaReunion(lead, { minutos = null, via = 'zoom' } = {}) {
  if (!lead) return { error: 'lead no encontrado', lead: null };
  if (config.flujo.trasCualificar === 'presentacion' && lead.estado === LEAD_STATES.VIDEO_VISTO) {
    const r = leadManager.transitionState(lead.id, LEAD_STATES.REUNION_REGISTRADO);
    if (r.error) return r;
    leadManager.updateLead(lead.id, { reunionRegistradoAt: new Date().toISOString() });
    activityLog.appendActivity(lead.id, 'presentacion_asistida', { minutos, via });
    const enlaceCalendly = enlaceRedirectorCalendly(lead, 'individual');
    console.log(`🤝 [Flujo] ${lead.nombre} asistió a la presentación (${minutos != null ? minutos + ' min' : via}) → 1-a-1 enviado`);
    await messaging.sendTextoOPlantilla(lead, messages.mensajeCierre({ nombre: lead.nombre, enlaceCalendly }), messaging.PLANTILLA_1A1);
    return { error: null, lead: leadManager.getLeadById(lead.id), cierreEnviado: true };
  }
  const r = leadManager.transitionState(lead.id, LEAD_STATES.REUNION_ASISTIO);
  if (!r.error) console.log(`🤝 [Flujo] ${lead.nombre} asistió al 1-a-1 (${minutos != null ? minutos + ' min' : via})`);
  return { ...r, cierreEnviado: false };
}

module.exports = {
  esAfirmativo,
  esAutoRespuesta,
  perfilDesdeFormulario,
  handleIncoming,
  recibir,
  enlaceWhatsappArkaitz,
  derivarAArkaitz,
  presentacionCompletada,
  enviarZoom,
  procesarReservaGrupal,
  procesarAsistenciaReunion,
  interpretarRespuesta,
  enlaceLandingPorPerfil,
  enlaceCalendlyConTracking,
  enlaceRedirectorCalendly,
  leadIdDesdeUtm,
};
