const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const activityLog = require('./activityLog');

// DATA_DIR permite apuntar los datos a un disco persistente (Seenode) para
// que un redeploy no borre los leads. Sin la variable, ./data como siempre.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// ─── Perfiles de lead (segmentación por la pregunta de filtrado) ──
const LEAD_PROFILES = {
  PROFESIONAL: 'profesional',     // agente inmobiliario / agencia
  EMPRENDEDOR: 'emprendedor',     // busca un sobresueldo / colaborador
  SIN_DEFINIR: 'sin_definir',
};

// ─── Estados posibles del Lead ────────────────────────────────────
const LEAD_STATES = {
  NUEVO: 'nuevo',
  ESPERANDO_CUALIFICACION: 'esperando_cualificacion', // se envió la pregunta de filtrado
  VIDEO_ENVIADO: 'video_enviado',
  VIDEO_VISTO: 'video_visto',
  REUNION_REGISTRADO: 'reunion_registrado',
  REUNION_ASISTIO: 'reunion_asistio',
  AGENDA_1A1: 'agenda_1a1',
  DESCARTADO: 'descartado',
};

// ─── Transiciones válidas de estado ───────────────────────────────
const VALID_TRANSITIONS = {
  [LEAD_STATES.NUEVO]: [LEAD_STATES.ESPERANDO_CUALIFICACION, LEAD_STATES.VIDEO_ENVIADO, LEAD_STATES.DESCARTADO],
  // Nuevo flujo: tras cualificar se envía la landing directamente (VIDEO_VISTO),
  // sin el paso obligatorio de reservar el grupal. VIDEO_ENVIADO sigue válido
  // por compatibilidad con leads antiguos y el flujo con grupal.
  [LEAD_STATES.ESPERANDO_CUALIFICACION]: [LEAD_STATES.VIDEO_ENVIADO, LEAD_STATES.VIDEO_VISTO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.VIDEO_ENVIADO]: [LEAD_STATES.VIDEO_VISTO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.VIDEO_VISTO]: [LEAD_STATES.REUNION_REGISTRADO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.REUNION_REGISTRADO]: [LEAD_STATES.REUNION_ASISTIO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.REUNION_ASISTIO]: [LEAD_STATES.AGENDA_1A1, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.AGENDA_1A1]: [],
  [LEAD_STATES.DESCARTADO]: [],
};

// ─── Normalización de teléfono ────────────────────────────────────
// Deja solo dígitos: quita espacios, +, guiones, puntos y paréntesis.
// "34 667 55 00 70" y "+34-667.550.070" → "34667550070".
// Los identificadores de Telegram ("tg:<chat_id>") se devuelven tal cual.
function normalizarTelefono(telefono) {
  const t = String(telefono || '').trim();
  if (t.startsWith('tg:')) return t;
  return t.replace(/[^\d]/g, '');
}

// ─── Persistencia ─────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

// Caché por mtime: evita parsear el fichero entero en cada petición del
// panel (con cientos de leads era un parse de cientos de KB varias veces
// por segundo). Solo se relee si el fichero cambió.
let _cache = null;
let _cacheMtime = 0;

function readLeads() {
  ensureDataDir();
  const mtime = fs.statSync(LEADS_FILE).mtimeMs;
  if (_cache && mtime === _cacheMtime) return _cache;
  _cache = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
  _cacheMtime = mtime;
  return _cache;
}

function writeLeads(leads) {
  ensureDataDir();
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
  // Programar copia a Postgres a los pocos segundos (si está configurado).
  // Así un lead recién creado no se pierde aunque redespliegues al momento.
  try { require('./backupDb').guardarPronto(); } catch (e) {}
}

// ─── CRUD ─────────────────────────────────────────────────────────
function createLead({ nombre, email, telefono, fuente = 'formulario' }) {
  const leads = readLeads();
  const now = new Date().toISOString();

  const lead = {
    id: uuidv4(),
    nombre: nombre || 'Sin nombre',
    email: email || '',
    telefono: normalizarTelefono(telefono),
    fuente,
    perfil: LEAD_PROFILES.SIN_DEFINIR,
    estado: LEAD_STATES.NUEVO,
    createdAt: now,
    updatedAt: now,
    historial: [{ estado: LEAD_STATES.NUEVO, fecha: now }],
    recordatorios: {
      fase1: { enviados: 0, ultimoEnvio: null }, // recordatorios de la pregunta de cualificación
      fase2: { enviados: 0, ultimoEnvio: null },
      fase3: { enviados: 0, ultimoEnvio: null },
    },
    videoVistoAt: null,
    reunionRegistradoAt: null,
    reunionAsistioAt: null,
    agenda1a1At: null,
    descartadoAt: null,
    notas: '',
  };

  leads.push(lead);
  writeLeads(leads);
  activityLog.appendActivity(lead.id, 'lead_created', { fuente, telefono });
  return lead;
}

