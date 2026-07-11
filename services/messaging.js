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
function _registrarEnvio(telefono, text, resultado) {
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (!lead) return;
    activityLog.appendActivity(lead.id, 'message_sent', {
      preview: String(text).slice(0, 120),
      ok: resultado ? resultado.success !== false : null,
      modo: resultado && resultado.mode ? resultado.mode : undefined,
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
    _registrarEnvio(telefono, text, resultado);
    return resultado;
  } catch (err) {
    // Si algo falla en el typing, no abortamos el envío del mensaje
    console.error('⚠️  [Messaging] Error con typing, enviando directo:', err.message);
    const resultado = esTelegram(telefono)
      ? await telegram.sendMessage(telefono, text)
      : await whatsapp.sendTextMessage(telefono, text);
    _registrarEnvio(telefono, text, resultado);
    return resultado;
  }
}

module.exports = { sendTextMessage, esTelegram, TG_PREFIX };
