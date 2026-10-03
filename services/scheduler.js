const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const leadManager = require('./leadManager');
const messaging = require('./messaging');
const conversationFlow = require('./conversationFlow');
const activityLog = require('./activityLog');
const messages = require('../templates/messages');

/**
 * Scheduler de Recordatorios Automáticos.
 * Recorre los leads cada 5 min y hace follow-up según el estado:
 *  - Fase 0 (nuevo): activación diaria del import — LEADS_POR_DIA leads al
 *    día, repartidos POR TURNOS entre los segmentos de la lista (viejos /
 *    verano / septiembre / directo), cada uno con su plantilla (reunión
 *    01-10: "los tres a la vez")
 *  - Fase 1 (esperando_cualificacion): reenvía la pregunta de filtrado
 *  - Fase 2 (video_enviado · modo presentación): no reservó la presentación
 *    en directo → reenvía el Calendly grupal
 *  - Fase 2B (video_enviado/video_visto · modo landing): entró al funnel y lo
 *    dejó a medias → reenvía la landing de su perfil según la etapa
 *  - Fase 2C (video_visto · modo presentación): reservó la presentación pero
 *    no entró al Zoom → le ofrece otra
 *  - Fase 3 (reunion_registrado): no reservó el 1-a-1 → reenvía el individual
 *  - Máximo MAX_REMINDERS intentos por fase antes de descartar
 *
 * SOLO se tocan leads de la CAMPAÑA ACTIVA: archivar una campaña congela sus
 * automatismos (reunión 01-10: la campaña de prueba queda de historial).
 */

const MAX_REMINDERS = config.agent.maxReminders;

// Leads de la campaña activa (los únicos que automatizamos)
function _leadsActivos(filtro = {}) {
  return leadManager.getAllLeads({ ...filtro, campana: 'activa' });
}

function _modoPresentacion() {
  return config.flujo.trasCualificar === 'presentacion';
}

// ─── Fase 0: activación diaria del import masivo ──────────────────
// Los leads de /api/import y /webhook/bulk-import se crean en estado "nuevo".
// Esta fase los va activando poco a poco: cupo diario, horario laboral y
// espaciado aleatorio entre envíos, para no disparar los filtros antispam de
// WhatsApp. Config por env: LEADS_POR_DIA (10), ACTIVACION_HORA_INICIO (10),
// ACTIVACION_HORA_FIN (20). Horas en la zona del servidor (poner
// TZ=Europe/Madrid en Seenode para que coincidan con España).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACTIVATION_FILE = path.join(DATA_DIR, 'activation.json');

function _leerEstadoActivacion() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVATION_FILE, 'utf-8'));
  } catch (e) {
    return { fecha: null, activadosHoy: 0, ultimaActivacion: null };
  }
}

function _guardarEstadoActivacion(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACTIVATION_FILE, JSON.stringify(st, null, 2), 'utf-8');
}

// Cupo diario configurable EN CALIENTE desde el CRM (persistido en
// activation.json). Prioridad: valor guardado desde el panel > env
// LEADS_POR_DIA > 10. Así se cambia el ritmo sin tocar Seenode.
// Reunión 24-09: no pasar de 20-25/día — Meta puede tomar el número por bot.
function getLeadsPorDia() {
  const st = _leerEstadoActivacion();
  if (st && Number.isFinite(st.leadsPorDia) && st.leadsPorDia >= 0) return st.leadsPorDia;
  return parseInt(process.env.LEADS_POR_DIA, 10) || 10;
}

function setLeadsPorDia(n) {
  const v = Math.max(0, Math.min(500, parseInt(n, 10)));
  if (!Number.isFinite(v)) return getLeadsPorDia();
  const st = _leerEstadoActivacion();
  st.leadsPorDia = v;
  _guardarEstadoActivacion(st);
  return v;
}

// Segmentos en pausa (desde el CRM): sus leads se quedan en cola.
function getSegmentosPausados() {
  const st = _leerEstadoActivacion();
  return Array.isArray(st.segmentosPausados) ? st.segmentosPausados : [];
}

