const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const whatsapp = require('../services/whatsapp');
const messages = require('../templates/messages');

/**
 * POST /webhook/new-lead
 * Recibe datos de un nuevo lead (formulario, Google Sheets, Zapier, etc.)
 * Body: { nombre, email, telefono, fuente? }
 */
router.post('/new-lead', async (req, res) => {
  try {
    const { nombre, email, telefono, fuente } = req.body;

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Campos requeridos: nombre, telefono',
      });
    }

    // Verificar si ya existe un lead con este teléfono
    const existente = leadManager.getLeadByPhone(telefono);
    if (existente) {
      return res.status(409).json({
        error: 'Ya existe un lead con este teléfono',
        lead: existente,
      });
    }

    // 1. Crear lead
    const lead = leadManager.createLead({ nombre, email, telefono, fuente });

    // 2. Transicionar a "video_enviado"
    leadManager.transitionState(lead.id, leadManager.LEAD_STATES.VIDEO_ENVIADO);

    // 3. Enviar mensaje de bienvenida por WhatsApp
    const enlaceVideo = `${config.landing.landingUrl}?lead=${lead.id}`;
    const texto = messages.mensajeBienvenida({ nombre, enlaceVideo });
    const waResult = await whatsapp.sendTextMessage(telefono, texto);

    console.log(`🆕 [Webhook] Nuevo lead: ${nombre} (${telefono})`);

    res.status(201).json({
      success: true,
      lead: leadManager.getLeadById(lead.id),
      whatsapp: waResult,
    });
  } catch (err) {
    console.error('❌ [Webhook] Error new-lead:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * POST /webhook/zoom-attendance
 * Recibe datos de asistencia a una reunión grupal de Zoom.
 * Body: { meetingId, participants: [{ email, nombre }] }
 * O bien se puede llamar para un lead específico:
 * Body: { leadId, attended: true/false }
 */
router.post('/zoom-attendance', async (req, res) => {
  try {
    const { leadId, attended, meetingId, participants } = req.body;

    // Modo simple: marcar un lead como asistente o no
    if (leadId) {
      const lead = leadManager.getLeadById(leadId);
      if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

      if (attended) {
        // Transitionar a "reunion_asistio" y enviar enlace 1a1
        const result = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
        if (result.error) {
          return res.status(400).json({ error: result.error });
        }

        const texto = messages.mensajeCierre({
          nombre: lead.nombre,
          enlaceCalendly: config.landing.calendlyUrl,
        });
        await whatsapp.sendTextMessage(lead.telefono, texto);

        console.log(`🤝 [Webhook] Lead asistió a reunión: ${lead.nombre}`);
      }

      return res.json({ success: true, lead: leadManager.getLeadById(lead.id) });
    }

    // Modo batch: procesar lista de participantes
    if (participants && Array.isArray(participants)) {
      const resultados = [];
      const allLeads = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.REUNION_REGISTRADO });

      for (const participant of participants) {
        const match = allLeads.find(
          (l) => l.email && l.email.toLowerCase() === participant.email?.toLowerCase()
        );

        if (match) {
          leadManager.transitionState(match.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
          const texto = messages.mensajeCierre({
            nombre: match.nombre,
            enlaceCalendly: config.landing.calendlyUrl,
          });
          await whatsapp.sendTextMessage(match.telefono, texto);
          resultados.push({ lead: match.nombre, status: 'asistio' });
        }
      }

      return res.json({ success: true, procesados: resultados });
    }

    res.status(400).json({ error: 'Se requiere leadId o participants' });
  } catch (err) {
    console.error('❌ [Webhook] Error zoom-attendance:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
