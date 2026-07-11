const cron = require('node-cron');
const config = require('../config/config');
const leadManager = require('./leadManager');
const messaging = require('./messaging');
const conversationFlow = require('./conversationFlow');
const activityLog = require('./activityLog');
const messages = require('../templates/messages');

/**
 * Scheduler de Recordatorios Automáticos.
 * Recorre los leads cada 5 min y hace follow-up según el estado:
 *  - Fase 1 (esperando_cualificacion): reenvía la pregunta de filtrado
 *  - Fase 2 (video_enviado): no reservó el grupal → reenvía el Calendly grupal
 *  - Fase 2B (video_visto): entró al funnel y lo dejó a medias → reenvía la
 *    landing de su perfil, con copy según la etapa (inicio / vsl / webinar)
 *  - Fase 3 (reunion_registrado): no reservó el 1-a-1 → reenvía el individual
 *  - Máximo MAX_REMINDERS intentos por fase antes de descartar
 */

const MAX_REMINDERS = config.agent.maxReminders;

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
      console.log(`🗑  [Scheduler] Descartando lead (no respondió la cualificación): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      continue;
    }

    const referencia = fase1.ultimoEnvio
      ? new Date(fase1.ultimoEnvio).getTime()
      : new Date(lead.createdAt).getTime();

    if (ahora - referencia < _intervaloMs(fase1.enviados)) continue;

    console.log(`🔔 [Scheduler] Recordatorio Cualificación #${fase1.enviados + 1} → ${lead.nombre}`);
    await messaging.sendTextMessage(
      lead.telefono,
      messages.mensajeReactivacion({ nombre: lead.nombre })
    );

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
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 2): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
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
    await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceCalendly })
    );

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
  const leads = leadManager.getAllLeads({ estado: leadManager.LEAD_STATES.VIDEO_VISTO });
  const ahora = Date.now();

  for (const lead of leads) {
    // Leads antiguos pueden no tener el contador fase2b inicializado
    const fase2b = (lead.recordatorios && lead.recordatorios.fase2b) || { enviados: 0, ultimoEnvio: null };

    if (fase2b.enviados >= MAX_REMINDERS) {
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 2B): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      continue;
    }

    const referencia = fase2b.ultimoEnvio
      ? new Date(fase2b.ultimoEnvio).getTime()
      : new Date(lead.videoVistoAt || lead.updatedAt).getTime();

    if (ahora - referencia < _intervaloMs(fase2b.enviados)) continue;

    // ¿Dónde lo dejó? Lo deducimos de los eventos que reporta la landing.
    const actividad = activityLog.getActivityByLead(lead.id);
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
    await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceLanding, etapa })
    );

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
      console.log(`🗑  [Scheduler] Descartando lead (máx recordatorios Fase 3): ${lead.nombre}`);
      leadManager.transitionState(lead.id, leadManager.LEAD_STATES.DESCARTADO);
      await messaging.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
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
    await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlace1a1 })
    );

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
  await procesarRecordatoriosFase1();
  await procesarRecordatoriosFase2();
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

module.exports = { iniciar, ejecutarCiclo };