function setSegmentoPausado(segmento, pausado) {
  const st = _leerEstadoActivacion();
  const set = new Set(Array.isArray(st.segmentosPausados) ? st.segmentosPausados : []);
  if (pausado) set.add(segmento); else set.delete(segmento);
  st.segmentosPausados = Array.from(set);
  _guardarEstadoActivacion(st);
  return st.segmentosPausados;
}

// ¿Está listo el canal por el que se enviaría a este lead?
// (WhatsApp para teléfonos normales, Telegram para los "tg:")
function _canalListo(telefono) {
  const esTg = typeof telefono === 'string' && telefono.startsWith('tg:');
  if (esTg) return require('./telegram').isReady();
  return require('./whatsapp').isConfigured();
}

// ¿El mensaje salió DE VERDAD? false = error de envío; 'development' = el
// cliente no estaba conectado (se "envió" solo al log, no llegó a nadie).
function _envioOk(res) {
  return Boolean(res) && res.success !== false && res.mode !== 'development';
}

// ¿Meta RECHAZÓ el envío (fallo permanente: plantilla mal, política, número
// sin WhatsApp…)? A diferencia del canal caído (mode 'development', temporal),
// esto NO se arregla reintentando cada 5 min, así que hay que hacer backoff.
function _rechazoDeMeta(res) {
  return Boolean(res) && res.success === false && res.mode === 'production';
}

// Orden de los segmentos en el turno. "directo" (leads que entran hoy) va
// siempre el primero: están calientes y conviene contactarlos cuanto antes.
const ORDEN_SEGMENTOS = ['directo', 'viejos', 'verano', 'septiembre'];

/**
 * Elige el siguiente lead de la cola. Los "directo" primero; el resto por
 * turnos entre segmentos (viejos → verano → septiembre → viejos…) para que las
 * tres listas avancen a la vez. Dentro de un segmento, el más antiguo (por
 * fecha del formulario). Se saltan los segmentos en pausa y los que aún no
 * tienen plantilla aprobada en Meta.
 */
function _siguienteLead(nuevos, st) {
  const pausados = new Set(getSegmentosPausados());
  const porSeg = new Map();
  for (const l of nuevos) {
    const seg = l.segmento || 'viejos';
    if (pausados.has(seg)) continue;
    if (!messaging.plantillaParaSegmento(seg)) continue;
    if (!porSeg.has(seg)) porSeg.set(seg, []);
    porSeg.get(seg).push(l);
  }
  if (!porSeg.size) return null;
  const masAntiguo = (arr) => arr
    .slice()
    .sort((a, b) => String(a.fechaLead || a.createdAt || '').localeCompare(String(b.fechaLead || b.createdAt || '')))[0];
  if (porSeg.has('directo')) return masAntiguo(porSeg.get('directo'));
  const resto = ORDEN_SEGMENTOS.filter((s) => s !== 'directo' && porSeg.has(s));
  const idx = resto.indexOf(st.ultimoSegmento);
  const seg = resto[(idx + 1) % resto.length];
  return masAntiguo(porSeg.get(seg));
}

