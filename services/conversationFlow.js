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
    const result = leadManager.transitionState(lead.id, LEAD_STATES.DESCARTADO);
    if (result.error) {
      // Estado terminal sin transición válida: forzamos el descarte igualmente
      leadManager.updateLead(lead.id, { estado: LEAD_STATES.DESCARTADO, descartadoAt: new Date().toISOString() });
    }
    activityLog.appendActivity(lead.id, 'opt_out', { texto });
    console.log(`🛑 [Flujo] ${lead.nombre} pidió la baja → descartado`);
    await messaging.sendTextMessage(
      lead.telefono,
      `Entendido ${lead.nombre}, no te escribimos más. Si algún día quieres retomarlo, aquí estaremos. Un abrazo.`,
      { delaySeconds: 0 }
    );
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
      // Ya tiene la bienvenida y sigue sin decir 1/2 → es que pregunta algo.
      // Ahí sí entra el LLM (responde en contexto y reconduce al 1/2). Sin LLM
      // configurado o si falla, se repite la pregunta.
      const responder = require('./responder');
      const respuestaLlm = await responder.responder(lead, texto);
      await messaging.sendTextMessage(
        lead.telefono,
        respuestaLlm || messages.mensajeReintentarCualificacion({ nombre: lead.nombre })
      );
      return;
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
      ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding })
      : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding });
    console.log(`🔀 [Flujo] Lead ${lead.nombre} cualificado como ${perfil} → landing ENVIADA (pdte. de ver)`);
    await messaging.sendTextMessage(lead.telefono, texto2);
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
      ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding })
      : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding });
    console.log(`🔎 [Flujo] ${lead.nombre} (curioso) pidió la rama ${pideOtraRama} → landing enviada`);
    await messaging.sendTextMessage(lead.telefono, texto2);
    return;
  }

  // ─── Resto de estados: respuesta conversacional con LLM ─────────
  // El lead ya está dentro del embudo (reserva, landing, 1-a-1...) y
  // escribe algo. El LLM contesta su duda y le recuerda su siguiente paso
  // con el enlace que le toca. Sin LLM configurado, silencio como antes
  // (el mensaje aparece en "Sin responder" del CRM para atenderlo a mano).
  const responder = require('./responder');
  const respuestaLlm = await responder.responder(lead, texto);
  if (respuestaLlm) {
    await messaging.sendTextMessage(lead.telefono, respuestaLlm);
  } else {
    console.log(`💬 [Flujo] ${lead.nombre} (${lead.estado}) escribió y no hay respuesta automática — revisar "Sin responder" en el CRM`);
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
  procesarReservaGrupal,
  procesarAsistenciaReunion,
  interpretarRespuesta,
  enlaceLandingPorPerfil,
  enlaceCalendlyConTracking,
  enlaceRedirectorCalendly,
  leadIdDesdeUtm,
};
