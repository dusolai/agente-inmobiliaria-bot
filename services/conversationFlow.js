const config = require('../config/config');
const leadManager = require('./leadManager');
const whatsapp = require('./whatsapp');
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
async function handleIncoming(telefono, texto) {
  const lead = leadManager.getLeadByPhone(telefono);
  if (!lead) return; // mensaje de alguien que no es un lead conocido

  // Solo nos interesa la respuesta a la pregunta de filtrado
  if (lead.estado !== LEAD_STATES.ESPERANDO_CUALIFICACION) return;

  const perfil = interpretarRespuesta(texto);

  if (!perfil) {
    await whatsapp.sendTextMessage(
      lead.telefono,
      messages.mensajeReintentarCualificacion({ nombre: lead.nombre })
    );
    return;
  }

  // Guardar perfil y avanzar a "vídeo enviado"
  leadManager.updateLead(lead.id, { perfil });
  const result = leadManager.transitionState(lead.id, LEAD_STATES.VIDEO_ENVIADO);
  if (result.error) {
    console.error(`❌ [Flujo] No se pudo avanzar el lead ${lead.id}: ${result.error}`);
    return;
  }

  const enlaceLanding = enlaceLandingPorPerfil(perfil, lead.id);
  const texto2 = perfil === LEAD_PROFILES.PROFESIONAL
    ? messages.mensajeRamaProfesional({ nombre: lead.nombre, enlaceLanding })
    : messages.mensajeRamaEmprendedor({ nombre: lead.nombre, enlaceLanding });

  console.log(`🔀 [Flujo] Lead ${lead.nombre} cualificado como ${perfil} → landing enviada`);
  await whatsapp.sendTextMessage(lead.telefono, texto2);
}

module.exports = { handleIncoming, interpretarRespuesta, enlaceLandingPorPerfil };