async function procesarActivacionDiaria() {
  const cupo = getLeadsPorDia();
  if (cupo <= 0) return;

  const horaInicio = parseInt(process.env.ACTIVACION_HORA_INICIO, 10) || 10;
  const horaFin = parseInt(process.env.ACTIVACION_HORA_FIN, 10) || 20;
  const ahora = new Date();
  const hora = ahora.getHours();
  if (hora < horaInicio || hora >= horaFin) return;

  let st = _leerEstadoActivacion();
  const hoy = ahora.toISOString().slice(0, 10);
  if (st.fecha !== hoy) st = { ...st, fecha: hoy, activadosHoy: 0, ultimaActivacion: null };
  if (st.activadosHoy >= cupo) return;

  // Espaciado: repartimos el cupo por la ventana horaria, con jitter ±30%
  // para que los envíos no caigan a intervalos exactos (patrón de bot).
  const intervaloMin = Math.max(5, Math.floor(((horaFin - horaInicio) * 60) / cupo));
  if (st.ultimaActivacion) {
    const minDesdeUltima = (Date.now() - new Date(st.ultimaActivacion).getTime()) / 60000;
    const objetivo = intervaloMin * (0.7 + Math.random() * 0.6);
    if (minDesdeUltima < objetivo) return;
  }

  const nuevos = _leadsActivos({ estado: leadManager.LEAD_STATES.NUEVO });
  if (nuevos.length === 0) return;
  const lead = _siguienteLead(nuevos, st);
  if (!lead) {
    // Hay cola pero todos sus segmentos están en pausa o sin plantilla: lo
    // decimos una vez por hora, no cada 5 min.
    if (!st.avisoColaBloqueada || Date.now() - st.avisoColaBloqueada > 3600 * 1000) {
      console.warn(`⏸️  [Activación] ${nuevos.length} leads en cola, pero sus segmentos están en pausa o sin plantilla aprobada (WHATSAPP_TEMPLATE_VERANO / _SEPTIEMBRE / _DIRECTO)`);
      st.avisoColaBloqueada = Date.now();
      _guardarEstadoActivacion(st);
    }
    return;
  }

  // Si el canal está desconectado, NO activamos: no gastamos el cupo del día
  // en un envío que no saldría. La activación se reanuda sola al reconectar.
  if (!_canalListo(lead.telefono)) {
    console.log('⏸️  [Activación] Canal desconectado — en pausa, reintenta al reconectar');
    return;
  }

  // Enviamos ANTES de avanzar el lead: solo si el mensaje sale de verdad
  // contamos el cupo y lo pasamos a esperando_cualificacion. Si no sale
  // (desconexión justo ahora), el lead se queda en la cola para el próximo
  // ciclo / día siguiente.
  const personalizer = require('./personalizer');
  const texto = await personalizer.personalizarMensaje(
    messages.mensajeReactivacion({ nombre: lead.nombre, segmento: lead.segmento }),
    lead
  );
  // Primer contacto: plantilla del SEGMENTO en la API oficial, texto en Baileys.
  const envio = await messaging.sendPrimerContacto(lead, texto, { delaySeconds: 0 });
  if (!_envioOk(envio)) {
    console.warn(`⚠️  [Activación] Envío a ${lead.nombre} no salió (${(envio && envio.error) || 'sin detalle'}) — sigue en la cola (no cuenta cupo)`);
    return;
  }

  const result = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
  if (result.error) {
    console.error(`❌ [Activación] Enviado pero no pude avanzar a ${lead.nombre}: ${result.error}`);
    return;
  }
  // Baseline de recordatorios = ahora (no createdAt, que puede ser de hace
  // días por el import) para que la fase 1 no dispare al instante.
  leadManager.updateLead(lead.id, {
    recordatorios: {
      ...lead.recordatorios,
      fase1: { enviados: 0, ultimoEnvio: new Date().toISOString() },
    },
  });
  activityLog.appendActivity(lead.id, 'lead_activated', { cupo, activadosHoy: st.activadosHoy + 1, segmento: lead.segmento || null });

  st.activadosHoy++;
  st.ultimaActivacion = new Date().toISOString();
  st.ultimoSegmento = lead.segmento || 'viejos';
  _guardarEstadoActivacion(st);
  console.log(`🚀 [Activación] ${lead.nombre} [${lead.segmento || 'viejos'}] activado (${st.activadosHoy}/${cupo} hoy, quedan ${nuevos.length - 1} en cola)`);
}

// Devuelve el intervalo en ms que se debe esperar antes del recordatorio
// número `n` (0-indexado). Si hay menos entradas que MAX_REMINDERS, repite la
// última (típico 72 h). Reunión final 15-06: [5min, 24h, 48h, 72h].
function _intervaloMs(n) {
  const arr = config.agent.reminderIntervalsMinutes || [];
  const minutos = arr[n] != null ? arr[n] : (arr[arr.length - 1] != null ? arr[arr.length - 1] : config.agent.reminderIntervalHours * 60);
  return minutos * 60 * 1000;
}

