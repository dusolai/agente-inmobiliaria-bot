const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const messaging = require('../services/messaging');
const conversationFlow = require('../services/conversationFlow');
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

    // 2. Transicionar a "esperando_cualificacion" (reunión 29-05)
    leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);

    // 3. Enviar mensaje de reactivación con la pregunta de filtrado.
    //    La respuesta del lead la procesa services/conversationFlow.js y, según
    //    su perfil, recibe la landing profesional o emprendedor con el vídeo.
    const texto = messages.mensajeReactivacion({ nombre });
    const waResult = await messaging.sendTextMessage(telefono, texto);

    console.log(`🆕 [Webhook] Nuevo lead: ${nombre} (${telefono}) — pregunta de filtrado enviada`);

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

        const enlaceCalendly = conversationFlow.enlaceRedirectorCalendly(
          leadManager.getLeadById(lead.id),
          'individual'
        );
        const texto = messages.mensajeCierre({
          nombre: lead.nombre,
          enlaceCalendly,
        });
        await messaging.sendTextMessage(lead.telefono, texto);

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
          const enlaceCalendly = conversationFlow.enlaceRedirectorCalendly(
            leadManager.getLeadById(match.id),
            'individual'
          );
          const texto = messages.mensajeCierre({
            nombre: match.nombre,
            enlaceCalendly,
          });
          await messaging.sendTextMessage(match.telefono, texto);
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
