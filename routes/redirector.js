const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const conversationFlow = require('../services/conversationFlow');
const activityLog = require('../services/activityLog');

/**
 * Redirectores cortos que el bot envía al lead en WhatsApp/Telegram.
 *
 *   GET /r/grupal?l=<leadId>      → log "calendly_intent grupal" + 302 → Calendly grupal
 *   GET /r/individual?l=<leadId>  → log "calendly_intent individual" + 302 → Calendly individual
 *
 * Beneficios sin pagar nada:
 *   • Sabemos *cuándo* hizo clic cada lead (timestamp en activity.json).
 *   • La URL final de Calendly lleva utm_content=lead_<id> + name + email
 *     prerellenado, para identificar la reserva en el panel de Calendly.
 */
/**
 * ¿Quien abre el enlace es un ROBOT, no el lead?
 *
 * Los mensajes van con vista previa (preview_url), así que al enviar un enlace
 * WhatsApp lo visita AL INSTANTE para generar la miniatura. Eso caía aquí y se
 * registraba como "el lead pulsó el enlace" 1-3 segundos después del envío:
 * clics fantasma que inflaban el embudo (los 5 primeros calendly_intent eran
 * TODOS del robot, ninguno real). Seguimos redirigiendo —la vista previa debe
 * funcionar— pero no lo contamos como clic.
 */
function _esBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true; // sin user-agent = no es un navegador humano
  return /whatsapp|facebookexternalhit|facebookcatalog|meta-external|bot\b|crawler|spider|preview|curl|wget|python-requests|axios|headless|slackbot|telegrambot|twitterbot|discordbot|linkedinbot|embedly|quora link preview|skypeuripreview/.test(ua);
}

function _redirectorCalendly(req, res, tipo) {
  try {
    const leadId = req.query.l || req.query.lead || req.query.leadId;
    const baseUrl = tipo === 'grupal'
      ? config.landing.calendlyGrupalUrl
      : config.landing.calendlyIndividualUrl;

    if (!baseUrl || baseUrl === '#') {
      return res
        .status(503)
        .send('Calendar no configurado. Configura CALENDLY_GRUPAL_URL / CALENDLY_INDIVIDUAL_URL.');
    }

    let destino = baseUrl;
    if (leadId) {
      const lead = leadManager.getLeadById(leadId);
      if (lead) {
        if (_esBot(req)) {
          console.log(`🤖 [Redirector] Vista previa de robot en /r/${tipo} (${lead.nombre}) — NO cuenta como clic`);
        } else {
          activityLog.appendActivity(lead.id, 'calendly_intent', { tipo }, req.ip);
        }
        destino = conversationFlow.enlaceCalendlyConTracking(baseUrl, lead);
      }
    }
    res.redirect(302, destino);
  } catch (err) {
    console.error(`❌ [Redirector] Error en /r/${tipo}:`, err.message);
    res.status(500).send('Error interno');
  }
}

router.get('/grupal', (req, res) => _redirectorCalendly(req, res, 'grupal'));
router.get('/individual', (req, res) => _redirectorCalendly(req, res, 'individual'));

/**
 * GET /r/presentacion?l=<leadId>
 * Redirector al vídeo de presentación de negocio de 25 min.
 * Registra el clic y redirige a la URL real (config.landing.presentacionVideoUrl).
 */
router.get('/presentacion', (req, res) => {
  try {
    const leadId = req.query.l || req.query.lead;
    const baseUrl = config.landing.presentacionVideoUrl;

    if (!baseUrl || baseUrl === '#') {
      return res.status(503).send('Vídeo de presentación no configurado.');
    }
    if (leadId) {
      const lead = leadManager.getLeadById(leadId);
      if (lead && !_esBot(req)) {
        activityLog.appendActivity(lead.id, 'presentacion_intent', null, req.ip);
      }
    }
    res.redirect(302, baseUrl);
  } catch (err) {
    console.error('❌ [Redirector] Error en /r/presentacion:', err.message);
    res.status(500).send('Error interno');
  }
});

module.exports = router;
