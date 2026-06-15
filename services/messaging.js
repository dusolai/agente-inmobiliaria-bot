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
    if (esTelegram(telefono)) {
      if (conTipping) {
        await telegram.sendTypingAction(telefono);
        await sleep(delaySeconds * 1000);
      }
      return telegram.sendMessage(telefono, text);
    }
    if (conTipping) {
      await whatsapp.sendTypingAction(telefono);
      await sleep(delaySeconds * 1000);
    }
    return whatsapp.sendTextMessage(telefono, text);
  } catch (err) {
    // Si algo falla en el typing, no abortamos el envío del mensaje
    console.error('⚠️  [Messaging] Error con typing, enviando directo:', err.message);
    if (esTelegram(telefono)) return telegram.sendMessage(telefono, text);
    return whatsapp.sendTextMessage(telefono, text);
  }
}

module.exports = { sendTextMessage, esTelegram, TG_PREFIX };
