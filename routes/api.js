const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const leadManager = require('../services/leadManager');
const activityLog = require('../services/activityLog');

/**
 * GET /api/leads
 * Lista todos los leads. Query params opcionales: ?estado=video_enviado&fuente=formulario
 */
router.get('/leads', (req, res) => {
  const { estado, fuente } = req.query;
  const leads = leadManager.getAllLeads({ estado, fuente });
  // Enriquecer cada lead con su progreso por vídeo (VSL y webinar) leyendo el
  // log UNA sola vez, no una vez por lead (aguanta cientos de leads).
  const progresoPorLead = activityLog.getVideoProgressByLead();
  const enriched = leads.map((l) => {
    const prog = progresoPorLead[l.id] || {};
    return Object.assign({}, l, {
      videoProgressMax: prog.video1 || 0, // compat con versiones previas del panel
      progresoVsl: prog.video1 || 0,
      progresoWebinar: prog.videoWebinar || 0,
    });
  });
  res.json({ total: enriched.length, leads: enriched });
});

/**
 * GET /api/live?minutes=10
 * Leads con actividad en la landing en los últimos N minutos: en qué vídeo
 * están, % alcanzado y hace cuánto fue su último evento. Para el panel
 * "En directo" del CRM cuando hay varios leads viendo vídeos a la vez.
 */
router.get('/live', (req, res) => {
  const minutes = Math.max(1, Math.min(120, parseInt(req.query.minutes, 10) || 10));
  const ahora = Date.now();
  const leadsById = new Map(leadManager.getAllLeads().map((l) => [l.id, l]));
  const viendo = activityLog.getLiveActivity(minutes).map((v) => {
    const lead = leadsById.get(v.leadId);
    return Object.assign({}, v, {
      nombre: lead ? lead.nombre : '(lead desconocido)',
      perfil: lead ? lead.perfil : null,
      estado: lead ? lead.estado : null,
      haceSegundos: Math.max(0, Math.round((ahora - v.lastTs) / 1000)),
    });
  });
  res.json({ minutes, total: viendo.length, viendo });
});

/**
 * GET /api/inbox
 * Bandeja de trabajo del CRM para operar cientos de leads a la vez:
 *  - sinResponder: leads cuyo último mensaje es SUYO (el bot no contestó) —
 *    hay que atenderlos a mano
 *  - calientes: terminaron el webinar o pulsaron agendar y AÚN no tienen
 *    reserva 1-a-1 → llamar/escribir ya
 *  - importQueue: estado de la cola de activación diaria del import masivo
 */
router.get('/inbox', (req, res) => {
  const ahora = Date.now();
  const inbox = activityLog.getInboxData();
  const leads = leadManager.getAllLeads();

  const sinResponder = [];
  const calientes = [];
  let enCola = 0;

  for (const l of leads) {
    if (l.estado === 'nuevo') enCola++;
    if (l.estado === 'descartado') continue;
    const i = inbox[l.id];
    if (!i) continue;

    // Sin responder: escribió después del último mensaje del bot (y no fue baja)
    if (i.recibidoTs && !i.optOut && (!i.enviadoTs || new Date(i.recibidoTs) > new Date(i.enviadoTs))) {
      sinResponder.push({
        leadId: l.id, nombre: l.nombre, telefono: l.telefono, estado: l.estado,
        texto: i.recibidoTexto, ts: i.recibidoTs,
        haceMin: Math.round((ahora - new Date(i.recibidoTs).getTime()) / 60000),
      });
    }

    // Caliente: señal de máximo interés en las últimas 48h y sin reserva 1-a-1 aún
    const sigueAbierto = l.estado === 'video_visto' || l.estado === 'reunion_registrado';
    if (i.calienteTs && sigueAbierto && (ahora - new Date(i.calienteTs).getTime()) < 48 * 3600 * 1000) {
      calientes.push({
        leadId: l.id, nombre: l.nombre, telefono: l.telefono, estado: l.estado,
        tipo: i.calienteTipo, ts: i.calienteTs,
        haceMin: Math.round((ahora - new Date(i.calienteTs).getTime()) / 60000),
      });
    }
  }

  sinResponder.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  calientes.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  // Estado de la cola de activación (fichero que mantiene el scheduler)
  let importQueue = { enCola, activadosHoy: 0, cupo: parseInt(process.env.LEADS_POR_DIA, 10) || 10, ultimaActivacion: null };
  try {
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'activation.json'), 'utf-8'));
    const hoy = new Date().toISOString().slice(0, 10);
    importQueue.activadosHoy = st.fecha === hoy ? st.activadosHoy : 0;
    importQueue.ultimaActivacion = st.ultimaActivacion;
  } catch (e) { /* sin fichero aún = sin activaciones */ }

  res.json({ sinResponder, calientes, importQueue });
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
  const { estado, force } = req.body;
  if (!estado) return res.status(400).json({ error: 'Se requiere campo "estado"' });

  // force=true: fija el estado SALTÁNDOSE la máquina de transiciones y sin
  // enviar ningún mensaje. Para reconstruir leads a mano (p. ej. tras el
  // incidente del 13-07: reimportas la lista y marcas a cada contactado en
  // el punto exacto donde estaba, sin molestarle con reenvíos).
  if (force) {
    const S = leadManager.LEAD_STATES;
    if (!Object.values(S).includes(estado)) {
      return res.status(400).json({ error: `Estado desconocido: ${estado}` });
    }
    const lead = leadManager.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    const desde = lead.estado;
    const now = new Date().toISOString();
    const updates = {
      estado,
      historial: [...(lead.historial || []), { estado, fecha: now, forzado: true }],
    };
    if (estado === S.VIDEO_VISTO) updates.videoVistoAt = now;
    if (estado === S.REUNION_REGISTRADO) updates.reunionRegistradoAt = now;
    if (estado === S.REUNION_ASISTIO) updates.reunionAsistioAt = now;
    const updated = leadManager.updateLead(lead.id, updates);
    activityLog.appendActivity(lead.id, 'state_changed', { from: desde, to: estado, force: true }, req.ip);
    console.log(`🔧 [API] Estado FORZADO ${desde} → ${estado}: ${lead.nombre}`);
    return res.json(updated);
  }

  const result = leadManager.transitionState(req.params.id, estado);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.lead);
});

