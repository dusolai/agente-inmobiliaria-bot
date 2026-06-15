const express = require('express');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const messaging = require('../services/messaging');
const conversationFlow = require('../services/conversationFlow');
const activityLog = require('../services/activityLog');
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
        // Registramos el momento exacto en el que detectamos su entrada
        // a la reunión. En producción (con Zoom API) esto vendrá del polling
        // de participantes de Zoom; en piloto lo dispara el panel /admin.
        const duracionMinutos = req.body.duration || null;
        activityLog.appendActivity(lead.id, 'meeting_joined', { duracionMinutos });

        // Transicionamos a "reunion_asistio" y enviamos el cierre 1-a-1
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

/**
 * POST /webhook/bulk-import
 * Sube en lote leads desde el Excel consolidado (595 contactos).
 *
 * Body: {
 *   leads: [ { nombre, telefono, email? }, ... ],
 *   leadsPorDia?: 10,        // throttle: cuántos arrancar al día (default 10)
 *   ignorarDuplicados?: true // si ya existe por teléfono, lo salta
 * }
 *
 * Crea los leads como "nuevos" (estado nuevo) y los pone con fuente
 * "excel_import". El scheduler de import (separado) los irá activando
 * leadsPorDia por día. Para el piloto se puede activar manualmente desde el
 * panel o lanzar todos con el flag `activarTodos: true`.
 */
router.post('/bulk-import', async (req, res) => {
  try {
    const { leads, leadsPorDia, ignorarDuplicados, activarTodos } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads debe ser un array no vacío' });
    }

    const ignorar = ignorarDuplicados !== false; // default true
    const porDia = parseInt(leadsPorDia) || 10;

    const resultado = { creados: 0, duplicados: 0, errores: 0, activados: 0, total: leads.length };
    const creados = [];

    for (const fila of leads) {
      try {
        if (!fila.telefono || !fila.nombre) { resultado.errores++; continue; }
        const tel = String(fila.telefono).replace(/\s+/g, '');
        if (ignorar && leadManager.getLeadByPhone(tel)) { resultado.duplicados++; continue; }
        const lead = leadManager.createLead({
          nombre: fila.nombre,
          email: fila.email || '',
          telefono: tel,
          fuente: 'excel_import',
        });
        resultado.creados++;
        creados.push(lead);
      } catch (err) {
        console.error(`❌ [BulkImport] Error en fila:`, err.message);
        resultado.errores++;
      }
    }

    // Activación: pasa de nuevo → esperando_cualificacion y envía el mensaje.
    // Si activarTodos, lanzamos los X primeros (porDia) al instante.
    const aActivar = activarTodos ? creados : creados.slice(0, porDia);
    for (const lead of aActivar) {
      try {
        leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
        const texto = messages.mensajeReactivacion({ nombre: lead.nombre });
        // sin delay para el envío masivo (es la primera toma de contacto)
        await messaging.sendTextMessage(lead.telefono, texto, { delaySeconds: 0 });
        resultado.activados++;
      } catch (err) {
        console.error(`❌ [BulkImport] No pude activar ${lead.id}:`, err.message);
      }
    }

    console.log(`📥 [BulkImport] ${resultado.creados} creados, ${resultado.duplicados} duplicados, ${resultado.activados} activados`);
    res.json({ success: true, resultado });
  } catch (err) {
    console.error('❌ [Webhook] Error bulk-import:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