// Mapeo de funciones de recordatorio por contador (4 niveles)
const grupalReminders = [
  messages.recordatorioGrupal1,
  messages.recordatorioGrupal2,
  messages.recordatorioGrupal3,
  messages.recordatorioGrupal3, // 4º reintento usa el mismo copy duro que el 3º
];

const noAsistioReminders = [
  messages.recordatorioReunion1,
  messages.recordatorioReunion2,
  messages.recordatorioReunion3,
  messages.recordatorioReunion3,
];

// Guarda el contador de una fase sin pisar las demás
function _marcarIntento(lead, fase, sumar) {
  const actual = (lead.recordatorios && lead.recordatorios[fase]) || { enviados: 0, ultimoEnvio: null };
  leadManager.updateLead(lead.id, {
    recordatorios: {
      ...lead.recordatorios,
      [fase]: { enviados: actual.enviados + (sumar ? 1 : 0), ultimoEnvio: new Date().toISOString() },
    },
  });
}

// Descarta un lead que agotó los recordatorios (si el mensaje de despedida
// sale; si el canal está caído, se intenta en el próximo ciclo).
async function _descartarPorAgotamiento(lead, motivo) {
  const envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
  if (!_envioOk(envio)) return false;
  console.log(`🗑  [Scheduler] Descartando lead (${motivo}): ${lead.nombre}`);
  leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
  return true;
}

/**
 * Procesa recordatorios de Fase 1: leads a los que se envió la pregunta de
 * filtrado pero aún no han respondido (estado esperando_cualificacion).
 * Reenvía la pregunta (plantilla de su segmento), máximo MAX_REMINDERS veces,
 * y luego descarta.
 */
async function procesarRecordatoriosFase1() {
  const leads = _leadsActivos({ estado: leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION });
  const ahora = Date.now();

  for (const lead of leads) {
    const fase1 = (lead.recordatorios && lead.recordatorios.fase1) || { enviados: 0, ultimoEnvio: null };

    if (fase1.enviados >= MAX_REMINDERS) {
      await _descartarPorAgotamiento(lead, 'no respondió la cualificación');
      continue;
    }

    const referencia = fase1.ultimoEnvio
      ? new Date(fase1.ultimoEnvio).getTime()
      : new Date(lead.createdAt).getTime();

    if (ahora - referencia < _intervaloMs(fase1.enviados)) continue;

    console.log(`🔔 [Scheduler] Recordatorio Cualificación #${fase1.enviados + 1} → ${lead.nombre}`);
    // Aún sin respuesta del lead → fuera de la ventana de 24h, así que en la
    // API oficial también va como plantilla (el primer contacto reintentado).
    const envio = await messaging.sendPrimerContacto(
      lead,
      messages.mensajeReactivacion({ nombre: lead.nombre, segmento: lead.segmento })
    );
    if (!_envioOk(envio)) {
      if (_rechazoDeMeta(envio)) _marcarIntento(lead, 'fase1', false); // backoff
      continue; // no salió (desconectado): se reintenta
    }
    _marcarIntento(lead, 'fase1', true);
  }
}

/**
 * Fase 2 (solo modo PRESENTACIÓN): leads que recibieron la invitación a la
 * presentación en directo tras cualificar pero aún no han reservado (estado
 * video_enviado). Se les reenvía el enlace de reserva del grupal.
 * Con plantilla (WHATSAPP_TEMPLATE_RECORDATORIO_GRUPAL) llega siempre; sin
 * ella va como texto, que solo entra dentro de la ventana de 24h.
 */
