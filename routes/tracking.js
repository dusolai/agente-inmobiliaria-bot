const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const messaging = require('../services/messaging');
const conversationFlow = require('../services/conversationFlow');
const activityLog = require('../services/activityLog');
const messages = require('../templates/messages');

/**
 * POST /tracking/video-click
 * Llamado por la landing page cuando el usuario hace clic en el botón retardado.
 * Body: { leadId }
 * 
 * Acciones:
 * 1. Marca al lead como "video_visto"
 * 2. Cancela los recordatorios de Fase 2 (al cambiar de estado, el scheduler los ignora)
 * 3. Envía mensaje de respaldo con enlace a reunión grupal
 */
router.post('/video-click', async (req, res) => {
  try {
    const { leadId } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'Se requiere leadId' });
    }

    const lead = leadManager.getLeadById(leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    // Solo transicionar si está en el estado correcto
    if (lead.estado !== leadManager.LEAD_STATES.VIDEO_ENVIADO) {
      return res.json({
        success: true,
        message: `Lead ya está en estado: ${lead.estado}`,
        lead,
      });
    }

    // 1. Transicionar a "video_visto"
    const result = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.VIDEO_VISTO);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    console.log(`🎥 [Tracking] Video visto por: ${lead.nombre}`);
    activityLog.appendActivity(lead.id, 'calendly_click', null, req.ip);

    // 2. Enviar mensaje de respaldo con enlace a reunión grupal (opcional)
    // URL del redirector propio: registra el clic y lleva al Calendly grupal
    // con UTMs + prefill. Así medimos la actividad sin depender de webhooks.
    const enlaceReunion = conversationFlow.enlaceRedirectorCalendly(
      leadManager.getLeadById(lead.id),
      'grupal'
    );
    const texto = messages.mensajeVideoVisto({
      nombre: lead.nombre,
      enlaceReunion,
    });
    await messaging.sendTextMessage(lead.telefono, texto);

    res.json({
      success: true,
      message: '✅ Video marcado como visto. Recordatorios Fase 2 cancelados.',
      lead: leadManager.getLeadById(lead.id),
    });
  } catch (err) {
    console.error('❌ [Tracking] Error video-click:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * POST /tracking/reunion-registro
 * Llamado cuando un lead se registra para la reunión grupal.
 * Body: { leadId }
 */
router.post('/reunion-registro', async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Se requiere leadId' });

    const lead = leadManager.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    if (lead.estado !== leadManager.LEAD_STATES.VIDEO_VISTO) {
      return res.json({ success: true, message: `Lead en estado: ${lead.estado}`, lead });
    }

    const result = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_REGISTRADO);
    if (result.error) return res.status(400).json({ error: result.error });

    console.log(`📅 [Tracking] Reunión registrada: ${lead.nombre}`);

    res.json({
      success: true,
      message: '✅ Lead registrado para reunión grupal.',
      lead: leadManager.getLeadById(lead.id),
    });
  } catch (err) {
    console.error('❌ [Tracking] Error reunion-registro:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * GET /tracking/calendly-booked
 * Página de confirmación a la que Calendly redirige cuando se completa una
 * reserva. Acepta `leadId` directo o `utm_content=lead_<id>` (que es lo que
 * envía Calendly si se configura el "Redirect to external site" con la
 * variable {{utm_content}}).
 *
 * Acciones:
 *  1. Localiza al lead.
 *  2. Si está en estado video_visto → transiciona a reunion_registrado.
 *  3. Envía un mensaje de confirmación por WhatsApp/Telegram.
 *  4. Devuelve una página HTML de "¡Reserva confirmada!".
 */
router.get('/calendly-booked', async (req, res) => {
  try {
    const leadId =
      req.query.leadId ||
      conversationFlow.leadIdDesdeUtm(req.query.utm_content);

    if (!leadId) {
      return res.status(400).send('Falta leadId o utm_content');
    }

    const lead = leadManager.getLeadById(leadId);
    if (!lead) {
      return res.status(404).send('Lead no encontrado');
    }

    // Solo transicionar si tiene sentido (evita carreras y dobles clics)
    if (lead.estado === leadManager.LEAD_STATES.VIDEO_VISTO) {
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_REGISTRADO);
      console.log(`📅 [Tracking] Reserva confirmada vía Calendly: ${lead.nombre}`);

      // Avisar al lead por WhatsApp/Telegram (opcional, agradable de tener)
      try {
        await messaging.sendTextMessage(
          lead.telefono,
          `¡Perfecto ${lead.nombre}! Tu reserva está confirmada. Te enviaremos un recordatorio antes de la reunión.`
        );
      } catch (e) {
        console.error('No se pudo enviar la confirmación al lead:', e.message);
      }
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Reserva confirmada</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#faf8fc;color:#311B92;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:1rem}
.card{background:#fff;padding:3rem;border-radius:20px;box-shadow:0 20px 60px rgba(49,27,146,.1);max-width:480px}
h1{margin:0 0 1rem;font-size:1.8rem}
p{color:#5d6d7e;line-height:1.6}</style>
</head><body><div class="card">
<div style="font-size:3rem">✅</div>
<h1>¡Reserva confirmada!</h1>
<p>Te hemos enviado los detalles por mensaje. Nos vemos en la reunión.</p>
</div></body></html>`);
  } catch (err) {
    console.error('❌ [Tracking] Error calendly-booked:', err.message);
    res.status(500).send('Error interno');
  }
});

/**
 * POST /tracking/event
 * Endpoint genérico para que la landing (vsl.js) reporte eventos del usuario:
 * play del vídeo, hitos de progreso, ended, etc.
 * Body: { leadId, type, meta? }
 */
router.post('/event', (req, res) => {
  try {
    const { leadId, type, meta } = req.body || {};
    if (!leadId || !type) {
      return res.status(400).json({ error: 'leadId y type son obligatorios' });
    }
    // Verificamos que el lead existe (silenciamos errores: es tracking)
    const lead = leadManager.getLeadById(leadId);
    if (!lead) return res.json({ ok: true, ignored: 'lead_not_found' });
    activityLog.appendActivity(leadId, type, meta || null, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [Tracking] Error /event:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
