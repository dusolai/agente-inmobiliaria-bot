const axios = require('axios');
const config = require('../config/config');

/**
 * Adaptador de Telegram para el modo PILOTO.
 *
 * - Envía mensajes vía Bot API (sendMessage).
 * - Recibe mensajes con long polling (getUpdates) — sin webhook ni HTTPS público.
 * - Cada chat de Telegram se identifica internamente como `tg:<chat_id>` y se
 *   almacena en el campo `telefono` del lead, de forma que el resto del flujo
 *   (cualificación, ramas, recordatorios) funciona igual sin cambios.
 * - Al recibir el comando /start, se crea (o reactiva) el lead y se le envía
 *   la pregunta de filtrado.
 */

const TG_PREFIX = 'tg:';
const POLL_TIMEOUT = 30; // segundos de long polling

let isConfigured = false;
let isRunning = false;
let lastUpdateId = 0;

function apiUrl(method) {
  return `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
}

function isReady() {
  return isConfigured;
}

/**
 * Envía un mensaje de texto a un chat. Acepta el identificador con o sin prefijo.
 */
async function sendMessage(chatIdOrTg, text) {
  if (!isConfigured) {
    console.log(`📨 [Telegram DEV] → ${chatIdOrTg} (token no configurado)`);
    console.log(text);
    return { success: true, mode: 'development' };
  }

  const chatId = String(chatIdOrTg).startsWith(TG_PREFIX)
    ? String(chatIdOrTg).slice(TG_PREFIX.length)
    : String(chatIdOrTg);

  try {
    await axios.post(apiUrl('sendMessage'), {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });
    console.log(`✅ [Telegram] Mensaje enviado a ${chatId}`);
    return { success: true, mode: 'production' };
  } catch (err) {
    console.error(`❌ [Telegram] Error enviando a ${chatId}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Procesa un único update de Telegram (mensaje).
 */
async function procesarUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const telefono = `${TG_PREFIX}${chatId}`;
  const texto = msg.text.trim();
  const nombre = msg.from?.first_name || msg.chat?.first_name || 'piloto';

  const leadManager = require('./leadManager');
  const messages = require('../templates/messages');
  const conversationFlow = require('./conversationFlow');

  // /start → registrar/reactivar el lead y enviar la pregunta de filtrado
  if (texto.toLowerCase().startsWith('/start')) {
    let lead = leadManager.getLeadByPhone(telefono);
    if (!lead) {
      lead = leadManager.createLead({ nombre, telefono, fuente: 'telegram-pilot' });
    } else {
      // Re-arrancar: volver a estado inicial para repetir la prueba
      leadManager.updateLead(lead.id, { nombre });
    }
    if (lead.estado !== leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION) {
      // Reset suave para piloto: forzar el estado de espera
      lead.estado = leadManager.LEAD_STATES.NUEVO;
      leadManager.updateLead(lead.id, { estado: leadManager.LEAD_STATES.NUEVO });
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
    } else {
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
    }
    await sendMessage(telefono, messages.mensajeReactivacion({ nombre }));
    console.log(`🆕 [Telegram] Piloto iniciado: ${nombre} (${telefono})`);
    return;
  }

  // Cualquier otro mensaje → ruta al flujo de cualificación
  await conversationFlow.handleIncoming(telefono, texto);
}

/**
 * Bucle de long polling.
 */
async function pollLoop() {
  while (isRunning) {
    try {
      const res = await axios.get(apiUrl('getUpdates'), {
        params: {
          offset: lastUpdateId + 1,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message'],
        },
        timeout: (POLL_TIMEOUT + 5) * 1000,
      });

      const updates = res.data?.result || [];
      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        try {
          await procesarUpdate(update);
        } catch (err) {
          console.error('❌ [Telegram] Error procesando update:', err.message);
        }
      }
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('❌ [Telegram] Error en long polling:', detail);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function initialize() {
  if (!config.telegram.botToken) {
    console.log('⚠️  [Telegram] TELEGRAM_BOT_TOKEN vacío — adaptador no se inicia.');
    return;
  }
  if (isRunning) return;
  isConfigured = true;
  isRunning = true;
  console.log('🤖 [Telegram] Adaptador piloto iniciado (long polling).');
  pollLoop();
}

module.exports = { initialize, sendMessage, isReady, TG_PREFIX };