async function procesarRecordatoriosFase2() {
  const leads = _leadsActivos({ estado: leadManager.LEAD_STATES.VIDEO_ENVIADO });
  const ahora = Date.now();

  for (const lead of leads) {
    const fase2 = (lead.recordatorios && lead.recordatorios.fase2) || { enviados: 0, ultimoEnvio: null };

    if (fase2.enviados >= MAX_REMINDERS) {
      await _descartarPorAgotamiento(lead, 'no reservó la presentación');
      continue;
    }

    const referencia = fase2.ultimoEnvio
      ? new Date(fase2.ultimoEnvio).getTime()
      : new Date(lead.updatedAt || lead.createdAt).getTime();

    if (ahora - referencia < _intervaloMs(fase2.enviados)) continue;

    const idx = Math.min(fase2.enviados, grupalReminders.length - 1);
    const enlaceCalendly = conversationFlow.enlaceRedirectorCalendly(lead, 'grupal');
    console.log(`🔔 [Scheduler] Recordatorio Presentación #${fase2.enviados + 1} → ${lead.nombre}`);

    let envio;
    if (config.whatsapp.templateRecordatorioGrupal && !messaging.esTelegram(lead.telefono)) {
      envio = await messaging.sendTemplate(lead.telefono, [lead.nombre], { name: config.whatsapp.templateRecordatorioGrupal, lang: 'es' });
    } else {
      envio = await messaging.sendTextMessage(lead.telefono, grupalReminders[idx]({ nombre: lead.nombre, enlaceCalendly }));
    }
    if (!_envioOk(envio)) {
      if (_rechazoDeMeta(envio)) _marcarIntento(lead, 'fase2', false);
      continue;
    }
    _marcarIntento(lead, 'fase2', true);
  }
}

/**
 * Procesa recordatorios de Fase 2B (modo LANDING): leads que recibieron la
 * landing pero la dejaron a medias (video_enviado / video_visto). Se les
 * reenvía la landing de su perfil con un copy según dónde lo dejaron
 * (deducido del registro de actividad).
 */
