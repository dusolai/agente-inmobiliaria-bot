/**
 * Dispatcher de mensajería.
 *
 * Decide a qué adaptador enviar (WhatsApp o Telegram) en función del
 * identificador del lead:
 *   - "tg:<chat_id>"  → Telegram
 *   - cualquier otro  → WhatsApp (número de teléfono)
 *
 * Así el resto del sistema (conversationFlow, scheduler, webhook, tracking)
 * no necesita saber por qué canal entra el lead.
 */

const whatsapp = require('./whatsapp');
const telegram = require('./telegram');

const TG_PREFIX = telegram.TG_PREFIX || 'tg:';

function esTelegram(telefono) {
  return typeof telefono === 'string' && telefono.startsWith(TG_PREFIX);
}

async function sendTextMessage(telefono, text) {
  if (esTelegram(telefono)) {
    return telegram.sendMessage(telefono, text);
  }
  return whatsapp.sendTextMessage(telefono, text);
}

module.exports = { sendTextMessage, esTelegram, TG_PREFIX };
