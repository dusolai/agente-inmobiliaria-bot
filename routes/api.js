const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// ─── Zona de desarrollador ────────────────────────────────────────
// Lo técnico de WhatsApp/Meta (salud del número, diagnóstico, registro,
// webhook, plantillas) solo lo ve el desarrollador: además del usuario y la
// contraseña del CRM, pide la contraseña de desarrollador (cabecera
// X-Dev-Pass). Se guarda solo su hash SHA-256; se puede cambiar con la
// variable DEV_PASS en Seenode.
const DEV_PASS_HASH = process.env.DEV_PASS
  ? crypto.createHash('sha256').update(process.env.DEV_PASS).digest('hex')
  : '98c7f52f4566490a772f88d7dad4699f4e63ce01b2ebe5c8426e4677578ab387';
function _esDev(req) {
  const p = String(req.headers['x-dev-pass'] || '');
  if (!p) return false;
  const h = crypto.createHash('sha256').update(p).digest();
  return crypto.timingSafeEqual(h, Buffer.from(DEV_PASS_HASH, 'hex'));
}
router.use('/whatsapp', (req, res, next) => {
  if (_esDev(req)) return next();
  return res.status(403).json({ error: 'Solo para el desarrollador' });
});
/** POST /api/dev/login  Header X-Dev-Pass → { ok } */
router.post('/dev/login', (req, res) => res.json({ ok: _esDev(req) }));
const fs = require('fs');
const path = require('path');
const leadManager = require('../services/leadManager');
const activityLog = require('../services/activityLog');

/**
 * GET /api/leads
 * Lista todos los leads. Query params opcionales: ?estado=video_enviado&fuente=formulario
 */
// Campaña por la que filtra el CRM: ?campana=<id> | activas | todas. Sin el
// parámetro se muestran TODAS LAS VIVAS (activas + pausadas), que son las que
// se trabajan a diario; una campaña concreta (o una archivada) se elige en el
// desplegable del panel.
function _campana(req) {
  const c = req.query && req.query.campana;
  return c ? String(c) : 'activas';
}

// Leads de hoy activados en un conjunto de campañas
function _activadosHoy(ids) {
  const scheduler = require('../services/scheduler');
  return ids.reduce((s, id) => s + scheduler.activadosHoy(id), 0);
}