async function procesarRecordatoriosFase2B() {
  // Cubre a los leads que están "dentro de la landing" pero aún no han pulsado
  // agendar: tanto los que la tienen ENVIADA y no la han abierto (video_enviado)
  // como los que empezaron a verla y la dejaron a medias (video_visto). A ambos
  // se les reenvía la landing con el copy según dónde lo dejaron.
  const S = leadManager.LEAD_STATES;
  const leads = _leadsActivos().filter(
    (l) => l.estado === S.VIDEO_ENVIADO || l.estado === S.VIDEO_VISTO
  );
  const ahora = Date.now();

  for (const lead of leads) {
    // Leads antiguos pueden no tener el contador fase2b inicializado
    const fase2b = (lead.recordatorios && lead.recordatorios.fase2b) || { enviados: 0, ultimoEnvio: null };

    const actividad = activityLog.getActivityByLead(lead.id);

    // Si tiene actividad reciente en la landing es que sigue dentro viendo
    // los vídeos — no le interrumpimos con un recordatorio (ni le mandamos el
    // 1-a-1) a mitad; puede pulsar agendar él mismo en unos minutos.
    const EVENTOS_LANDING = /^(landing_view|video_play|video_progress|video_complete|webinar_unlocked|extras_unlocked|calendly_button_revealed)/;
    const ultimoEventoLanding = actividad
      .filter((e) => EVENTOS_LANDING.test(e.type))
      .reduce((max, e) => Math.max(max, new Date(e.ts).getTime()), 0);
    if (ultimoEventoLanding && ahora - ultimoEventoLanding < 30 * 60 * 1000) continue;

    // ¿Ya TERMINÓ el webinar? La landing revela el botón de agendar al llegar
    // al 90% del webinar (evento calendly_button_revealed). Si el lead sigue en
    // video_visto es que vio TODA la presentación pero no pulsó agendar — no
    // tiene sentido mandarle "vuelve a ver el vídeo": lo que le falta es el
    // enlace del 1-a-1. Lo promovemos a reunion_registrado y le mandamos el
    // acceso al 1-a-1 (igual que si hubiera pulsado el botón). A partir de ahí
    // los recordatorios los lleva la Fase 3.
    const terminoWebinar = actividad.some(
      (e) =>
        e.type === 'calendly_button_revealed' ||
        ((e.type === 'video_complete' || e.type === 'video_progress_90') &&
          e.meta && e.meta.videoId === 'videoWebinar')
    );
    if (terminoWebinar) {
      // La máquina de estados no salta enviado → registrado directo.
      if (lead.estado === S.VIDEO_ENVIADO) {
        leadManager.transitionState(lead.id, S.VIDEO_VISTO);
        leadManager.updateLead(lead.id, { videoVistoAt: new Date().toISOString() });
      }
      const r = leadManager.transitionState(lead.id, S.REUNION_REGISTRADO);
      if (!r.error) {
        leadManager.updateLead(lead.id, { reunionRegistradoAt: new Date().toISOString() });
        activityLog.appendActivity(lead.id, 'cta_1a1_auto', { motivo: 'webinar_completado' });
        const enlace1a1 = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
        console.log(`🎬→📞 [Scheduler] ${lead.nombre} terminó el webinar sin pulsar agendar → enviando 1-a-1`);
        await messaging.sendTextMessage(
          lead.telefono,
          messages.mensajeAcceso1a1({ nombre: lead.nombre, enlace1a1 })
        );
      }
      // Tanto si el envío salió como si no, el lead ya está en Fase 3: la recoge
      // el próximo ciclo. No le mandamos el recordatorio de landing.
      continue;
    }

    // A partir de aquí, leads que NO han terminado el webinar: recordatorio de
    // landing para que retomen la presentación donde la dejaron.
    if (fase2b.enviados >= MAX_REMINDERS) {
      await _descartarPorAgotamiento(lead, 'máx recordatorios Fase 2B');
      continue;
    }

    const referencia = fase2b.ultimoEnvio
      ? new Date(fase2b.ultimoEnvio).getTime()
      : new Date(lead.videoVistoAt || lead.updatedAt).getTime();

    if (ahora - referencia < _intervaloMs(fase2b.enviados)) continue;

    // ¿Dónde lo dejó EXACTAMENTE? De más avanzado a menos, para que el copy
    // encaje con su punto real y nunca le digamos "vuelve al vídeo" de algo que
    // ya vio, ni "estás a mitad del webinar" de algo que no ha abierto:
    //  - dio al play al webinar y no lo terminó      → 'webinar'
    //  - terminó el VSL pero no ha abierto el webinar → 'vsl_hecho'
    //  - empezó el VSL pero no lo terminó            → 'vsl'
    //  - abrió la landing pero no dio al play        → 'inicio'
    // (Los que SÍ terminaron el webinar ya salieron arriba, van al 1-a-1.)
    const jugoWebinar = actividad.some((e) => e.type === 'video_play' && e.meta && e.meta.videoId === 'videoWebinar');
    const acaboVsl = actividad.some((e) => e.type === 'webinar_unlocked');
    const jugoAlgo = actividad.some((e) => e.type === 'video_play');
    let etapa = 'inicio';
    if (jugoWebinar) etapa = 'webinar';
    else if (acaboVsl) etapa = 'vsl_hecho';
    else if (jugoAlgo) etapa = 'vsl';

    // Recordatorio de landing: usa plantilla aprobada (funciona fuera de ventana 24h).
    // La plantilla recordatorio_presentacion es genérica: "vuelve a ver", "webinar
    // pendiente", etc. según el copy de plantilla — el detalle de qué etapa (vsl,
    // webinar, inicio) ya está en los eventos de la landing (en el CRM).
    console.log(`🔔 [Scheduler] Recordatorio Funnel (${etapa}) #${fase2b.enviados + 1} → ${lead.nombre}`);
    // recordatorio_presentacion usa variable CON NOMBRE ({{nombre}}), así que
    // hay que declararla como tal o Meta la rechaza (132000).
    const envio = await messaging.sendTemplate(
      lead.telefono,
      [lead.nombre],
      { name: 'recordatorio_presentacion', lang: 'es', varNames: ['nombre'] }
    );
    // Rechazo permanente de Meta (plantilla mal, política, etc.): NO reintentar
    // cada 5 min. Registramos el intento para que respete el intervalo. Solo el
    // canal caído (development) reintenta en el próximo ciclo sin gastar intento.
    if (!_envioOk(envio)) {
      if (_rechazoDeMeta(envio)) _marcarIntento(lead, 'fase2b', false);
      continue;
    }
    _marcarIntento(lead, 'fase2b', true);
  }
}

