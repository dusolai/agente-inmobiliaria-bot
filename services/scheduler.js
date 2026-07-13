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
 *  - Fase 0 (nuevo): activación diaria del import masivo — LEADS_POR_DIA
 *    leads al día, espaciados con intervalos aleatorios en horario laboral
 *  - Fase 1 (esperando_cualificacion): reenvía la pregunta de filtrado
 *  - Fase 2 (video_enviado): no reservó el grupal → reenvía el Calendly grupal
 *  - Fase 2B (video_visto): entró al funnel y lo dejó a medias → reenvía la
 *    landing de su perfil, con copy según la etapa (inicio / vsl / webinar)
 *  - Fase 3 (reunion_registrado): no reservó el 1-a-1 → reenvía el individual
 *  - Máximo MAX_REMINDERS intentos por fase antes de descartar
 */

const MAX_REMINDERS = config.agent.maxReminders;

// ─── Fase 0: activación diaria del import masivo ──────────────────
// Los leads de /webhook/bulk-import se crean en estado "nuevo". Esta fase
// los va activando poco a poco: cupo diario, horario laboral y espaciado
// aleatorio entre envíos, para no disparar los filtros antispam de WhatsApp.
// Config por env: LEADS_POR_DIA (10), ACTIVACION_HORA_INICIO (10),
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
  if (st.fecha !== hoy) st = { fecha: hoy, activadosHoy: 0, ultimaActivacion: null, leadsPorDia: st.leadsPorDia };
  if (st.activadosHoy >= cupo) return;

  // Espaciado: repartimos el cupo por la ventana horaria, con jitter ±30%
  // para que los envíos no caigan a intervalos exactos (patrón de bot).
  const intervaloMin = Math.max(5, Math.floor(((horaFin - horaInicio) * 60) / cupo));
  if (st.ultimaActivacion) {
    const minDesdeUltima = (Date.now() - new Date(st.ultimaActivacion).getTime()) / 60000;
    const objetivo = intervaloMin * (0.7 + Math.random() * 0.6);
    if (minDesdeUltima < objetivo) return;
  }

  // El más antiguo primero (getAllLeads ordena por creación descendente)
  const nuevos = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.NUEVO });
  if (nuevos.length === 0) return;
  const lead = nuevos[nuevos.length - 1];

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
    messages.mensajeReactivacion({ nombre: lead.nombre }),
    lead
  );
  // Primer contacto: plantilla en la API oficial, texto en Baileys.
  const envio = await messaging.sendPrimerContacto(lead, texto, { delaySeconds: 0 });
  if (!_envioOk(envio)) {
    console.warn(`⚠️  [Activación] Envío a ${lead.nombre} no salió — sigue en la cola (no cuenta cupo)`);
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
  activityLog.appendActivity(lead.id, 'lead_activated', { cupo, activadosHoy: st.activadosHoy + 1 });

  st.activadosHoy++;
  st.ultimaActivacion = new Date().toISOString();
  _guardarEstadoActivacion(st);
  console.log(`🚀 [Activación] ${lead.nombre} activado (${st.activadosHoy}/${cupo} hoy, quedan ${nuevos.length - 1} en cola)`);
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

const funnelReminders = [
  messages.recordatorioFunnel1,
  messages.recordatorioFunnel2,
  messages.recordatorioFunnel3,
  messages.recordatorioFunnel3,
];

const reminders1a1 = [
  messages.recordatorio1a1Primero,
  messages.recordatorio1a1Segundo,
  messages.recordatorio1a1Tercero,
  messages.recordatorio1a1Tercero,
];

/**
 * Procesa recordatorios de Fase 1: leads a los que se envió la pregunta de
 * filtrado pero aún no han respondido (estado esperando_cualificacion).
 * Reenvía la pregunta cada 24 h, máximo 3 veces, y luego descarta.
 */
async function procesarRecordatoriosFase1() {
  const leads = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION });
  const ahora = Date.now();

  for (const lead of leads) {
    const fase1 = (lead.recordatorios && lead.recordatorios.fase1) || { enviados: 0, ultimoEnvio: null };

    if (fase1.enviados >= MAX_REMINDERS) {
      const envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      if (!_envioOk(envio)) continue; // canal caído: no descartamos todavía
      console.log(`🗑  [Scheduler] Descartando lead (no respondió la cualificación): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
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
      messages.mensajeReactivacion({ nombre: lead.nombre })
    );
    if (!_envioOk(envio)) continue; // no salió (desconectado): se reintenta

    leadManager.updateLead(lead.id, {
      recordatorios: {
        ...lead.recordatorios,
        fase1: {
          enviados: fase1.enviados + 1,
          ultimoEnvio: new Date().toISOString(),
        },
      },
    });
  }
}

/**
 * Procesa recordatorios de Fase 2: leads que recibieron el Calendly grupal
 * tras cualificar pero aún no han reservado (estado video_enviado).
 * Se les reenvía el enlace de reserva del grupal — la landing llega sola
 * al confirmar la reserva (/tracking/calendly-booked).
 */
async function procesarRecordatoriosFase2() {
  const leads = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.VIDEO_ENVIADO });
  const ahora = Date.now();

  for (const lead of leads) {
    const { recordatorios } = lead;
    const fase2 = recordatorios.fase2;

    // ¿Ya alcanzó el máximo de recordatorios?
    if (fase2.enviados >= MAX_REMINDERS) {
      const envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      if (!_envioOk(envio)) continue; // canal caído: no descartamos todavía
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 2): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      continue;
    }

    // ¿Han pasado las horas necesarias desde el último envío?
    const referencia = fase2.ultimoEnvio
      ? new Date(fase2.ultimoEnvio).getTime()
      : new Date(lead.createdAt).getTime();

    if (ahora - referencia < _intervaloMs(fase2.enviados)) continue;

    // Enviar recordatorio con el enlace del Calendly grupal
    const idx = Math.min(fase2.enviados, grupalReminders.length - 1);
    const msgFn = grupalReminders[idx];
    const enlaceCalendly = conversationFlow.enlaceRedirectorCalendly(lead, 'grupal');

    console.log(`🔔 [Scheduler] Recordatorio Grupal #${fase2.enviados + 1} → ${lead.nombre}`);
    const envio = await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceCalendly })
    );
    if (!_envioOk(envio)) continue; // no salió (desconectado): se reintenta

    // Actualizar contadores
    leadManager.updateLead(lead.id, {
      recordatorios: {
        ...lead.recordatorios,
        fase2: {
          enviados: fase2.enviados + 1,
          ultimoEnvio: new Date().toISOString(),
        },
      },
    });
  }
}

