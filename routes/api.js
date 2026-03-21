const express = require('express');
const router = express.Router();
const leadManager = require('../services/leadManager');

/**
 * GET /api/leads
 * Lista todos los leads. Query params opcionales: ?estado=video_enviado&fuente=formulario
 */
router.get('/leads', (req, res) => {
  const { estado, fuente } = req.query;
  const leads = leadManager.getAllLeads({ estado, fuente });
  res.json({ total: leads.length, leads });
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
 * Elimina un lead.
 */
router.delete('/leads/:id', (req, res) => {
  const deleted = leadManager.deleteLead(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json({ success: true });
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

module.exports = router;