/**
 * POST /api/leads/:id/send-1a1
 * Manda al lead el enlace de la reunión 1-a-1 y lo deja en reunion_registrado.
 * Se usa desde el CRM (botón "registró a reunión") para leads que terminaron la
 * presentación pero no pulsaron el botón de agendar: cambiar el estado a mano
 * (PUT /state) NO enviaba nada, así que el lead se quedaba sin el enlace.
 * Es el equivalente manual a pulsar "agendar" en la landing.
 */
router.post('/leads/:id/send-1a1', async (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const messages = require('../templates/messages');
    const conversationFlow = require('../services/conversationFlow');
    const activityLog = require('../services/activityLog');
    const S = leadManager.LEAD_STATES;

    const lead = leadManager.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    // Avanzamos la máquina de estados paso a paso hasta reunion_registrado,
    // desde CUALQUIER estado previo (nuevo, esperando, enviado, visto). Así el
    // botón sirve también para leads recién (re)importados a los que hay que
    // mandarles el 1-a-1 directamente. Si ya está en registrado, solo reenvía.
    const SIGUIENTE = {
      [S.NUEVO]: S.VIDEO_ENVIADO,
      [S.ESPERANDO_CUALIFICACION]: S.VIDEO_ENVIADO,
      [S.VIDEO_ENVIADO]: S.VIDEO_VISTO,
      [S.VIDEO_VISTO]: S.REUNION_REGISTRADO,
    };
    for (let i = 0; i < 4; i++) {
      const actual = leadManager.getLeadById(lead.id).estado;
      if (actual === S.REUNION_REGISTRADO) break;
      const paso = SIGUIENTE[actual];
      if (!paso) return res.status(400).json({ error: `No se puede enviar el 1-a-1 desde el estado: ${actual}` });
      const r = leadManager.transitionState(lead.id, paso);
      if (r.error) return res.status(400).json({ error: r.error });
    }

    activityLog.appendActivity(lead.id, 'cta_1a1_manual', { via: 'crm' }, req.ip);
    const enlace1a1 = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
    await messaging.sendTextMessage(
      lead.telefono,
      messages.mensajeAcceso1a1({ nombre: lead.nombre, enlace1a1 })
    );

    res.json({ success: true, lead: leadManager.getLeadById(lead.id) });
  } catch (err) {
    console.error('❌ [API] Error send-1a1:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
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
    whatsapp: { connected: whatsapp.isConfigured(), provider: whatsapp.provider },
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
    // Plantilla, no texto libre: el lead (frío) casi nunca está dentro de la
    // ventana de 24h, y Meta rechaza el texto libre fuera de ella. sendPrimerContacto
    // manda la plantilla en la API oficial (y texto normal en Baileys).
    const envio = await messaging.sendPrimerContacto(lead, messages.mensajeReactivacion({ nombre: lead.nombre }), { delaySeconds: 0 });
    res.json({ ok: true, entrega: envio && envio.success !== false ? 'aceptado' : 'rechazado', detalle: envio && envio.error });
  } catch (err) {
    console.error('❌ [API] Error resend-question:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/leads/:id/mensaje
 * Escribe TÚ al lead desde el CRM, por el mismo número y el mismo chat de
 * WhatsApp que usa el agente. Va como texto libre, así que solo llega si la
 * ventana de 24h está abierta (el lead escribió hace menos de 24h); si no,
 * Meta lo rechaza con 131047 y se devuelve el motivo para avisarte.
 * Body: { texto }
 */
router.post('/leads/:id/mensaje', async (req, res) => {
  try {
    const texto = req.body && typeof req.body.texto === 'string' ? req.body.texto.trim() : '';
    if (!texto) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    if (texto.length > 4000) return res.status(400).json({ error: 'Mensaje demasiado largo (máx. 4000)' });

    const lead = leadManager.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

    const messaging = require('../services/messaging');
    // Sin retraso de "escribiendo": lo mandas tú, no el agente simulando.
    const envio = await messaging.sendTextMessage(lead.telefono, texto, {
      delaySeconds: 0,
      meta: { manual: true },
    });

    const ok = Boolean(envio) && envio.success !== false;
    res.json({
      success: ok,
      aceptado: ok,
      error: ok ? undefined : (envio && envio.error) || 'no se pudo enviar',
      code: envio && envio.code,
    });
  } catch (err) {
    console.error('❌ [API] Error enviando mensaje manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mantenimiento/limpiar-clics-falsos
 * Borra del histórico los "clics" que en realidad eran la vista previa de
 * WhatsApp (intents registrados a segundos del envío del enlace). Inflaban el
 * embudo con clics que nunca hizo nadie.
 * Body: { dryRun: true } → solo lista lo que borraría, sin tocar nada.
 */
router.post('/mantenimiento/limpiar-clics-falsos', (req, res) => {
  try {
    const dryRun = Boolean(req.body && req.body.dryRun);
    const r = activityLog.limpiarClicsFalsos({ dryRun });
    res.json({
      success: true,
      dryRun,
      total: r.total,
      eliminados: r.eliminados.map((e) => ({ ts: e.ts, leadId: e.leadId, type: e.type })),
    });
  } catch (err) {
    console.error('❌ [API] Error limpiar-clics-falsos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/import
 * Importa una lista de leads (desde el CSV en el CRM) en modo SEGURO: los crea
 * en estado "nuevo" SIN enviar ningún mensaje. El activador diario los va
 * soltando al ritmo configurado. Está bajo /api (protegido por ADMIN_TOKEN).
 * Body: { leads: [{nombre, telefono, email?}], ignorarDuplicados?: true }
 */
router.post('/import', (req, res) => {
  try {
    const { leads, ignorarDuplicados } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads debe ser un array no vacío' });
    }
    const ignorar = ignorarDuplicados !== false; // default true
    const r = { creados: 0, duplicados: 0, errores: 0, total: leads.length };
    for (const fila of leads) {
      try {
        if (!fila || !fila.telefono || !fila.nombre) { r.errores++; continue; }
        const tel = String(fila.telefono).replace(/\s+/g, '');
        if (ignorar && leadManager.getLeadByPhone(tel)) { r.duplicados++; continue; }
        leadManager.createLead({ nombre: fila.nombre, email: fila.email || '', telefono: tel, fuente: 'excel_import' });
        r.creados++;
      } catch (e) { r.errores++; }
    }
    console.log(`📥 [API/import] ${r.creados} creados, ${r.duplicados} duplicados, ${r.errores} errores (sin enviar)`);
    res.json({ success: true, resultado: r });
  } catch (err) {
    console.error('❌ [API] Error /import:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/activation
 * Estado del flujo de la lista importada (CSV): cuántos hay, cuántos ya
 * contactados, cuántos en cola, cuántos hoy, el cupo diario actual y el
 * historial de contactos por día. Para el panel "Flujo de la lista" del CRM.
 */
router.get('/activation', (req, res) => {
  try {
    const scheduler = require('../services/scheduler');
    const stats = leadManager.getStats();
    const S = leadManager.LEAD_STATES;
    const enCola = (stats.porEstado && stats.porEstado[S.NUEVO]) || 0;
    const total = stats.total || 0;
    const descartados = (stats.porEstado && stats.porEstado[S.DESCARTADO]) || 0;
    const contactados = total - enCola;
    const leadsPorDia = scheduler.getLeadsPorDia();

    // Cuántos activados HOY (de activation.json)
    let activadosHoy = 0;
    try {
      const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
      const act = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'activation.json'), 'utf-8'));
      const hoy = new Date().toISOString().slice(0, 10);
      if (act.fecha === hoy) activadosHoy = act.activadosHoy || 0;
    } catch (e) {}

    const porDia = activityLog.getActivacionesPorDia();
    const diasRestantes = leadsPorDia > 0 ? Math.ceil(enCola / leadsPorDia) : null;

    res.json({ total, contactados, enCola, descartados, activadosHoy, leadsPorDia, diasRestantes, porDia });
  } catch (err) {
    console.error('❌ [API] Error /activation:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/activation/rate
 * Cambia el cupo diario (leads por día) EN CALIENTE, sin tocar Seenode.
 * Body: { leadsPorDia: <número> }. Se persiste en activation.json.
 */
router.post('/activation/rate', (req, res) => {
  try {
    const scheduler = require('../services/scheduler');
    const n = req.body && req.body.leadsPorDia;
    if (n === undefined || n === null || isNaN(parseInt(n, 10))) {
      return res.status(400).json({ error: 'Falta leadsPorDia (número)' });
    }
    const leadsPorDia = scheduler.setLeadsPorDia(n);
    console.log(`⚙️  [API] Cupo diario cambiado a ${leadsPorDia}/día desde el CRM`);
    res.json({ success: true, leadsPorDia });
  } catch (err) {
    console.error('❌ [API] Error /activation/rate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