/**
 * Procesa recordatorios de Fase 2B: leads que reservaron el grupal y
 * recibieron la landing, pero abandonaron el funnel sin pulsar agendar
 * (estado video_visto). Se les reenvía la landing de su perfil con un
 * copy según dónde lo dejaron (deducido del registro de actividad).
 */
async function procesarRecordatoriosFase2B() {
  // Cubre a los leads que están "dentro de la landing" pero aún no han pulsado
  // agendar: tanto los que la tienen ENVIADA y no la han abierto (video_enviado)
  // como los que empezaron a verla y la dejaron a medias (video_visto). A ambos
  // se les reenvía la landing con el copy según dónde lo dejaron.
  const S = leadManager.LEAD_STATES;
  const leads = leadManager.getAllLeads().filter(
    (l) => l.estado === S.VIDEO_ENVIADO || l.estado === S.VIDEO_VISTO
  );
  const ahora = Date.now();

  for (const lead of leads) {
    // Leads antiguos pueden no tener el contador fase2b inicializado
    const fase2b = (lead.recordatorios && lead.recordatorios.fase2b) || { enviados: 0, ultimoEnvio: null };

    if (fase2b.enviados >= MAX_REMINDERS) {
      const envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      if (!_envioOk(envio)) continue; // canal caído: no descartamos todavía
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 2B): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      continue;
    }

    const referencia = fase2b.ultimoEnvio
      ? new Date(fase2b.ultimoEnvio).getTime()
      : new Date(lead.videoVistoAt || lead.updatedAt).getTime();

    if (ahora - referencia < _intervaloMs(fase2b.enviados)) continue;

    const actividad = activityLog.getActivityByLead(lead.id);

    // Si tiene actividad reciente en la landing es que sigue dentro viendo
    // los vídeos — no le interrumpimos con un recordatorio a mitad.
    const EVENTOS_LANDING = /^(landing_view|video_play|video_progress|video_complete|webinar_unlocked|extras_unlocked|calendly_button_revealed)/;
    const ultimoEventoLanding = actividad
      .filter((e) => EVENTOS_LANDING.test(e.type))
      .reduce((max, e) => Math.max(max, new Date(e.ts).getTime()), 0);
    if (ultimoEventoLanding && ahora - ultimoEventoLanding < 30 * 60 * 1000) continue;

    // ¿Dónde lo dejó? Lo deducimos de los eventos que reporta la landing.
    let etapa = 'inicio';
    if (actividad.some((e) => e.type === 'webinar_unlocked')) {
      etapa = 'webinar';
    } else if (actividad.some((e) => e.type === 'video_play')) {
      etapa = 'vsl';
    }

    const idx = Math.min(fase2b.enviados, funnelReminders.length - 1);
    const msgFn = funnelReminders[idx];
    const enlaceLanding = conversationFlow.enlaceLandingPorPerfil(lead.perfil, lead.id);

    console.log(`🔔 [Scheduler] Recordatorio Funnel (${etapa}) #${fase2b.enviados + 1} → ${lead.nombre}`);
    const envio = await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceLanding, etapa, perfil: lead.perfil })
    );
    if (!_envioOk(envio)) continue; // no salió (desconectado): se reintenta

    leadManager.updateLead(lead.id, {
      recordatorios: {
        ...lead.recordatorios,
        fase2b: {
          enviados: fase2b.enviados + 1,
          ultimoEnvio: new Date().toISOString(),
        },
      },
    });
  }
}

