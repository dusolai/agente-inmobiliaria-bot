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

    // El clic en "agendar" aparece al terminar el webinar. Lo aceptamos tanto si
    // el lead ya figura como VIDEO_VISTO como si todavía estaba en VIDEO_ENVIADO
    // (por si no llegó el evento de progreso del VSL): en ambos casos ha visto lo
    // suficiente para pasar a la 1-a-1. Si venía de "enviado", lo marcamos visto
    // primero (la máquina de estados no salta enviado → registrado directo).
    const S = leadManager.LEAD_STATES;
    if (lead.estado === S.VIDEO_ENVIADO || lead.estado === S.VIDEO_VISTO) {
      if (lead.estado === S.VIDEO_ENVIADO) {
        leadManager.transitionState(lead.id, S.VIDEO_VISTO);
        leadManager.updateLead(lead.id, { videoVistoAt: new Date().toISOString() });
      }
      const result = leadManager.transitionState(lead.id, S.REUNION_REGISTRADO);
      if (result.error) return res.status(400).json({ error: result.error });
      activityLog.appendActivity(lead.id, 'cta_1a1_click', null, req.ip);
      console.log(`🎥→📞 [Tracking] CTA pulsado, 1-a-1 enviado: ${lead.nombre}`);

      const enlace1a1 = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
      await messaging.sendTextMessage(
        lead.telefono,
        messages.mensajeAcceso1a1({ nombre: lead.nombre, enlace1a1 })
      );
    } else {
      return res.json({ success: true, message: `Lead ya está en estado: ${lead.estado}`, lead });
    }

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

    // Dos caminos según el estado actual:
    //  a) Lead en VIDEO_ENVIADO  → reservó la SESIÓN GRUPAL (vídeo grabado)
    //      → transicionamos a VIDEO_VISTO y le mandamos el acceso a la landing
    //  b) Lead en REUNION_REGISTRADO → reservó la 1-a-1 con Arkaitz (Zoom)
    //      → transicionamos a REUNION_ASISTIO y mandamos confirmación
    try {
      if (lead.estado === leadManager.LEAD_STATES.VIDEO_ENVIADO) {
        leadManager.transitionState(lead.id, leadManager.LEAD_STATES.VIDEO_VISTO);
        console.log(`📅 [Tracking] Reserva GRUPAL confirmada: ${lead.nombre}`);
        const enlaceLanding = conversationFlow.enlaceLandingPorPerfil(lead.perfil, lead.id);
        await messaging.sendTextMessage(
          lead.telefono,
          messages.mensajeAccesoVideoTrasReserva({
            nombre: lead.nombre,
            enlaceLanding,
          })
        );
      } else if (lead.estado === leadManager.LEAD_STATES.REUNION_REGISTRADO) {
        leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
        console.log(`📅 [Tracking] Reserva 1-A-1 confirmada: ${lead.nombre}`);
        await messaging.sendTextMessage(
          lead.telefono,
          `¡Listo ${lead.nombre}! Tu reunión con Arkaitz está reservada ✅\n\nNos vemos en Zoom a la hora que has elegido. Te llegará un recordatorio antes.`
        );
      } else {
        console.log(`📅 [Tracking] Reserva recibida pero el estado es ${lead.estado} (lead ${lead.nombre})`);
      }
    } catch (e) {
      console.error('No se pudo procesar la reserva:', e.message);
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

    // Promoción de estado: si el lead solo tenía el vídeo ENVIADO y la landing
    // reporta que YA lo ha visto de verdad (VSL al 90%/completo, o desbloqueó el
    // webinar → implica que terminó el VSL), lo pasamos a "video_visto". Así el
    // badge del CRM refleja que lo ha visto, no que se lo enviamos.
    try {
      const señalDeVisto =
        type === 'webinar_unlocked' ||
        type === 'video_complete' ||
        type === 'video_progress_90';
      if (señalDeVisto && lead.estado === leadManager.LEAD_STATES.VIDEO_ENVIADO) {
        const r = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.VIDEO_VISTO);
        if (!r.error) {
          leadManager.updateLead(lead.id, { videoVistoAt: new Date().toISOString() });
          console.log(`🎬 [Tracking] ${lead.nombre} vio el VSL (${type}) → video_visto`);
        }
      }
    } catch (e) {}

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [Tracking] Error /event:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
