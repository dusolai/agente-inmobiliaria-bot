const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// ─── Estados posibles del Lead ────────────────────────────────────
const LEAD_STATES = {
  NUEVO: 'nuevo',
  VIDEO_ENVIADO: 'video_enviado',
  VIDEO_VISTO: 'video_visto',
  REUNION_REGISTRADO: 'reunion_registrado',
  REUNION_ASISTIO: 'reunion_asistio',
  AGENDA_1A1: 'agenda_1a1',
  DESCARTADO: 'descartado',
};

// ─── Transiciones válidas de estado ───────────────────────────────
const VALID_TRANSITIONS = {
  [LEAD_STATES.NUEVO]: [LEAD_STATES.VIDEO_ENVIADO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.VIDEO_ENVIADO]: [LEAD_STATES.VIDEO_VISTO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.VIDEO_VISTO]: [LEAD_STATES.REUNION_REGISTRADO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.REUNION_REGISTRADO]: [LEAD_STATES.REUNION_ASISTIO, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.REUNION_ASISTIO]: [LEAD_STATES.AGENDA_1A1, LEAD_STATES.DESCARTADO],
  [LEAD_STATES.AGENDA_1A1]: [],
  [LEAD_STATES.DESCARTADO]: [],
};

// ─── Persistencia ─────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

function readLeads() {
  ensureDataDir();
  const raw = fs.readFileSync(LEADS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeLeads(leads) {
  ensureDataDir();
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

// ─── CRUD ─────────────────────────────────────────────────────────
function createLead({ nombre, email, telefono, fuente = 'formulario' }) {
  const leads = readLeads();
  const now = new Date().toISOString();

  const lead = {
    id: uuidv4(),
    nombre: nombre || 'Sin nombre',
    email: email || '',
    telefono: telefono || '',
    fuente,
    estado: LEAD_STATES.NUEVO,
    createdAt: now,
    updatedAt: now,
    historial: [{ estado: LEAD_STATES.NUEVO, fecha: now }],
    recordatorios: {
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
  return leads.find((l) => l.telefono === telefono) || null;
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
  VALID_TRANSITIONS,
  createLead,
  getAllLeads,
  getLeadById,
  getLeadByPhone,
  updateLead,
  transitionState,
  deleteLead,
  getStats,
};