function getAllLeads(filtro = {}) {
  let leads = readLeads();

  if (filtro.estado) {
    leads = leads.filter((l) => l.estado === filtro.estado);
  }
  if (filtro.fuente) {
    leads = leads.filter((l) => l.fuente === filtro.fuente);
  }

  // Ordenar por fecha de creación descendente
  leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return leads;
}

function getLeadById(id) {
  const leads = readLeads();
  return leads.find((l) => l.id === id) || null;
}

function getLeadByPhone(telefono) {
  const leads = readLeads();
  // Comparamos normalizado por ambos lados: así un lead antiguo guardado con
  // espacios sigue encontrándose cuando WhatsApp entrega el número limpio.
  const buscado = normalizarTelefono(telefono);
  return leads.find((l) => normalizarTelefono(l.telefono) === buscado) || null;
}

function updateLead(id, updates) {
  const leads = readLeads();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return null;

  const now = new Date().toISOString();
  leads[idx] = { ...leads[idx], ...updates, updatedAt: now };
  writeLeads(leads);
  return leads[idx];
}

function transitionState(id, nuevoEstado) {
  const leads = readLeads();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return { error: 'Lead no encontrado', lead: null };

  const lead = leads[idx];
  const transicionesValidas = VALID_TRANSITIONS[lead.estado] || [];

  if (!transicionesValidas.includes(nuevoEstado)) {
    return {
      error: `Transición no válida: ${lead.estado} → ${nuevoEstado}`,
      lead,
    };
  }

  const now = new Date().toISOString();
  lead.estado = nuevoEstado;
  lead.updatedAt = now;
  lead.historial.push({ estado: nuevoEstado, fecha: now });

  // Actualizar timestamps específicos
  switch (nuevoEstado) {
    case LEAD_STATES.VIDEO_VISTO:
      lead.videoVistoAt = now;
      break;
    case LEAD_STATES.REUNION_REGISTRADO:
      lead.reunionRegistradoAt = now;
      break;
    case LEAD_STATES.REUNION_ASISTIO:
      lead.reunionAsistioAt = now;
      break;
    case LEAD_STATES.AGENDA_1A1:
      lead.agenda1a1At = now;
      break;
    case LEAD_STATES.DESCARTADO:
      lead.descartadoAt = now;
      break;
  }

  writeLeads(leads);
  activityLog.appendActivity(lead.id, 'state_changed', {
    from: lead.historial[lead.historial.length - 2]?.estado || null,
    to: nuevoEstado,
  });
  return { error: null, lead };
}

function deleteLead(id) {
  const leads = readLeads();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return false;
  leads.splice(idx, 1);
  writeLeads(leads);
  return true;
}

function getStats() {
  const leads = readLeads();
  const total = leads.length;

  const porEstado = {};
  Object.values(LEAD_STATES).forEach((s) => {
    porEstado[s] = leads.filter((l) => l.estado === s).length;
  });

  const activos = total - (porEstado[LEAD_STATES.DESCARTADO] || 0);
  const tasaConversion = total > 0
    ? (((porEstado[LEAD_STATES.AGENDA_1A1] || 0) / total) * 100).toFixed(1)
    : '0.0';

  return {
    total,
    activos,
    descartados: porEstado[LEAD_STATES.DESCARTADO] || 0,
    tasaConversion: `${tasaConversion}%`,
    porEstado,
    ultimoLead: leads.length > 0 ? leads[leads.length - 1].createdAt : null,
  };
}

module.exports = {
  LEAD_STATES,
  LEAD_PROFILES,
  VALID_TRANSITIONS,
  normalizarTelefono,
  createLead,
  getAllLeads,
  getLeadById,
  getLeadByPhone,
  updateLead,
  transitionState,
  deleteLead,
  getStats,
};
