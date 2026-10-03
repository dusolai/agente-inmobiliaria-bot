const fs = require('fs');
const path = require('path');

/**
 * Campañas (reunión 01-10, "arkatiz cambios 2").
 *
 * Arkaitz pidió que la campaña de prueba de septiembre NO se mezcle con el
 * lanzamiento nuevo: "esta pestaña se cierra y se abre otra igual, limpia,
 * virgen; esta pondrá campaña prueba de septiembre y las vamos guardando
 * todas" (Diego). Nada se borra: cada lead lleva su `campana`, el CRM muestra
 * una campaña cada vez (la activa por defecto) y las archivadas quedan de
 * historial.
 *
 * Reglas:
 *  - Hay exactamente UNA campaña activa. Los leads nuevos (import, hoja de
 *    Google, formulario, WhatsApp entrante) se crean en ella.
 *  - El activador diario y los recordatorios SOLO tocan leads de la campaña
 *    activa: archivar una campaña congela sus automatismos.
 *  - Los leads antiguos sin campaña se asignan a `prueba_sep26` al arrancar
 *    (leadManager.migrarCampanas).
 *
 * Fichero: data/campanas.json → { activa, lista: [{ id, nombre, creada,
 * archivadaEn, notas }] }. Se respalda en Postgres como el resto.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'campanas.json');

const CAMPANA_LEGADO = 'prueba_sep26';
const NOMBRE_LEGADO = 'Campaña prueba · septiembre 2026';

function _leer() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch (e) { return null; }
}

function _escribir(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(st, null, 2), 'utf-8');
  try { require('./backupDb').guardarPronto(); } catch (e) { /* sin copia */ }
}

function _estado() {
  let st = _leer();
  if (!st || !Array.isArray(st.lista) || !st.lista.length || !st.activa) {
    st = {
      activa: CAMPANA_LEGADO,
      lista: [{
        id: CAMPANA_LEGADO,
        nombre: NOMBRE_LEGADO,
        creada: new Date().toISOString(),
        archivadaEn: null,
        notas: 'Leads anteriores al sistema de campañas (prueba de septiembre 2026).',
      }],
    };
    _escribir(st);
  }
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

function getActiva() { return _estado().activa; }

function get(id) { return _estado().lista.find((c) => c.id === id) || null; }

function listar() {
  const st = _estado();
  return st.lista.map((c) => ({ ...c, activa: c.id === st.activa }));
}

/**
 * Crea una campaña nueva y la deja ACTIVA. La que estaba activa pasa a
 * archivada (sus leads se conservan, sus automatismos se paran).
 */
function crear({ nombre, id, notas } = {}) {
  const st = _estado();
  const base = id ? slug(id) : slug(nombre);
  let nuevoId = base;
  let n = 2;
  while (st.lista.some((c) => c.id === nuevoId)) nuevoId = `${base}_${n++}`;
  const ahora = new Date().toISOString();
  for (const c of st.lista) if (c.id === st.activa && !c.archivadaEn) c.archivadaEn = ahora;
  const nueva = { id: nuevoId, nombre: String(nombre || nuevoId).trim() || nuevoId, creada: ahora, archivadaEn: null, notas: notas || '' };
  st.lista.push(nueva);
  st.activa = nuevoId;
  _escribir(st);
  console.log(`🗂️  [Campañas] Nueva campaña activa: ${nueva.nombre} (${nueva.id})`);
  return nueva;
}

/** Reabre una campaña archivada (la activa actual pasa a archivada). */
function activar(id) {
  const st = _estado();
  const c = st.lista.find((x) => x.id === id);
  if (!c) return null;
  const ahora = new Date().toISOString();
  for (const x of st.lista) if (x.id === st.activa && x.id !== id && !x.archivadaEn) x.archivadaEn = ahora;
  c.archivadaEn = null;
  st.activa = id;
  _escribir(st);
  console.log(`🗂️  [Campañas] Campaña activa: ${c.nombre} (${c.id})`);
  return c;
}

function renombrar(id, { nombre, notas } = {}) {
  const st = _estado();
  const c = st.lista.find((x) => x.id === id);
  if (!c) return null;
  if (nombre) c.nombre = String(nombre).trim();
  if (notas !== undefined) c.notas = String(notas || '');
  _escribir(st);
  return c;
}

module.exports = { CAMPANA_LEGADO, getActiva, get, listar, crear, activar, renombrar, slug };
