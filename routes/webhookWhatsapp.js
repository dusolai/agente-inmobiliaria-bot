const express = require('express');
const router = express.Router();
const config = require('../config/config');
const conversationFlow = require('../services/conversationFlow');

/**
 * Webhook de la API oficial de WhatsApp (Meta Cloud API).
 *
 * - GET  /webhook/whatsapp  → verificación (Meta lo llama una vez al
 *   configurar el webhook; hay que devolver hub.challenge si el token cuadra).
 * - POST /webhook/whatsapp  → mensajes entrantes de los leads. Se extrae el
 *   número y el texto (o el botón pulsado) y se pasa al flujo de siempre
 *   (conversationFlow.handleIncoming), igual que hacía Baileys.
 *
 * En Meta → WhatsApp → Configuration → Webhook, pon:
 *   Callback URL:  https://<backend>/webhook/whatsapp
 *   Verify token:  el mismo valor que WHATSAPP_VERIFY_TOKEN
 *   Y suscríbete al campo "messages".
 */

// ─── Verificación (handshake inicial) ─────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === config.whatsapp.verifyToken) {
    console.log('✅ [WhatsAppCloud] Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️  [WhatsAppCloud] Verificación de webhook fallida (token no coincide)');
  return res.sendStatus(403);
});

// ─── Extrae el texto útil de un mensaje entrante ──────────────────
function _textoDelMensaje(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body || '';
    case 'button':
      // Botón de plantilla (quick reply): usamos su texto/payload
      return msg.button?.text || msg.button?.payload || '';
    case 'interactive':
      return (
        msg.interactive?.button_reply?.title ||
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.list_reply?.id ||
        ''
      );
    default:
      return '';
  }
}

// ─── Mensajes entrantes ───────────────────────────────────────────
router.post('/', async (req, res) => {
  // Responder 200 cuanto antes: Meta reintenta si tarda, y no queremos
  // procesar dos veces el mismo mensaje.
  res.sendStatus(200);

  try {
    const entradas = req.body?.entry || [];
    for (const entry of entradas) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const mensajes = value.messages || [];
        // value.statuses = acuses de entrega/lectura → se ignoran
        for (const msg of mensajes) {
          const telefono = String(msg.from || '').replace(/[^\d]/g, '');
          const texto = _textoDelMensaje(msg);
          if (!telefono || !texto) continue;

          console.log(`📥 [WhatsAppCloud] Mensaje de ${telefono}: "${texto.slice(0, 60)}"`);
          try {
            await conversationFlow.handleIncoming(telefono, texto);
          } catch (err) {
            console.error('❌ [WhatsAppCloud] Error procesando mensaje entrante:', err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ [WhatsAppCloud] Error en el webhook:', err.message);
  }
});

module.exports = router;
