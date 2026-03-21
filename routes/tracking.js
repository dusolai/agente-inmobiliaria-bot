const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const whatsapp = require('../services/whatsapp');
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

    // 2. Enviar mensaje de respaldo con enlace a reunión grupal (opcional)
    const texto = messages.mensajeVideoVisto({
      nombre: lead.nombre,
      enlaceReunion: config.landing.reunionGrupalUrl,
    });
    await whatsapp.sendTextMessage(lead.telefono, texto);

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

module.exports = router;