/**
 * Procesa recordatorios de Fase 3: leads que pulsaron agendar y recibieron
 * el enlace del 1-a-1 pero no han reservado (estado reunion_registrado).
 */
async function procesarRecordatoriosFase3() {
  const leads = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.REUNION_REGISTRADO });
  const ahora = Date.now();

  for (const lead of leads) {
    const { recordatorios } = lead;
    const fase3 = recordatorios.fase3;

    if (fase3.enviados >= MAX_REMINDERS) {
      const envio = await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      if (!_envioOk(envio)) continue; // canal caído: no descartamos todavía
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 3): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      continue;
    }

    const referencia = fase3.ultimoEnvio
      ? new Date(fase3.ultimoEnvio).getTime()
      : new Date(lead.reunionRegistradoAt || lead.updatedAt).getTime();

    if (ahora - referencia < _intervaloMs(fase3.enviados)) continue;

    const idx = Math.min(fase3.enviados, reminders1a1.length - 1);
    const msgFn = reminders1a1[idx];

    console.log(`🔔 [Scheduler] Recordatorio 1-a-1 #${fase3.enviados + 1} → ${lead.nombre}`);
    const enlace1a1 = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
    const envio = await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlace1a1 })
    );
    if (!_envioOk(envio)) continue; // no salió (desconectado): se reintenta

    leadManager.updateLead(lead.id, {
      recordatorios: {
        ...lead.recordatorios,
        fase3: {
          enviados: fase3.enviados + 1,
          ultimoEnvio: new Date().toISOString(),
        },
      },
    });
  }
}

/**
 * Ejecuta todos los procesos de follow-up.
 */
async function ejecutarCiclo() {
  console.log(`\n⏰ [Scheduler] Ciclo de recordatorios — ${new Date().toLocaleString()}`);
  await procesarActivacionDiaria();
  await procesarRecordatoriosFase1();
  // Fase 2 (recordatorio del Calendly grupal) queda retirada: el flujo actual
  // no obliga a reservar el grupal. Los leads con la landing enviada se cubren
  // en la Fase 2B junto con los que la están viendo.
  await procesarRecordatoriosFase2B();
  await procesarRecordatoriosFase3();
  console.log(`✅ [Scheduler] Ciclo completado\n`);
}

/**
 * Arranca el cron job (cada hora).
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

module.exports = { iniciar, ejecutarCiclo, getLeadsPorDia, setLeadsPorDia };
