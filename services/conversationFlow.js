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
const OPTOUT_REGEX = /\b(baja|stop|unsubscribe|no me interesa|no interesa|no quiero|dejame en paz|dejadme en paz|no molestar|no molestes|borrame|borradme)\b/;

function esOptOut(texto) {
  return OPTOUT_REGEX.test(normalizar(texto));
}

async function handleIncoming(telefono, texto) {
  const lead = leadManager.getLeadByPhone(telefono);
  if (!lead) {
    // No es un lead conocido: no respondemos, pero lo dejamos dicho en el
    // log para que "no responde" nunca sea un misterio.
    console.log(`🤷 [Flujo] Mensaje de ${telefono} SIN lead asociado — ignorado: "${String(texto).slice(0, 50)}"`);
    return;
  }

  // Registramos toda la actividad inbound del lead, esté en el estado que esté
  activityLog.appendActivity(lead.id, 'message_received', { texto });

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

  // ─── Fase A: respuesta a la pregunta de cualificación ──────────
  // Tras cualificar enviamos la LANDING directamente (con sus vídeos). En la
  // landing ven primero el VSL, luego el webinar, y al terminarlo aparece el
  // botón de reservar la 1-a-1. El Calendly grupal se ofrece como OPCIÓN.
  if (lead.estado === LEAD_STATES.ESPERANDO_CUALIFICACION) {
    const perfil = interpretarRespuesta(texto);
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
          messages.mensajeReactivacion({ nombre: lead.nombre })
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
    // Directo a video_visto: ya tiene la landing y está "dentro del funnel".
    const result = leadManager.transitionState(lead.id, LEAD_STATES.VIDEO_VISTO);
    if (result.error) {
      console.error(`❌ [Flujo] No se pudo avanzar el lead ${lead.id}: ${result.error}`);
      return;
    }
    leadManager.updateLead(lead.id, { videoVistoAt: new Date().toISOString() });
    const enlaceLanding = enlaceLandingPorPerfil(perfil, lead.id);
    const enlaceGrupal = enlaceRedirectorCalendly(lead, 'grupal');
    const texto2 = perfil === LEAD_PROFILES.PROFESIONAL
      ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding, enlaceGrupal })
      : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding, enlaceGrupal });
    console.log(`🔀 [Flujo] Lead ${lead.nombre} cualificado como ${perfil} → landing enviada (grupal opcional)`);
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

module.exports = {
  handleIncoming,
  interpretarRespuesta,
  enlaceLandingPorPerfil,
  enlaceCalendlyConTracking,
  enlaceRedirectorCalendly,
  leadIdDesdeUtm,
};
