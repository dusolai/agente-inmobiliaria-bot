const cron = require('node-cron');
const config = require('../config/config');
const leadManager = require('./leadManager');
const messaging = require('./messaging');
const conversationFlow = require('./conversationFlow');
const messages = require('../templates/messages');

/**
 * Scheduler de Recordatorios Automáticos.
 * Ejecuta cada hora para verificar si hay leads que necesiten follow-up.
 * Reglas:
 *  - Fase 2 (Video): Recordatorio cada 48h a leads en estado "video_enviado"
 *  - Fase 3 (Reunión): Recordatorio cada 48h a leads en estado "reunion_registrado"
 *  - Máximo 3 recordatorios antes de descartar
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
const videoReminders = [
  messages.recordatorioVideo1,
  messages.recordatorioVideo2,
  messages.recordatorioVideo3,
  messages.recordatorioVideo3, // 4º reintento usa el mismo copy duro que el 3º
];

const reunionReminders = [
  messages.recordatorioReunion1,
  messages.recordatorioReunion2,
  messages.recordatorioReunion3,
  messages.recordatorioReunion3,
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
 * Procesa recordatorios de Fase 2: leads que recibieron el video pero no lo han visto.
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

    // Enviar recordatorio
    const idx = Math.min(fase2.enviados, videoReminders.length - 1);
    const msgFn = videoReminders[idx];
    const enlaceVideo = `${config.landing.landingUrl}?lead=${lead.id}`;

    console.log(`🔔 [Scheduler] Recordatorio Video #${fase2.enviados + 1} → ${lead.nombre}`);
    await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceVideo })
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
 * Procesa recordatorios de Fase 3: leads registrados a la reunión que no han asistido.
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

    const idx = Math.min(fase3.enviados, reunionReminders.length - 1);
    const msgFn = reunionReminders[idx];

    console.log(`🔔 [Scheduler] Recordatorio Reunión #${fase3.enviados + 1} → ${lead.nombre}`);
    const enlaceReunion = conversationFlow.enlaceRedirectorCalendly(lead, 'grupal');
    await messaging.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceReunion })
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