/**
 * Fase 2C (solo modo PRESENTACIÓN): reservó la presentación (video_visto)
 * pero NO entró al Zoom. Pasada la hora reservada (+90 min de margen) se le
 * ofrece otra; si no hay hora conocida, a las 48 h de la reserva. Máximo
 * MAX_REMINDERS y luego descarte. Si asiste, el webhook de Zoom lo saca de
 * aquí (pasa a reunion_registrado con el 1-a-1 enviado).
 */
async function procesarRecordatoriosFase2C() {
  const leads = _leadsActivos({ estado: leadManager.LEAD_STATES.VIDEO_VISTO });
  const ahora = Date.now();

  for (const lead of leads) {
    const fase2c = (lead.recordatorios && lead.recordatorios.fase2c) || { enviados: 0, ultimoEnvio: null };

    if (fase2c.enviados >= MAX_REMINDERS) {
      await _descartarPorAgotamiento(lead, 'no asistió a la presentación');
      continue;
    }

    let referencia;
    if (fase2c.ultimoEnvio) {
      referencia = new Date(fase2c.ultimoEnvio).getTime();
      if (ahora - referencia < _intervaloMs(fase2c.enviados)) continue;
    } else {
      const inicio = lead.presentacionAt ? new Date(lead.presentacionAt).getTime() : NaN;
      if (!isNaN(inicio)) {
        if (ahora < inicio + 90 * 60 * 1000) continue; // la presentación aún no ha pasado
      } else {
        const reserva = new Date(lead.presentacionReservadaAt || lead.videoVistoAt || lead.updatedAt).getTime();
        if (ahora - reserva < 48 * 3600 * 1000) continue;
      }
    }

    const idx = Math.min(fase2c.enviados, noAsistioReminders.length - 1);
    const enlaceReunion = conversationFlow.enlaceRedirectorCalendly(lead, 'grupal');
    console.log(`🔔 [Scheduler] Recordatorio No-asistió #${fase2c.enviados + 1} → ${lead.nombre}`);

    let envio;
    if (config.whatsapp.templateRecordatorioGrupal && !messaging.esTelegram(lead.telefono)) {
      envio = await messaging.sendTemplate(lead.telefono, [lead.nombre], { name: config.whatsapp.templateRecordatorioGrupal, lang: 'es' });
    } else {
      envio = await messaging.sendTextMessage(lead.telefono, noAsistioReminders[idx]({ nombre: lead.nombre, enlaceReunion }));
    }
    if (!_envioOk(envio)) {
      if (_rechazoDeMeta(envio)) _marcarIntento(lead, 'fase2c', false);
      continue;
    }
    _marcarIntento(lead, 'fase2c', true);
  }
}

/**
 * Procesa recordatorios de Fase 3: leads que pulsaron agendar y recibieron
 * el enlace del 1-a-1 pero no han reservado (estado reunion_registrado).
 */
