const fs = require('fs');
const path = require('path');

/**
 * Campañas — VARIAS ACTIVAS A LA VEZ (lanzamiento octubre 2026).
 *
 * La lista de Karen se parte en tres campañas independientes que corren en
 * paralelo (viejos / verano / septiembre), más una cuarta para los leads que
 * entran en directo. Cada campaña tiene:
 *   - estado:     'activa'    → se contacta a su cola y se le hacen recordatorios
 *                 'pausada'   → NO se contacta a nadie nuevo; los ya contactados
 *                               siguen recibiendo recordatorios y respuestas
 *                 'archivada' → historial: ni contactos ni recordatorios
 *   - segmento:   viejos | verano | septiembre | directo | null. Decide el
 *                 PRIMER MENSAJE (plantilla de Meta) de sus leads. null = cada
 *                 lead según la fecha en que rellenó el formulario.
 *   - leadsPorDia: cupo diario PROPIO (reunión 06-10: 20 por campaña).
 *
 * Crear una campaña ya NO archiva las demás. Nada se borra: una campaña solo
 * se puede eliminar si está vacía.
 *
 * Fichero: data/campanas.json → { lista: [{ id, nombre, estado, segmento,
 * leadsPorDia, creada, archivadaEn, notas }] }. Se respalda en Postgres.
 * Migra solo el formato anterior ({ activa, lista } con archivadaEn).
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'campanas.json');

const CAMPANA_LEGADO = 'prueba_sep26';
const NOMBRE_LEGADO = 'Campaña prueba · septiembre 2026';
const ESTADOS = ['activa', 'pausada', 'archivada'];
const SEGMENTOS = ['viejos', 'verano', 'septiembre', 'directo'];
const CUPO_POR_DEFECTO = () => {
  const n = parseInt(process.env.LEADS_POR_DIA_CAMPANA, 10); // reunión 06-10: 20/día por campaña
  return Number.isFinite(n) && n >= 0 ? n : 20;
};

// Nombres por defecto al repartir la lista automáticamente
const NOMBRE_SEGMENTO = {
  viejos: 'Viejos (dic-jun)',
  verano: 'Verano (jul-ago)',
  septiembre: 'Septiembre',
  directo: 'Nuevos en directo',
};

function _leer() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch (e) { return null; }
}

function _escribir(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ lista: st.lista }, null, 2), 'utf-8');
  try { require('./backupDb').guardarPronto(); } catch (e) { /* sin copia */ }
}

function _estado() {
  let st = _leer();
  let cambiado = false;
  if (!st || !Array.isArray(st.lista) || !st.lista.length) {
    st = {
      lista: [{
        id: CAMPANA_LEGADO,
        nombre: NOMBRE_LEGADO,
        estado: 'activa',
        segmento: null,
        leadsPorDia: CUPO_POR_DEFECTO(),
        creada: new Date().toISOString(),
        archivadaEn: null,
        notas: 'Leads anteriores al sistema de campañas (prueba de septiembre 2026).',
      }],
    };
    cambiado = true;
  }
  // Migración del formato con UNA sola activa ({ activa, lista[archivadaEn] })
  for (const c of st.lista) {
    if (!ESTADOS.includes(c.estado)) {
      c.estado = c.archivadaEn ? 'archivada' : 'activa';
      cambiado = true;
    }
    if (c.segmento === undefined) { c.segmento = null; cambiado = true; }
    if (!Number.isFinite(c.leadsPorDia)) { c.leadsPorDia = CUPO_POR_DEFECTO(); cambiado = true; }
  }
  if (st.activa !== undefined) { delete st.activa; cambiado = true; }
  if (cambiado) _escribir(st);
  return st;
}

function slug(nombre) {
  const s = String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return s || 'campana';
}

function listar() { return _estado().lista.map((c) => ({ ...c })); }
function get(id) { const c = _estado().lista.find((x) => x.id === id); return c ? { ...c } : null; }

/** Ids de las campañas NO archivadas (activas + pausadas). */
function vivas() { return _estado().lista.filter((c) => c.estado !== 'archivada').map((c) => c.id); }
/** Ids de las campañas activas (las que contactan a gente nueva). */
function activas() { return _estado().lista.filter((c) => c.estado === 'activa').map((c) => c.id); }
function esViva(id) { const c = get(id); return Boolean(c && c.estado !== 'archivada'); }

