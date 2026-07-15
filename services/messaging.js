/**
 * Dispatcher de mensajería con humanización.
 *
 * - Decide el canal (Telegram o WhatsApp) según el prefijo del lead:
 *     "tg:<chat_id>"  → Telegram
 *     cualquier otro  → WhatsApp (número de teléfono)
 * - Antes de cada envío:
 *     1) Envía indicador de "escribiendo…" al canal.
 *     2) Espera `typingDelaySeconds` (default 10s; configurable por mensaje).
 *     3) Envía el mensaje real.
 *
 * Esto simula una conversación humana — lo pidió Arkaitz en la reunión final.
 */

const config = require('../config/config');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');

const TG_PREFIX = telegram.TG_PREFIX || 'tg:';

// Deja constancia en el CRM de cada mensaje que sale (y de si salió bien).
// require perezoso para evitar ciclos de dependencia en el arranque.
function _registrarEnvio(telefono, text, resultado, extraMeta) {
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (!lead) return;
    activityLog.appendActivity(lead.id, 'message_sent', {
      preview: String(text).slice(0, 500), // 500: suficiente para leerlo entero en el chat del CRM
      ok: resultado ? resultado.success !== false : null,
      modo: resultado && resultado.mode ? resultado.mode : undefined,
      ...(extraMeta || {}), // p. ej. { manual: true } cuando lo escribes tú desde el CRM
    });
  } catch (e) { /* el registro nunca debe romper un envío */ }
}

function esTelegram(telefono) {
  return typeof telefono === 'string' && telefono.startsWith(TG_PREFIX);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/**
 * Envía un mensaje de texto al lead, con un pequeño delay y el indicador de
 * "escribiendo" antes para que parezca humano.
 *
 * @param {string} telefono            – identificador del lead
 * @param {string} text                – texto del mensaje
 * @param {object} [opts]
 * @param {number} [opts.delaySeconds] – override del delay; null = sin delay
 */
async function sendTextMessage(telefono, text, opts = {}) {
  const delaySeconds = opts.delaySeconds != null ? opts.delaySeconds : config.agent.typingDelaySeconds;
  const conTipping = delaySeconds > 0;

  try {
    let resultado;
    if (esTelegram(telefono)) {
      if (conTipping) {
        await telegram.sendTypingAction(telefono);
        await sleep(delaySeconds * 1000);
      }
      resultado = await telegram.sendMessage(telefono, text);
    } else {
      if (conTipping) {
        await whatsapp.sendTypingAction(telefono);
        await sleep(delaySeconds * 1000);
      }
      resultado = await whatsapp.sendTextMessage(telefono, text);
    }
    _registrarEnvio(telefono, text, resultado, opts.meta);
    return resultado;
  } catch (err) {
    // Si algo falla en el typing, no abortamos el envío del mensaje
    console.error('⚠️  [Messaging] Error con typing, enviando directo:', err.message);
    const resultado = esTelegram(telefono)
      ? await telegram.sendMessage(telefono, text)
      : await whatsapp.sendTextMessage(telefono, text);
    _registrarEnvio(telefono, text, resultado, opts.meta);
    return resultado;
  }
}

/**
 * Envía el PRIMER contacto (la pregunta de filtrado) a un lead.
 *
 * - Con la API oficial (cloud): va como PLANTILLA aprobada, porque WhatsApp
 *   exige plantilla para iniciar conversación. La variable {{1}} es el nombre.
 *   El `textoFallback` (personalizado por LLM, etc.) NO se usa aquí: en cloud
 *   el primer mensaje es la plantilla fija y aprobada.
 * - Con Baileys: va como texto normal (el `textoFallback`), como hasta ahora.
 *
 * @param {object} lead
 * @param {string} textoFallback  texto a usar en Baileys (o si no hay plantilla)
 * @param {object} [opts] { delaySeconds }
 */
// Deja constancia de que a este lead ya se le envió la bienvenida / primer
// contacto, para que si luego escribe "hola" (en vez de responder 1/2) no se
// le repita el mensaje de bienvenida entero.
function _marcarBienvenida(telefono) {
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (lead) activityLog.appendActivity(lead.id, 'welcome_sent', null);
  } catch (e) { /* nunca romper el envío por esto */ }
}

async function sendPrimerContacto(lead, textoFallback, opts = {}) {
  const telefono = lead.telefono;
  let resultado;

  // Telegram o Baileys → texto normal
  if (esTelegram(telefono) || whatsapp.provider !== 'cloud') {
    resultado = await sendTextMessage(telefono, textoFallback, opts);
  } else {
    // API oficial → plantilla (sin typing/delay: es un envío server-to-server)
    const nombre = lead.nombre && lead.nombre !== 'Sin nombre' ? lead.nombre : 'hola';
    try {
      resultado = await whatsapp.sendTemplate(telefono, [nombre]);
    } catch (err) {
      console.error('⚠️  [Messaging] Error enviando plantilla:', err.message);
      resultado = { success: false, error: err.message };
    }
    _registrarEnvio(telefono, `[plantilla ${config.whatsapp.templateName}] ${textoFallback}`, resultado);
  }
  _marcarBienvenida(telefono);
  return resultado;
}

module.exports = { sendTextMessage, sendPrimerContacto, esTelegram, TG_PREFIX };
