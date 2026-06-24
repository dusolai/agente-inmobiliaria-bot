const express = require('express');
const router = express.Router();
const leadManager = require('../services/leadManager');
const activityLog = require('../services/activityLog');

/**
 * GET /api/leads
 * Lista todos los leads. Query params opcionales: ?estado=video_enviado&fuente=formulario
 */
router.get('/leads', (req, res) => {
  const { estado, fuente } = req.query;
  const leads = leadManager.getAllLeads({ estado, fuente });
  // Enriquecer cada lead con videoProgressMax (% máximo del vídeo principal)
  // para mostrar mini barra en el panel sin tener que pedir actividad lead a lead.
  const enriched = leads.map((l) => {
    const events = activityLog.getActivityByLead(l.id) || [];
    let pct = 0;
    for (const ev of events) {
      const isMain = !ev.meta || !ev.meta.videoId || ev.meta.videoId === 'video1';
      if (!isMain) continue;
      if (ev.type === 'video_complete') pct = Math.max(pct, 100);
      else if (ev.type === 'video_progress_75') pct = Math.max(pct, 75);
      else if (ev.type === 'video_progress_50') pct = Math.max(pct, 50);
      else if (ev.type === 'video_progress_25') pct = Math.max(pct, 25);
      else if (ev.type === 'video_play') pct = Math.max(pct, 5);
    }
    return Object.assign({}, l, { videoProgressMax: pct });
  });
  res.json({ total: enriched.length, leads: enriched });
});

/**
 * GET /api/leads/:id
 * Obtiene un lead por ID.
 */
router.get('/leads/:id', (req, res) => {
  const lead = leadManager.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json(lead);
});

/**
 * PUT /api/leads/:id
 * Actualiza datos de un lead (nombre, email, notas, etc.)
 */
router.put('/leads/:id', (req, res) => {
  const updated = leadManager.updateLead(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json(updated);
});

/**
 * PUT /api/leads/:id/state
 * Cambia el estado de un lead.
 * Body: { estado: "video_visto" }
 */
router.put('/leads/:id/state', (req, res) => {
  const { estado } = req.body;
  if (!estado) return res.status(400).json({ error: 'Se requiere campo "estado"' });

  const result = leadManager.transitionState(req.params.id, estado);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.lead);
});

/**
 * DELETE /api/leads/:id
 * Elimina un lead. Si se pasa ?wipeActivity=1 también borra todos sus
 * eventos del activity log (útil para empezar de cero en pruebas).
 */
router.delete('/leads/:id', (req, res) => {
  const deleted = leadManager.deleteLead(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Lead no encontrado' });
  let eventosEliminados = 0;
  if (req.query.wipeActivity === '1') {
    eventosEliminados = activityLog.deleteActivityByLead(req.params.id);
  }
  res.json({ success: true, eventosEliminados });
});

/**
 * GET /api/stats
 * KPIs del embudo.
 */
router.get('/stats', (req, res) => {
  res.json(leadManager.getStats());
});

/**
 * GET /api/config
 * Configuración pública del sistema (para el frontend).
 */
router.get('/config', (req, res) => {
  res.json({
    empresaNombre: require('../config/config').agent.empresaNombre,
    delayedButtonSeconds: require('../config/config').agent.delayedButtonSeconds,
    vslVideoUrl: require('../config/config').landing.vslVideoUrl,
    reunionGrupalUrl: require('../config/config').landing.reunionGrupalUrl,
  });
});

/**
 * GET /api/leads/:id/activity
 * Línea de tiempo (eventos) de un lead concreto.
 */
router.get('/leads/:id/activity', (req, res) => {
  const lead = leadManager.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const eventos = activityLog.getActivityByLead(req.params.id);
  res.json({ lead, total: eventos.length, eventos });
});

/**
 * GET /api/activity?limit=100
 * Últimos N eventos de cualquier lead (para el panel "actividad reciente").
 */
router.get('/activity', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json({ total: limit, eventos: activityLog.getRecentActivity(limit) });
});

/**
 * GET /api/stats/activity
 * Métricas agregadas: cuántos leads únicos han alcanzado cada tipo de evento.
 * Sirve para construir el embudo de conversión en el panel.
 */
router.get('/stats/activity', (req, res) => {
  res.json(activityLog.getStats());
});

/**
 * GET /api/system/status
 * Estado de los componentes del sistema, para el panel CRM.
 */
router.get('/system/status', (req, res) => {
  const whatsapp = require('../services/whatsapp');
  const telegram = require('../services/telegram');
  const zoom = require('../services/zoom');
  const config = require('../config/config');

  const grupalUrl = config.landing.calendlyGrupalUrl;
  const individualUrl = config.landing.calendlyIndividualUrl;
  const grupalSet = Boolean(grupalUrl && grupalUrl !== '#');
  const individualSet = Boolean(individualUrl && individualUrl !== '#');
  const sharedUrl = grupalSet && individualSet && grupalUrl === individualUrl;

  res.json({
    whatsapp: { connected: whatsapp.isConfigured() },
    telegram: { enabled: telegram.isReady() },
    zoom: { configured: zoom.isConfigured() },
    calendly: {
      grupal: grupalSet,
      individual: individualSet,
      // true cuando ambas variables apuntan al mismo enlace. Pasa en piloto
      // con Calendly free (no permite eventos de grupo), pero conviene avisarlo.
      sharedUrl,
    },
    backendPublicUrl: config.backendPublicUrl,
  });
});

/**
 * POST /api/leads/:id/resend-question
 * Reenvía la pregunta de filtrado al lead y lo retrocede a
 * esperando_cualificacion (útil para repetir la prueba o reactivar a un lead
 * que se quedó parado).
 */
router.post('/leads/:id/resend-question', async (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const messages = require('../templates/messages');
    const activityLog = require('../services/activityLog');
    const lead = leadManager.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    leadManager.updateLead(lead.id, {
      estado: leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION,
      perfil: leadManager.LEAD_PROFILES.SIN_DEFINIR,
    });
    activityLog.appendActivity(lead.id, 'question_resent', { manual: true });
    await messaging.sendTextMessage(lead.telefono, messages.mensajeReactivacion({ nombre: lead.nombre }));
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [API] Error resend-question:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
