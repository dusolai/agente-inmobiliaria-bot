const cron = require('node-cron');
const config = require('../config/config');
const leadManager = require('./leadManager');
const whatsapp = require('./whatsapp');
const messages = require('../templates/messages');

/**
 * Scheduler de Recordatorios Automáticos.
 * Ejecuta cada hora para verificar si hay leads que necesiten follow-up.
 * Reglas:
 *  - Fase 2 (Video): Recordatorio cada 48h a leads en estado "video_enviado"
 *  - Fase 3 (Reunión): Recordatorio cada 48h a leads en estado "reunion_registrado"
 *  - Máximo 3 recordatorios antes de descartar
 */

const REMINDER_INTERVAL_MS = config.agent.reminderIntervalHours * 60 * 60 * 1000;
const MAX_REMINDERS = config.agent.maxReminders;

// Mapeo de funciones de recordatorio por contador
const videoReminders = [
  messages.recordatorioVideo1,
  messages.recordatorioVideo2,
  messages.recordatorioVideo3,
];

const reunionReminders = [
  messages.recordatorioReunion1,
  messages.recordatorioReunion2,
  messages.recordatorioReunion3,
];

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
      await whatsapp.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      continue;
    }

    // ¿Han pasado las horas necesarias desde el último envío?
    const referencia = fase2.ultimoEnvio
      ? new Date(fase2.ultimoEnvio).getTime()
      : new Date(lead.createdAt).getTime();

    if (ahora - referencia < REMINDER_INTERVAL_MS) continue;

    // Enviar recordatorio
    const idx = Math.min(fase2.enviados, videoReminders.length - 1);
    const msgFn = videoReminders[idx];
    const enlaceVideo = `${config.landing.landingUrl}?lead=${lead.id}`;

    console.log(`🔔 [Scheduler] Recordatorio Video #${fase2.enviados + 1} → ${lead.nombre}`);
    await whatsapp.sendTextMessage(
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
      await whatsapp.sendTextMessage(lead.telefono, messages.mensajeDescarte({ nombre: lead.nombre }));
      continue;
    }

    const referencia = fase3.ultimoEnvio
      ? new Date(fase3.ultimoEnvio).getTime()
      : new Date(lead.reunionRegistradoAt || lead.updatedAt).getTime();

    if (ahora - referencia < REMINDER_INTERVAL_MS) continue;

    const idx = Math.min(fase3.enviados, reunionReminders.length - 1);
    const msgFn = reunionReminders[idx];

    console.log(`🔔 [Scheduler] Recordatorio Reunión #${fase3.enviados + 1} → ${lead.nombre}`);
    await whatsapp.sendTextMessage(
      lead.telefono,
      msgFn({ nombre: lead.nombre, enlaceReunion: config.landing.reunionGrupalUrl })
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
  await procesarRecordatoriosFase2();
  await procesarRecordatoriosFase3();
  console.log(`✅ [Scheduler] Ciclo completado\n`);
}

/**
 * Arranca el cron job (cada hora).
 */
function iniciar() {
  console.log('🕐 [Scheduler] Programador de recordatorios iniciado (cada hora)');

  // Ejecutar cada hora en punto
  cron.schedule('0 * * * *', () => {
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
