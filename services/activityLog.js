const fs = require('fs');
const path = require('path');

/**
 * Registro append-only de actividad de leads.
 * Se guarda en data/activity.json (gitignored) como un array de eventos.
 * Cada evento: { ts, leadId, type, meta?, ip? }
 *
 * Tipos de evento típicos:
 *  - lead_created
 *  - state_changed             (meta: { from, to })
 *  - profile_set               (meta: { perfil })
 *  - message_sent              (meta: { kind })
 *  - message_received          (meta: { texto })
 *  - landing_view              (vsl.js → page_view)
 *  - video_play / video_progress_25/50/75 / video_complete
 *  - calendly_click            (clic en la página)
 *  - calendly_intent           (meta: { tipo: 'grupal'|'individual' }) — usuario abrió el redirector
 *  - calendly_booked           (Calendly confirmation page → /tracking/calendly-booked)
 *  - reminder_sent             (meta: { fase, n })
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const MAX_ENTRIES_IN_MEMORY = 10000; // protección por si el archivo se hace enorme

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '[]', 'utf-8');
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8'));
  } catch (e) {
    console.error('❌ [Activity] Error leyendo activity.json, reiniciando:', e.message);
    return [];
  }
}

function writeAll(arr) {
  ensureFile();
  // Recortamos si crece demasiado (deja los últimos MAX_ENTRIES_IN_MEMORY)
  const data = arr.length > MAX_ENTRIES_IN_MEMORY
    ? arr.slice(arr.length - MAX_ENTRIES_IN_MEMORY)
    : arr;
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function appendActivity(leadId, type, meta = null, ip = null) {
  if (!leadId || !type) return;
  const all = readAll();
  all.push({
    ts: new Date().toISOString(),
    leadId,
    type,
    ...(meta ? { meta } : {}),
    ...(ip ? { ip } : {}),
  });
  writeAll(all);
}

function getActivityByLead(leadId) {
  return readAll().filter((e) => e.leadId === leadId);
}

function getRecentActivity(limit = 100) {
  const all = readAll();
  return all.slice(Math.max(0, all.length - limit));
}

/**
 * Estadísticas agregadas: cuántos leads han pasado por cada tipo de evento,
 * en cuántos minutos de mediana ocurrió tras la creación, etc.
 */
function getStats() {
  const all = readAll();
  // Sets de leadIds que han alcanzado cada tipo de evento
  const leadsPorTipo = new Map(); // type -> Set(leadId)
  const leadsCalGrupal = new Set();
  const leadsCalIndividual = new Set();
  const leadsEnEstado = new Map(); // estado -> Set(leadId)

  for (const e of all) {
    if (!leadsPorTipo.has(e.type)) leadsPorTipo.set(e.type, new Set());
    leadsPorTipo.get(e.type).add(e.leadId);

    // Desglose por vídeo (VSL vs webinar vs extras): claves tipo
    // "video_play__video1", "video_progress_50__videoWebinar", etc.
    if (e.meta && e.meta.videoId && /^(video_play|video_progress_\d+|video_complete)$/.test(e.type)) {
      const kv = `${e.type}__${e.meta.videoId}`;
      if (!leadsPorTipo.has(kv)) leadsPorTipo.set(kv, new Set());
      leadsPorTipo.get(kv).add(e.leadId);
    }

    // Distinguimos por subtipo de Calendly (grupal vs individual)
    if (e.type === 'calendly_intent' && e.meta && e.meta.tipo === 'grupal') {
      leadsCalGrupal.add(e.leadId);
    }
    if (e.type === 'calendly_intent' && e.meta && e.meta.tipo === 'individual') {
      leadsCalIndividual.add(e.leadId);
    }

    // Contamos cuántos leads alcanzaron cada estado del embudo (a través
    // de state_changed con meta.to).
    if (e.type === 'state_changed' && e.meta && e.meta.to) {
      const st = e.meta.to;
      if (!leadsEnEstado.has(st)) leadsEnEstado.set(st, new Set());
      leadsEnEstado.get(st).add(e.leadId);
    }
  }

  const counts = {};
  for (const [type, set] of leadsPorTipo.entries()) counts[type] = set.size;
  counts['calendly_intent_grupal'] = leadsCalGrupal.size;
  counts['calendly_intent_individual'] = leadsCalIndividual.size;
  for (const [st, set] of leadsEnEstado.entries()) {
    counts[`state_${st}`] = set.size;
  }

  return {
    totalEventos: all.length,
    leadsUnicos: counts.lead_created || 0,
    counts,
  };
}

// % que representa cada tipo de evento de vídeo
function _pctDeEvento(type) {
  if (type === 'video_play') return 1;
  if (type === 'video_complete') return 100;
  const m = type.match(/^video_progress_(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Progreso de vídeo agregado de TODOS los leads en una sola pasada del log.
 * Devuelve { leadId: { videoId: pctMax } }. Evita que /api/leads relea el
 * fichero una vez por lead (con cientos de leads era inviable).
 */
function getVideoProgressByLead() {
  const map = {};
  for (const e of readAll()) {
    const pct = _pctDeEvento(e.type);
    if (pct === null) continue;
    // Eventos antiguos sin videoId corresponden al vídeo principal
    const vid = (e.meta && e.meta.videoId) || 'video1';
    const porVideo = map[e.leadId] || (map[e.leadId] = {});
    if (!porVideo[vid] || pct > porVideo[vid]) porVideo[vid] = pct;
  }
  return map;
}

/**
 * Actividad "en directo": leads con eventos de landing en los últimos
 * `windowMinutes`. Para cada uno devuelve el último evento, el vídeo en el
 * que está y el progreso alcanzado dentro de la ventana.
 */
function getLiveActivity(windowMinutes = 10) {
  const desde = Date.now() - windowMinutes * 60 * 1000;
  const EVENTOS_LANDING = /^(landing_view|video_play|video_progress_\d+|video_complete|webinar_unlocked|extras_unlocked|calendly_button_revealed)$/;
  const porLead = new Map();

  for (const e of readAll()) {
    if (!EVENTOS_LANDING.test(e.type)) continue;
    const ts = new Date(e.ts).getTime();
    if (isNaN(ts) || ts < desde) continue;

    let info = porLead.get(e.leadId);
    if (!info) {
      info = { leadId: e.leadId, lastTs: 0, lastType: null, videoId: null, progreso: {} };
      porLead.set(e.leadId, info);
    }

    const vid = e.meta && e.meta.videoId;
    const pct = _pctDeEvento(e.type);
    if (vid && pct !== null) {
      if (!info.progreso[vid] || pct > info.progreso[vid]) info.progreso[vid] = pct;
    }
    if (ts >= info.lastTs) {
      info.lastTs = ts;
      info.lastType = e.type;
      if (vid) info.videoId = vid;
    }
  }

  return Array.from(porLead.values()).sort((a, b) => b.lastTs - a.lastTs);
}

// Borra del archivo todos los eventos asociados a un leadId.
// Útil para "empezar de cero" en pruebas tras eliminar el lead.
function deleteActivityByLead(leadId) {
  const all = readAll();
  const filtered = all.filter((ev) => ev.leadId !== leadId);
  const eliminados = all.length - filtered.length;
  ensureFile();
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  return eliminados;
}

module.exports = {
  appendActivity,
  getActivityByLead,
  getRecentActivity,
  getStats,
  getVideoProgressByLead,
  getLiveActivity,
  deleteActivityByLead,
};