async function procesarRecordatoriosFase3() {
  const leads = _leadsActivos({ estado: leadManager.LEAD_STATES.REUNION_REGISTRADO });
  const ahora = Date.now();

  for (const lead of leads) {
    // Leads antiguos (o promovidos desde la Fase 2B) pueden no traer fase3.
    const fase3 = (lead.recordatorios && lead.recordatorios.fase3) || { enviados: 0, ultimoEnvio: null };

    if (fase3.enviados >= MAX_REMINDERS) {
      await _descartarPorAgotamiento(lead, 'máx recordatorios Fase 3');
      continue;
    }

    const referencia = fase3.ultimoEnvio
      ? new Date(fase3.ultimoEnvio).getTime()
      : new Date(lead.reunionRegistradoAt || lead.updatedAt).getTime();

    if (ahora - referencia < _intervaloMs(fase3.enviados)) continue;

    // Recordatorio 1-a-1: usa plantilla aprobada (funciona fuera de ventana 24h).
    // recordatorio_reunion dice "reserva tu 1-a-1 con Arkaitz" — es suficiente.
    console.log(`🔔 [Scheduler] Recordatorio 1-a-1 #${fase3.enviados + 1} → ${lead.nombre}`);
    // recordatorio_reunion usa variable numerada ({{1}}) → formato posicional.
    const envio = await messaging.sendTemplate(
      lead.telefono,
      [lead.nombre],
      { name: 'recordatorio_reunion', lang: 'en', varNames: ['1'] }  // en: aunque inglés, funciona igual
    );
    // Igual que Fase 2B: si Meta lo rechaza (permanente) no reintentamos cada
    // 5 min; registramos el intento para respetar el intervalo.
    if (!_envioOk(envio)) {
      if (_rechazoDeMeta(envio)) _marcarIntento(lead, 'fase3', false);
      continue;
    }
    _marcarIntento(lead, 'fase3', true);
  }
}

/**
 * Ejecuta todos los procesos de follow-up.
 */
async function ejecutarCiclo() {
  console.log(`\n⏰ [Scheduler] Ciclo de recordatorios — ${new Date().toLocaleString()}`);
  await procesarActivacionDiaria();

  // Los RECORDATORIOS también respetan el horario de día (mismo que la
  // activación: ACTIVACION_HORA_INICIO–FIN, def. 10–20). Sin esto, un lead
  // contactado a las 09:30 recibía su recordatorio de las +12h a las 23:30 —
  // mensaje nocturno = molestia y papeleta de denuncia por spam. Fuera de la
  // ventana no se pierde nada: el intervalo ya vencido dispara en el primer
  // ciclo de la mañana siguiente.
  const horaInicio = parseInt(process.env.ACTIVACION_HORA_INICIO, 10) || 10;
  const horaFin = parseInt(process.env.ACTIVACION_HORA_FIN, 10) || 20;
  const hora = new Date().getHours();
  if (hora < horaInicio || hora >= horaFin) {
    console.log(`🌙 [Scheduler] Fuera de horario (${hora}h) — recordatorios en pausa hasta las ${horaInicio}h`);
    console.log(`✅ [Scheduler] Ciclo completado\n`);
    return;
  }

  await procesarRecordatoriosFase1();
  if (_modoPresentacion()) {
    // Modo presentación en directo: recordar la reserva y, tras la hora, la
    // inasistencia. La landing no entra en juego.
    await procesarRecordatoriosFase2();
    await procesarRecordatoriosFase2C();
  } else {
    // Modo landing (flujo actual): los leads con la landing enviada o a medias.
    await procesarRecordatoriosFase2B();
  }
  await procesarRecordatoriosFase3();
  console.log(`✅ [Scheduler] Ciclo completado\n`);
}

/**
 * Arranca el cron job (cada 5 min).
 */
function iniciar() {
  console.log('🕐 [Scheduler] Programador de recordatorios iniciado (cada 5 min)');

  // Ejecutar cada 5 minutos para que el primer recordatorio (5 min) llegue a tiempo
  cron.schedule('*/5 * * * *', () => {
    ejecutarCiclo().catch((err) => {
      console.error('❌ [Scheduler] Error en ciclo:', err.message);
    });
  });

  // También ejecutar una vez al inicio (con retraso de 10s)
  setTimeout(() => {
    ejecutarCiclo().catch((err) => {
      console.error('❌ [Scheduler] Error en ciclo inicial:', err.message);
    });
  }, 10000);
}

module.exports = {
  iniciar,
  ejecutarCiclo,
  procesarActivacionDiaria,
  getLeadsPorDia,
  setLeadsPorDia,
  getSegmentosPausados,
  setSegmentoPausado,
};
