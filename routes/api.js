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
// Campaña por la que filtra el CRM: ?campana=<id> | activa | todas. Sin el
// parámetro se muestra la ACTIVA (la que se trabaja a diario); las archivadas
// se consultan eligiéndolas en el desplegable del panel.
function _campana(req) {
  const c = req.query && req.query.campana;
  return c ? String(c) : 'activa';
}

router.get('/leads', (req, res) => {
  const { estado, fuente, segmento } = req.query;
  const leads = leadManager.getAllLeads({ estado, fuente, segmento, campana: _campana(req) });
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
  const leadsById = new Map(leadManager.getAllLeads({ campana: _campana(req) }).map((l) => [l.id, l]));
  const viendo = activityLog.getLiveActivity(minutes).filter((v) => leadsById.has(v.leadId)).map((v) => {
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
  const leads = leadManager.getAllLeads({ campana: _campana(req) });

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
  let importQueue = { enCola, activadosHoy: 0, cupo: require('../services/scheduler').getLeadsPorDia(), ultimaActivacion: null };
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
  res.json(leadManager.getStats({ campana: _campana(req) }));
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
    flujoTrasCualificar: require('../config/config').flujo.trasCualificar,
    segmentos: require('../config/config').segmentos,
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
  const c = _campana(req);
  const ids = c === 'todas' ? null : new Set(leadManager.getAllLeads({ campana: c }).map((l) => l.id));
  res.json(activityLog.getStats(ids));
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
    const envio = await messaging.sendPrimerContacto(lead, messages.mensajeReactivacion({ nombre: lead.nombre, segmento: lead.segmento }), { delaySeconds: 0 });
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
 * POST /api/mantenimiento/limpiar-rechazados
 * Borra del histórico los envíos que Meta RECHAZÓ (message_sent ok:false). Sirve
 * para limpiar el "flood" de recordatorios rechazados. No toca lo que sí salió.
 * Body: { dryRun?: true (solo contar), leadId?: 'xxx' (limitar a un lead) }
 */
router.post('/mantenimiento/limpiar-rechazados', (req, res) => {
  try {
    const dryRun = Boolean(req.body && req.body.dryRun);
    const leadId = (req.body && req.body.leadId) || null;
    const r = activityLog.limpiarRechazados({ dryRun, leadId });
    res.json({ success: true, dryRun, leadId, eliminados: r.eliminados });
  } catch (err) {
    console.error('❌ [API] Error limpiar-rechazados:', err.message);
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
    const { leads, segmento } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads debe ser un array no vacío' });
    }
    // Cada fila puede traer su segmento (el importador del CRM lo calcula por
    // la fecha del lead); si no, `segmento` global, o por fecha, o "viejos".
    // Reglas de duplicados/bajas/repetidos: services/importador.js.
    const importador = require('../services/importador');
    const r = importador.importar(
      leads.map((f) => (f && !f.segmento && segmento ? { ...f, segmento } : f)),
      { fuente: 'excel_import', segmentoPorDefecto: segmento || 'viejos' }
    );
    console.log(`📥 [API/import] ${r.creados} creados · ${r.duplicados} ya en la campaña · ${r.excluidosBaja} con baja · ${r.repetidosDeOtraCampana} repetidos de otra campaña · ${r.errores} errores (sin enviar)`);
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
    const messaging = require('../services/messaging');
    const metaLeads = require('../services/metaLeads');
    const stats = leadManager.getStats({ campana: _campana(req) });
    const S = leadManager.LEAD_STATES;
    const enCola = (stats.porEstado && stats.porEstado[S.NUEVO]) || 0;
    const total = stats.total || 0;
    const descartados = (stats.porEstado && stats.porEstado[S.DESCARTADO]) || 0;
    const contactados = total - enCola;
    const leadsPorDia = scheduler.getLeadsPorDia();

    // Desglose por segmento (viejos / verano / septiembre / directo): cuántos
    // hay, en cola, contactados, si está en pausa y si tiene plantilla aprobada.
    const pausados = new Set(scheduler.getSegmentosPausados());
    const porSegmento = {};
    for (const l of leadManager.getAllLeads({ campana: _campana(req) })) {
      const seg = l.segmento || 'viejos';
      const s = porSegmento[seg] || (porSegmento[seg] = {
        segmento: seg, label: metaLeads.SEGMENTO_LABEL[seg] || seg,
        total: 0, enCola: 0, contactados: 0, respondieron: 0, descartados: 0,
      });
      s.total++;
      if (l.estado === S.NUEVO) s.enCola++; else s.contactados++;
      if (l.estado === S.DESCARTADO) s.descartados++;
      if (l.perfil && l.perfil !== 'sin_definir') s.respondieron++;
    }
    for (const seg of Object.keys(porSegmento)) {
      const p = messaging.plantillaParaSegmento(seg);
      porSegmento[seg].pausado = pausados.has(seg);
      porSegmento[seg].plantilla = p ? p.name : null;
    }
    const ORDEN = ['directo', 'viejos', 'verano', 'septiembre'];
    const segmentos = Object.values(porSegmento).sort((a, b) => ORDEN.indexOf(a.segmento) - ORDEN.indexOf(b.segmento));

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

    res.json({ total, contactados, enCola, descartados, activadosHoy, leadsPorDia, diasRestantes, porDia, porSegmento: segmentos, segmentosPausados: Array.from(pausados) });
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

/**
 * POST /api/activation/segmento
 * Pausa o reanuda un segmento de la cola (sus leads se quedan en "nuevo").
 * Body: { segmento: 'viejos'|'verano'|'septiembre'|'directo', pausado: true|false }
 */
router.post('/activation/segmento', (req, res) => {
  try {
    const scheduler = require('../services/scheduler');
    const metaLeads = require('../services/metaLeads');
    const { segmento, pausado } = req.body || {};
    if (!metaLeads.SEGMENTOS.includes(segmento)) {
      return res.status(400).json({ error: `segmento desconocido: ${segmento}` });
    }
    const pausados = scheduler.setSegmentoPausado(segmento, Boolean(pausado));
    console.log(`⚙️  [API] Segmento ${segmento} ${pausado ? 'EN PAUSA' : 'reanudado'} desde el CRM`);
    res.json({ success: true, segmentosPausados: pausados });
  } catch (err) {
    console.error('❌ [API] Error /activation/segmento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Campañas ─────────────────────────────────────────────────────
// Reunión 01-10: la campaña de prueba se archiva (queda de historial) y el
// lanzamiento empieza con un registro limpio. Una sola campaña activa.

/**
 * GET /api/campanas → { activa, lista: [{ id, nombre, creada, archivadaEn,
 * activa, total, activos, cerrados }] }
 */
router.get('/campanas', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const todos = leadManager.getAllLeads({ campana: 'todas' });
    const lista = campanas.listar().map((c) => {
      const suyos = todos.filter((l) => leadManager.campanaDe(l) === c.id);
      return {
        ...c,
        total: suyos.length,
        activos: suyos.filter((l) => l.estado !== 'descartado').length,
        cerrados: suyos.filter((l) => l.estado === 'agenda_1a1' || l.estado === 'reunion_asistio').length,
      };
    });
    res.json({ activa: campanas.getActiva(), lista });
  } catch (err) {
    console.error('❌ [API] Error /campanas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/campanas  Body: { nombre, notas? }
 * Crea una campaña nueva y la deja activa; la que estaba activa se archiva
 * (sus leads se conservan, sus automatismos se paran).
 */
router.post('/campanas', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const nombre = req.body && String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la campaña' });
    const nueva = campanas.crear({ nombre, notas: req.body.notas });
    res.json({ success: true, campana: nueva, activa: campanas.getActiva() });
  } catch (err) {
    console.error('❌ [API] Error creando campaña:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/campanas/:id/activar → reabre una campaña archivada (la activa pasa a archivada). */
router.post('/campanas/:id/activar', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const c = campanas.activar(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ success: true, campana: c, activa: campanas.getActiva() });
  } catch (err) {
    console.error('❌ [API] Error activando campaña:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Hoja de Google (leads nuevos en directo) ─────────────────────
/** GET /api/sheets/status → estado del lector automático de la hoja. */
router.get('/sheets/status', (req, res) => {
  try {
    res.json(require('../services/sheetsPoller').estado());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/sheets/sync  Body: { activar?: true } → lee la hoja ahora mismo. */
router.post('/sheets/sync', async (req, res) => {
  try {
    const activar = !(req.body && req.body.activar === false);
    const r = await require('../services/sheetsPoller').sincronizar({ activar });
    res.json(r);
  } catch (err) {
    console.error('❌ [API] Error /sheets/sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Plantillas por segmento ──────────────────────────────────────
/**
 * GET /api/plantillas → qué plantilla usa cada segmento (o si falta) y los
 * cuerpos acordados, para darlas de alta en Meta y para la pestaña del CRM.
 */
router.get('/plantillas', (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const messages = require('../templates/messages');
    const metaLeads = require('../services/metaLeads');
    const config = require('../config/config');
    const segmentos = metaLeads.SEGMENTOS.map((seg) => {
      const p = messaging.plantillaParaSegmento(seg);
      const meta = messages.PLANTILLAS_META[seg] || null;
      return {
        segmento: seg,
        label: metaLeads.SEGMENTO_LABEL[seg],
        plantilla: p ? p.name : null,
        variable: meta ? meta.variable : 'WHATSAPP_TEMPLATE_NAME',
        nombreSugerido: meta ? meta.nombreSugerido : (config.whatsapp.templateName || '(la actual)'),
        cuerpo: meta ? meta.cuerpo : null,
      };
    });
    res.json({ segmentos, botones: messages.PLANTILLAS_META.botones, flujo: config.flujo.trasCualificar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
