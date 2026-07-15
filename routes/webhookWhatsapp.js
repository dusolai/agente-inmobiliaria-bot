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

        // ─── Acuses de entrega (statuses) ────────────────────────────
        // Meta acepta el POST (200 + id) pero la ENTREGA real viene aquí:
        // sent → delivered → read, o failed (con el motivo). Antes se ignoraba
        // y el CRM decía "enviado" aunque no llegara. Ahora registramos
        // entregado y, sobre todo, FALLÓ con su código, para ver la verdad.
        const estados = value.statuses || [];
        for (const st of estados) {
          try {
            const tel = String(st.recipient_id || '').replace(/[^\d]/g, '');
            const estado = st.status; // sent | delivered | read | failed
            if (!tel || !estado) continue;
            // 'sent' se omite (es lo mismo que "aceptado", ya registrado).
            // delivered / read / failed sí: son la verdad de la entrega.
            if (estado !== 'delivered' && estado !== 'read' && estado !== 'failed') continue;
            const leadManager = require('../services/leadManager');
            const activityLog = require('../services/activityLog');
            const lead = leadManager.getLeadByPhone(tel);
            if (!lead) continue;
            const err = (st.errors && st.errors[0]) || null;
            activityLog.appendActivity(lead.id, 'message_status', {
              status: estado,
              ...(err ? { code: err.code, error: err.title || err.message } : {}),
            });
            if (estado === 'failed') {
              console.warn(`❌ [WhatsAppCloud] ENTREGA FALLIDA a ${tel}: ${err ? err.code + ' ' + (err.title || err.message) : 'sin detalle'}`);

              // Fallo PERMANENTE (el número no tiene WhatsApp / no existe):
              // insistir es contraproducente — gasta cupo de los 250/24h y,
              // sobre todo, Meta penaliza los NO entregados y hunde la calidad
              // del número. Y nunca va a convertir. Se descarta al primer fallo.
              // OJO: 131047 (fuera de ventana 24h) y 131049 (calidad) NO entran
              // aquí: son temporales, el lead sigue siendo válido.
              const PERMANENTES = [131026, 133010];
              const S = leadManager.LEAD_STATES;
              if (err && PERMANENTES.includes(Number(err.code)) && lead.estado !== S.DESCARTADO) {
                const r = leadManager.transitionState(lead.id, S.DESCARTADO);
                if (r.error) {
                  leadManager.updateLead(lead.id, { estado: S.DESCARTADO, descartadoAt: new Date().toISOString() });
                }
                activityLog.appendActivity(lead.id, 'sin_whatsapp', {
                  code: err.code,
                  error: err.title || err.message,
                });
                console.warn(`🚫 [WhatsAppCloud] ${lead.nombre} descartado: su número no tiene WhatsApp (${err.code})`);
              }
            }
          } catch (e) { /* nunca romper el webhook por un status */ }
        }

        for (const msg of mensajes) {
          const telefono = String(msg.from || '').replace(/[^\d]/g, '');
          const texto = _textoDelMensaje(msg);
          if (!telefono || !texto) continue;

          console.log(`📥 [WhatsAppCloud] Mensaje de ${telefono}: "${texto.slice(0, 60)}"`);
          // Mostrar "escribiendo…" al momento (marca leído + typing), para que
          // el lead vea que el agente está respondiendo mientras el LLM piensa.
          try {
            const whatsappCloud = require('../services/whatsappCloud');
            whatsappCloud.sendTyping(msg.id).catch(() => {});
          } catch (e) { /* opcional */ }
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
