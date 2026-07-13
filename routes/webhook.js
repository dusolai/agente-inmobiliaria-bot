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
    // Por defecto SÍ se envía (comportamiento del formulario real). Para
    // pruebas del equipo se pasa enviarPrimerMensaje:false → se crea el lead
    // en "esperando_cualificacion" pero NO se le escribe (así se prueba el
    // embudo escribiéndole tú al bot, sin depender de la plantilla aprobada).
    const enviar = req.body.enviarPrimerMensaje !== false;

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

    // 3. (Opcional) Enviar el primer contacto con la pregunta de filtrado.
    //    - API oficial: va como PLANTILLA aprobada (obligatorio para iniciar).
    //    - Baileys: texto normal, personalizado por LLM si hay ANTHROPIC_API_KEY.
    //    La respuesta del lead la procesa services/conversationFlow.js.
    let waResult = null;
    if (enviar) {
      const personalizer = require('../services/personalizer');
      const texto = await personalizer.personalizarMensaje(
        messages.mensajeReactivacion({ nombre }),
        lead
      );
      waResult = await messaging.sendPrimerContacto(lead, texto);
      console.log(`🆕 [Webhook] Nuevo lead: ${nombre} (${telefono}) — pregunta de filtrado enviada`);
    } else {
      console.log(`🆕 [Webhook] Lead creado SIN enviar (modo prueba): ${nombre} (${telefono}) — esperando que escriba al bot`);
    }

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
 * POST /webhook/calendly
 * Webhook oficial de Calendly (suscripción `invitee.created`, plan Standard).
 * Es la fuente FIABLE de "reservó": el redirect a /tracking/calendly-booked
 * solo funciona si el lead espera en la página de confirmación; si cierra la
 * pestaña antes, el bot no se enteraba. Con esto, Calendly nos avisa siempre.
 *
 * El lead se identifica por el utm_content=lead_<id> que ya viaja en todos
 * los enlaces que enviamos (payload.tracking.utm_content). Es idempotente
 * con el redirect: el segundo aviso encuentra el estado ya avanzado y no hace
 * nada (la máquina de estados lo bloquea).
 *
 * Cómo suscribirlo (una vez): Calendly → Integrations → Webhooks → añadir
 * https://<backend>/webhook/calendly con el evento "Invitee Created".
 */
router.post('/calendly', async (req, res) => {
  try {
    const { event, payload } = req.body || {};
    if (event !== 'invitee.created') {
      return res.json({ ok: true, ignored: event || 'sin evento' });
    }

    const tracking = (payload && payload.tracking) || {};
    const leadId = conversationFlow.leadIdDesdeUtm(tracking.utm_content);
    if (!leadId) {
      console.log('📅 [CalendlyWebhook] Reserva sin utm_content de lead (tráfico externo), ignorada');
      return res.json({ ok: true, ignored: 'sin lead' });
    }

    const lead = leadManager.getLeadById(leadId);
    if (!lead) return res.json({ ok: true, ignored: 'lead no encontrado' });

    const nombreEvento = (payload.scheduled_event && payload.scheduled_event.name) || null;
    activityLog.appendActivity(lead.id, 'calendly_booked', { via: 'webhook', evento: nombreEvento });

    if (lead.estado === leadManager.LEAD_STATES.VIDEO_ENVIADO) {
      // Reservó el GRUPAL → le llega el acceso a la landing
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.VIDEO_VISTO);
      const enlaceLanding = conversationFlow.enlaceLandingPorPerfil(lead.perfil, lead.id);
      await messaging.sendTextMessage(
        lead.telefono,
        messages.mensajeAccesoVideoTrasReserva({ nombre: lead.nombre, enlaceLanding, perfil: lead.perfil })
      );
      console.log(`📅 [CalendlyWebhook] Reserva GRUPAL de ${lead.nombre} → landing enviada`);
    } else if (lead.estado === leadManager.LEAD_STATES.REUNION_REGISTRADO) {
      // Reservó el 1-A-1 → confirmación
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
      await messaging.sendTextMessage(
        lead.telefono,
        `¡Listo ${lead.nombre}! Tu reunión con Arkaitz está reservada ✅\n\nNos vemos en Zoom a la hora que has elegido. Te llegará un recordatorio antes.`
      );
      console.log(`📅 [CalendlyWebhook] Reserva 1-A-1 de ${lead.nombre} confirmada`);
    } else {
      console.log(`📅 [CalendlyWebhook] Reserva de ${lead.nombre} con estado ${lead.estado} (ya procesada por el redirect, no-op)`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [CalendlyWebhook] Error:', err.message);
    res.status(500).json({ error: 'Error interno' });
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

        // La reunión que se atiende ES el 1-a-1 (la grupal está omitida por
        // fricción). Marcamos asistencia pero NO reenviamos el Calendly del
        // 1-a-1: ya lo tienen y acaban de asistir. Sería un duplicado absurdo.
        const result = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
        if (result.error) {
          return res.status(400).json({ error: result.error });
        }

        console.log(`🤝 [Webhook] Lead asistió al 1-a-1: ${lead.nombre}`);
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
          // Marcamos asistencia al 1-a-1 sin reenviar el Calendly (ya lo tienen).
          leadManager.transitionState(match.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
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
 *   ignorarDuplicados?: true, // si ya existe por teléfono, lo salta
 *   soloCrear?: true,         // crea los leads SIN enviar nada (modo seguro)
 *   activarTodos?: false      // lanza el 1er mensaje a TODOS al instante
 * }
 *
 * Crea los leads como "nuevos" (estado nuevo) y los pone con fuente
 * "excel_import". El scheduler de import (separado) los irá activando
 * leadsPorDia por día. Para el piloto se puede activar manualmente desde el
 * panel o lanzar todos con el flag `activarTodos: true`.
 */
router.post('/bulk-import', async (req, res) => {
  try {
    const { leads, leadsPorDia, ignorarDuplicados, activarTodos, soloCrear } = req.body || {};
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
    // - soloCrear: NO activa ni envía nada (los deja "nuevo" para que el
    //   activador diario los suelte al ritmo configurado). Modo seguro para
    //   importar una lista grande sin disparar WhatsApps de golpe.
    // - activarTodos: lanza TODOS al instante.
    // - por defecto: lanza los `porDia` primeros al instante.
    const personalizer = require('../services/personalizer');
    const aActivar = soloCrear ? [] : (activarTodos ? creados : creados.slice(0, porDia));
    for (const lead of aActivar) {
      try {
        leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
        const texto = await personalizer.personalizarMensaje(
          messages.mensajeReactivacion({ nombre: lead.nombre }),
          lead
        );
        // sin delay para el envío masivo (es la primera toma de contacto)
        await messaging.sendPrimerContacto(lead, texto, { delaySeconds: 0 });
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