// Ids de campaña que abarca el filtro del panel
function _idsCampanas(req) {
  const campanas = require('../services/campanas');
  const c = _campana(req);
  if (c === 'todas') return campanas.listar().map((x) => x.id);
  if (c === 'activas' || c === 'activa') return campanas.vivas();
  return [c];
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

  // Estado de la cola de activación: suma de las campañas del filtro
  const campanasSvc = require('../services/campanas');
  const ids = _idsCampanas(req);
  const cupo = campanasSvc.listar()
    .filter((c) => ids.includes(c.id) && c.estado === 'activa')
    .reduce((t, c) => t + (c.leadsPorDia || 0), 0);
  const importQueue = { enCola, activadosHoy: _activadosHoy(ids), cupo };

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
    await messaging.sendTextoOPlantilla(
      lead,
      messages.mensajeAcceso1a1({ nombre: lead.nombre, enlace1a1 }),
      messaging.PLANTILLA_1A1
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
    const { leads, segmento, campana, sufijo } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads debe ser un array no vacío' });
    }
    // Cada fila puede traer su segmento (el importador del CRM lo calcula por
    // la fecha del lead); si no, `segmento` global, o por fecha, o "viejos".
    // Reglas de duplicados/bajas/repetidos: services/importador.js.
    const importador = require('../services/importador');
    const r = importador.importar(
      leads.map((f) => (f && !f.segmento && segmento ? { ...f, segmento } : f)),
      // campana: id de una campaña, o 'auto' = cada lead a la campaña de su
      // segmento (se crean las que falten con el sufijo, p. ej. "oct26").
      { fuente: 'excel_import', segmentoPorDefecto: segmento || 'viejos', campana: campana || 'auto', sufijo: sufijo || '' }
    );
    if (r.error) return res.status(400).json({ error: r.error });
    console.log(`📥 [API/import] ${r.creados} creados ${JSON.stringify(r.porCampana)} · ${r.duplicados} ya en una campaña viva · ${r.excluidosBaja} con baja · ${r.repetidosDeOtraCampana} repetidos de otra campaña · ${r.errores} errores (sin enviar)`);
    res.json({ success: true, resultado: r });
  } catch (err) {
    console.error('❌ [API] Error /import:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/activation?campana=…
 * "Flujo de la lista" del CRM: totales de las campañas del filtro, contactos
 * de hoy, historial por día (solo de esas campañas) y una fila POR CAMPAÑA
 * con su cola, su cupo, su plantilla y su estado.
 */
router.get('/activation', (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const metaLeads = require('../services/metaLeads');
    const campanas = require('../services/campanas');
    const S = leadManager.LEAD_STATES;
    const ids = _idsCampanas(req);
    const leads = leadManager.getAllLeads({ campana: _campana(req) });

    const porCampana = {};
    for (const c of campanas.listar()) {
      if (!ids.includes(c.id)) continue;
      const p = c.segmento ? messaging.plantillaParaSegmento(c.segmento) : null;
      porCampana[c.id] = {
        id: c.id, nombre: c.nombre, estado: c.estado, segmento: c.segmento,
        segmentoLabel: c.segmento ? metaLeads.SEGMENTO_LABEL[c.segmento] : 'por fecha',
        leadsPorDia: c.leadsPorDia, activadosHoy: require('../services/scheduler').activadosHoy(c.id),
        plantilla: c.segmento ? (p ? p.name : null) : 'según fecha',
        total: 0, enCola: 0, contactados: 0, respondieron: 0, descartados: 0, sinPlantilla: 0,
      };
    }
    for (const l of leads) {
      const f = porCampana[leadManager.campanaDe(l)];
      if (!f) continue;
      f.total++;
      if (l.estado === S.NUEVO) {
        f.enCola++;
        if (!messaging.plantillaParaSegmento(l.segmento || 'viejos')) f.sinPlantilla++;
      } else f.contactados++;
      if (l.estado === S.DESCARTADO) f.descartados++;
      if (l.perfil && l.perfil !== 'sin_definir') f.respondieron++;
    }
    const filas = Object.values(porCampana).sort((x, y) => {
      const o = { activa: 0, pausada: 1, archivada: 2 };
      return (o[x.estado] - o[y.estado]) || String(x.nombre).localeCompare(String(y.nombre));
    });

    const total = leads.length;
    const enCola = leads.filter((l) => l.estado === S.NUEVO).length;
    const descartados = leads.filter((l) => l.estado === S.DESCARTADO).length;
    const leadsPorDia = filas.filter((f) => f.estado === 'activa').reduce((t, f) => t + (f.leadsPorDia || 0), 0);
    const activadosHoy = filas.reduce((t, f) => t + f.activadosHoy, 0);
    const porDia = activityLog.getActivacionesPorDia(new Set(leads.map((l) => l.id)));
    const diasRestantes = leadsPorDia > 0 ? Math.ceil(enCola / leadsPorDia) : null;

    const bloqueo = require('../services/scheduler').getBloqueo();
    res.json({ total, contactados: total - enCola, enCola, descartados, activadosHoy, leadsPorDia, diasRestantes, porDia, porCampana: filas, bloqueo });
  } catch (err) {
    console.error('❌ [API] Error /activation:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/activation/rate  Body: { campana, leadsPorDia }
 * Cambia EN CALIENTE el cupo diario de una campaña.
 */
router.post('/activation/rate', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const { campana, leadsPorDia } = req.body || {};
    if (leadsPorDia === undefined || isNaN(parseInt(leadsPorDia, 10))) {
      return res.status(400).json({ error: 'Falta leadsPorDia (número)' });
    }
    const c = campanas.setCupo(campana || campanas.getActiva(), leadsPorDia);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    console.log(`⚙️  [API] Cupo de ${c.nombre} → ${c.leadsPorDia}/día desde el CRM`);
    res.json({ success: true, campana: c, leadsPorDia: c.leadsPorDia });
  } catch (err) {
    console.error('❌ [API] Error /activation/rate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Campañas ─────────────────────────────────────────────────────
// Reunión 06-10: VARIAS campañas activas a la vez (viejos / verano /
// septiembre / directo), cada una con su cupo, su plantilla y su estado.
// Crear una campaña no toca las demás. Solo se borran las vacías.

function _resumenCampana(c, todos) {
  const suyos = todos.filter((l) => leadManager.campanaDe(l) === c.id);
  return {
    ...c,
    total: suyos.length,
    enCola: suyos.filter((l) => l.estado === 'nuevo').length,
    activos: suyos.filter((l) => l.estado !== 'descartado').length,
    cerrados: suyos.filter((l) => l.estado === 'agenda_1a1' || l.estado === 'reunion_asistio').length,
    activadosHoy: require('../services/scheduler').activadosHoy(c.id),
  };
}

/** GET /api/campanas → { lista: [{ id, nombre, estado, segmento, leadsPorDia, total, enCola, … }] } */
router.get('/campanas', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const todos = leadManager.getAllLeads({ campana: 'todas' });
    const lista = campanas.listar().map((c) => _resumenCampana(c, todos));
    res.json({ lista, activas: campanas.activas(), cupoTotal: require('../services/scheduler').getLeadsPorDia() });
  } catch (err) {
    console.error('❌ [API] Error /campanas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/campanas  Body: { nombre, segmento?, leadsPorDia?, notas? } → crea una campaña ACTIVA (las demás no cambian). */
router.post('/campanas', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const nombre = req.body && String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la campaña' });
    const nueva = campanas.crearCampana({
      nombre,
      segmento: req.body.segmento || null,
      leadsPorDia: req.body.leadsPorDia,
      notas: req.body.notas,
    });
    res.json({ success: true, campana: nueva });
  } catch (err) {
    console.error('❌ [API] Error creando campaña:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/campanas/:id/estado  Body: { estado: 'activa'|'pausada'|'archivada' } */
router.post('/campanas/:id/estado', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const c = campanas.setEstado(req.params.id, req.body && req.body.estado);
    if (!c) return res.status(400).json({ error: 'Campaña o estado no válidos' });
    res.json({ success: true, campana: c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/campanas/:id/activar → compat: estado 'activa'. */
router.post('/campanas/:id/activar', (req, res) => {
  const campanas = require('../services/campanas');
  const c = campanas.setEstado(req.params.id, 'activa');
  if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
  res.json({ success: true, campana: c });
});

/** PUT /api/campanas/:id  Body: { nombre?, segmento?, leadsPorDia? } */
router.put('/campanas/:id', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const b = req.body || {};
    let c = campanas.editar(req.params.id, { nombre: b.nombre, segmento: b.segmento === undefined ? undefined : (b.segmento || null), notas: b.notas });
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (b.leadsPorDia !== undefined) c = campanas.setCupo(req.params.id, b.leadsPorDia) || c;
    res.json({ success: true, campana: c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/campanas/:id → solo si NO tiene leads. */
router.delete('/campanas/:id', (req, res) => {
  try {
    const campanas = require('../services/campanas');
    const n = leadManager.getAllLeads({ campana: req.params.id }).length;
    if (n > 0) return res.status(400).json({ error: `La campaña tiene ${n} leads: archívala en vez de borrarla` });
    if (!campanas.eliminar(req.params.id)) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Probar el recorrido (Diego / Arkaitz con su propio móvil) ────
// Crea (o reinicia) un lead de PRUEBA en la campaña "🧪 Pruebas", que está
// en pausa y con cupo 0: el activador nunca la toca y no cuenta en las
// campañas reales. Dos modos:
//   enviar: true  → le llega YA la plantilla de primer contacto de su segmento
//                   (necesita la plantilla aprobada en Meta)
//   enviar: false → queda esperando; escribes "hola" al número del agente y
//                   te llega la bienvenida como texto (sirve sin plantillas)
const CAMPANA_PRUEBAS = 'pruebas';
function _campanaPruebas() {
  const campanas = require('../services/campanas');
  let c = campanas.get(CAMPANA_PRUEBAS);
  if (!c) {
    c = campanas.crearCampana({ id: CAMPANA_PRUEBAS, nombre: '🧪 Pruebas', leadsPorDia: 0, notas: 'Leads de prueba del recorrido (no cuentan).' });
    c = campanas.setEstado(c.id, 'pausada');
  }
  return c;
}

router.get('/prueba/leads', async (req, res) => {
  const c = _campanaPruebas();
  const leads = leadManager.getAllLeads({ campana: c.id }).map((l) => ({
    id: l.id, nombre: l.nombre, telefono: l.telefono, segmento: l.segmento, estado: l.estado, perfil: l.perfil, createdAt: l.createdAt,
  }));
  // Número del agente (según Meta) para abrir el chat con un clic
  let agente = null;
  try {
    const s = await require('../services/whatsappSalud').estado();
    if (s && s.numero) agente = { numero: s.numero, digitos: String(s.numero).replace(/[^\d]/g, ''), estado: s.estadoNumero || null };
  } catch (e) { /* sin datos de Meta */ }
  let telegram = null;
  try { const u = await require('../services/telegram').getBotUsername(); if (u) telegram = { usuario: u, enlace: `https://t.me/${u}?start=prueba` }; } catch (e) { /* sin Telegram */ }
  res.json({ campana: c.id, leads, agente, telegram });
});

router.post('/prueba/recorrido', async (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const messages = require('../templates/messages');
    const metaLeads = require('../services/metaLeads');
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    const telefono = metaLeads.limpiarTelefono(b.telefono);
    const segmento = metaLeads.SEGMENTOS.includes(b.segmento) ? b.segmento : 'directo';
    if (!nombre || !metaLeads.esTelefonoPlausible(telefono)) {
      return res.status(400).json({ error: 'Pon nombre y un teléfono válido (con o sin 34)' });
    }
    const c = _campanaPruebas();
    // Reinicio: borra la prueba anterior de ese teléfono (y su historial)
    for (const l of leadManager.getAllLeads({ campana: c.id })) {
      if (leadManager.normalizarTelefono(l.telefono) === telefono) {
        leadManager.deleteLead(l.id);
        activityLog.deleteActivityByLead(l.id);
      }
    }
    const lead = leadManager.createLead({
      nombre, telefono, fuente: 'prueba', campana: c.id, segmento,
      fechaLead: new Date().toISOString(),
      respuestas: { 'prueba': 'lead de prueba del recorrido' },
    });
    leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
    leadManager.updateLead(lead.id, {
      recordatorios: { ...lead.recordatorios, fase1: { enviados: 0, ultimoEnvio: new Date().toISOString() } },
    });
    activityLog.appendActivity(lead.id, 'prueba_iniciada', { segmento, enviar: b.enviar !== false });

    let envio = null;
    if (b.enviar !== false) {
      envio = await messaging.sendPrimerContacto(
        leadManager.getLeadById(lead.id),
        messages.mensajeReactivacion({ nombre, segmento }),
        { delaySeconds: 0 }
      );
    }
    const ok = !envio || (envio.success !== false && envio.mode !== 'development');
    res.json({
      success: true,
      lead: leadManager.getLeadById(lead.id),
      enviado: Boolean(envio),
      envioOk: ok,
      error: envio && !ok ? (envio.error || envio.mode) : undefined,
    });
  } catch (err) {
    console.error('❌ [API] Error /prueba/recorrido:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/prueba/leads/:id', (req, res) => {
  const l = leadManager.getLeadById(req.params.id);
  if (!l || leadManager.campanaDe(l) !== CAMPANA_PRUEBAS) return res.status(404).json({ error: 'No es un lead de prueba' });
  leadManager.deleteLead(l.id);
  activityLog.deleteActivityByLead(l.id);
  res.json({ success: true });
});

// ─── Freno de emergencia de envíos ───────────────────────────────
/** POST /api/envios/reanudar → quita el freno puesto por un error de cuenta de Meta. */
router.post('/envios/reanudar', (req, res) => {
  const antes = require('../services/scheduler').desbloquearEnvios();
  res.json({ success: true, estabaParadoPor: antes });
});

// ─── Salud del número de WhatsApp ────────────────────────────────
/**
 * GET /api/whatsapp/salud[?forzar=1] → calidad del número según Meta, límite
 * diario, entregas de los últimos días y veredicto (lo de check-whatsapp.js,
 * visible en el CRM). Cacheado 10 min; ?forzar=1 vuelve a preguntar a Meta.
 */
router.get('/whatsapp/salud', async (req, res) => {
  try {
    res.json(await require('../services/whatsappSalud').estado({ forzar: req.query.forzar === '1' }));
  } catch (err) {
    console.error('❌ [API] Error /whatsapp/salud:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Plantillas de Meta (crear y ver estado sin entrar en WhatsApp Manager) ──
/** GET /api/whatsapp/plantillas → las que necesita el lanzamiento + todas las de la cuenta. */
router.get('/whatsapp/plantillas', async (req, res) => {
  try { res.json(await require('../services/plantillasMeta').requeridas()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/** POST /api/whatsapp/plantillas/crear  Body: { clave: 'verano'|'septiembre'|'directo'|'recordatorio' } */
router.post('/whatsapp/plantillas/crear', async (req, res) => {
  try {
    const r = await require('../services/plantillasMeta').crear(req.body && req.body.clave);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/** GET /api/whatsapp/diagnostico → todo lo que Meta dice del número, la cuenta y el webhook. */
router.get('/whatsapp/diagnostico', async (req, res) => {
  try { res.json(await require('../services/whatsappSalud').diagnostico()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/whatsapp/registrar  Body: { pin } → registra el número en la Cloud API (133010 / PENDING). */
router.post('/whatsapp/registrar', async (req, res) => {
  try {
    const r = await require('../services/whatsappSalud').registrar(req.body && req.body.pin);
    activityLog.appendActivity('sistema', 'whatsapp_registro', { ok: r.ok, error: r.error || null }, req.ip);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/** POST /api/whatsapp/suscribir → vuelve a suscribir la app al webhook de la cuenta. */
router.post('/whatsapp/suscribir', async (req, res) => {
  try {
    const r = await require('../services/whatsappSalud').suscribirWebhook();
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