/**
 * Campaña viva (activa o pausada) que lleva ese segmento. Si no hay y
 * `crear`, se crea activa con el nombre por defecto (+ sufijo).
 */
function paraSegmento(segmento, { crear = false, sufijo = '' } = {}) {
  const st = _estado();
  const c = st.lista.find((x) => x.segmento === segmento && x.estado === 'activa')
    || st.lista.find((x) => x.segmento === segmento && x.estado === 'pausada');
  if (c) return { ...c };
  if (!crear) return null;
  const base = NOMBRE_SEGMENTO[segmento] || segmento;
  return crearCampana({ nombre: sufijo ? `${base} · ${sufijo}` : base, segmento });
}

/**
 * Campaña por defecto para un lead nuevo sin campaña indicada: la de su
 * segmento; si no hay, la primera activa; si no, la legado.
 */
function porDefecto(segmento) {
  if (segmento) {
    const c = paraSegmento(segmento, { crear: segmento === 'directo' });
    if (c) return c.id;
  }
  const act = activas();
  return act[0] || CAMPANA_LEGADO;
}

function crearCampana({ nombre, segmento = null, leadsPorDia, notas, id } = {}) {
  const st = _estado();
  const base = slug(id || nombre);
  let nuevoId = base;
  let n = 2;
  while (st.lista.some((c) => c.id === nuevoId)) nuevoId = `${base}_${n++}`;
  const cupo = parseInt(leadsPorDia, 10);
  const nueva = {
    id: nuevoId,
    nombre: String(nombre || nuevoId).trim() || nuevoId,
    estado: 'activa',
    segmento: SEGMENTOS.includes(segmento) ? segmento : null,
    leadsPorDia: Number.isFinite(cupo) && cupo >= 0 ? Math.min(500, cupo) : CUPO_POR_DEFECTO(),
    creada: new Date().toISOString(),
    archivadaEn: null,
    notas: notas || '',
  };
  st.lista.push(nueva);
  _escribir(st);
  console.log(`🗂️  [Campañas] Nueva campaña activa: ${nueva.nombre} (${nueva.id}, segmento ${nueva.segmento || 'por fecha'}, ${nueva.leadsPorDia}/día)`);
  return { ...nueva };
}

function setEstado(id, estado) {
  if (!ESTADOS.includes(estado)) return null;
  const st = _estado();
  const c = st.lista.find((x) => x.id === id);
  if (!c) return null;
  c.estado = estado;
  c.archivadaEn = estado === 'archivada' ? (c.archivadaEn || new Date().toISOString()) : null;
  _escribir(st);
  console.log(`🗂️  [Campañas] ${c.nombre} → ${estado}`);
  return { ...c };
}

function setCupo(id, n) {
  const st = _estado();
  const c = st.lista.find((x) => x.id === id);
  const v = parseInt(n, 10);
  if (!c || !Number.isFinite(v) || v < 0) return null;
  c.leadsPorDia = Math.min(500, v);
  _escribir(st);
  return { ...c };
}

function editar(id, { nombre, segmento, notas } = {}) {
  const st = _estado();
  const c = st.lista.find((x) => x.id === id);
  if (!c) return null;
  if (nombre) c.nombre = String(nombre).trim();
  if (segmento !== undefined) c.segmento = SEGMENTOS.includes(segmento) ? segmento : null;
  if (notas !== undefined) c.notas = String(notas || '');
  _escribir(st);
  return { ...c };
}

/** Elimina una campaña SOLO si no tiene leads (lo comprueba el llamador). */
function eliminar(id) {
  const st = _estado();
  const idx = st.lista.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  st.lista.splice(idx, 1);
  _escribir(st);
  return true;
}

// ─── Compatibilidad ──────────────────────────────────────────────
// Código antiguo que pregunta por "la" campaña activa: la primera activa.
function getActiva() { return activas()[0] || CAMPANA_LEGADO; }
function crear(opts) { return crearCampana(opts); }
function activar(id) { return setEstado(id, 'activa'); }

module.exports = {
  CAMPANA_LEGADO,
  ESTADOS,
  SEGMENTOS,
  NOMBRE_SEGMENTO,
  listar,
  get,
  vivas,
  activas,
  esViva,
  paraSegmento,
  porDefecto,
  crearCampana,
  setEstado,
  setCupo,
  editar,
  eliminar,
  slug,
  getActiva,
  crear,
  activar,
};
