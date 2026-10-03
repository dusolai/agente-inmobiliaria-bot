const config = require('../config/config');

/**
 * Lectura y limpieza de leads en el formato de Meta Lead Ads.
 *
 * Es el formato del CSV que exporta Karen y de la hoja de Google
 * "NUEVA: Captación agentes inmobiliarios" (pestaña DIC25): columnas
 *   id, created_time, …, full_name, phone_number ("p:+34…"), email,
 *   lead_status y las tres preguntas del formulario ("¿tienes_experiencia…?").
 * También acepta un CSV simple con columnas nombre / telefono / email.
 *
 * Lo usan el importador del CRM (lado servidor), el lector automático de la
 * hoja de Google (sheetsPoller) y el script que parte el Excel en segmentos.
 *
 * SEGMENTOS (reunión 01-10, "arkatiz cambios 2"): la lista se divide por la
 * fecha en que el lead rellenó el formulario y cada segmento recibe su propio
 * primer mensaje (plantilla de Meta distinta):
 *   viejos      → antes del 1 de julio 2026 (dic-25 … jun-26)
 *   verano      → julio y agosto 2026        ("con el verano de por medio…")
 *   septiembre  → desde el 1 de septiembre   ("hace unos días mostraste interés…")
 *   directo     → leads que entran en tiempo real tras el lanzamiento
 *                 (hoja de Google / formulario / escriben al WhatsApp)
 */

const SEGMENTOS = ['viejos', 'verano', 'septiembre', 'directo'];

const SEGMENTO_LABEL = {
  viejos: 'Viejos (dic-jun)',
  verano: 'Verano (jul-ago)',
  septiembre: 'Septiembre y después',
  directo: 'Nuevos en directo',
};

// ─── Teléfonos ────────────────────────────────────────────────────
// "p:+34 667 55 00 70" → "34667550070". Un móvil español de 9 cifras sin
// prefijo (6xx/7xx) recibe el 34. "00" inicial se quita.
function limpiarTelefono(raw) {
  let t = String(raw || '').trim().replace(/^p:/i, '').replace(/[^\d]/g, '');
  if (!t) return '';
  if (t.startsWith('00')) t = t.slice(2);
  if (t.length === 9 && /^[67]/.test(t)) t = '34' + t;
  return t;
}
function esMovilEspanol(t) { return /^34[67]\d{8}$/.test(String(t || '')); }
function esTelefonoPlausible(t) { return /^\d{8,15}$/.test(String(t || '')); }

// ─── Segmento por fecha del lead ──────────────────────────────────
function segmentoPorFecha(fecha, cortes = config.segmentos) {
  if (!fecha) return null;
  const d = String(fecha).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (d < cortes.corteVerano) return 'viejos';
  if (d < cortes.corteSeptiembre) return 'verano';
  return 'septiembre';
}

function _norm(s) { return String(s || '').trim().toLowerCase(); }
function _buscar(obj, nombres) {
  for (const n of nombres) if (obj[n] !== undefined && obj[n] !== '') return obj[n];
  return undefined;
}

/**
 * Fila (objeto cabecera → valor) → lead limpio. Las cabeceras pueden venir
 * con mayúsculas o espacios: se normalizan. Devuelve siempre un objeto; el
 * llamador decide con `esTest` / teléfono si se usa.
 */
function filaALead(filaCruda) {
  const fila = {};
  for (const [k, v] of Object.entries(filaCruda || {})) {
    fila[_norm(k)] = v == null ? '' : String(v).trim();
  }

  const nombre = _buscar(fila, ['full_name', 'nombre', 'name', 'nombre completo']) || '';
  const telRaw = _buscar(fila, ['phone_number', 'telefono', 'teléfono', 'phone', 'movil', 'móvil', 'whatsapp']) || '';
  const email = _buscar(fila, ['email', 'mail', 'correo', 'e-mail']) || '';
  const fechaRaw = _buscar(fila, ['created_time', 'fecha', 'created', 'fecha_lead', 'date']) || '';
  const metaId = _buscar(fila, ['id', 'lead_id', 'meta_id']) || '';

  // Respuestas del formulario de Meta: columnas que son preguntas.
  const respuestas = {};
  for (const [k, v] of Object.entries(fila)) {
    if (!v) continue;
    if (k.startsWith('¿') || k.startsWith('?') || /experiencia|importante|agencia|pregunta/.test(k)) {
      respuestas[k.replace(/_/g, ' ')] = v.replace(/_/g, ' ');
    }
  }

  const esTest =
    /test lead|dummy data/i.test(nombre) ||
    /test lead|dummy data/i.test(telRaw) ||
    /@fb\.com$/i.test(email);

  let fechaLead = null;
  if (fechaRaw) {
    const d = new Date(fechaRaw);
    if (!isNaN(d.getTime())) fechaLead = d.toISOString();
  }

  return {
    nombre,
    telefono: limpiarTelefono(telRaw),
    telRaw,
    email,
    fechaLead,
    metaLeadId: metaId || null,
    respuestas: Object.keys(respuestas).length ? respuestas : null,
    esTest,
  };
}

/**
 * Procesa un conjunto de filas: limpia, descarta las filas de prueba de
 * Meta, deduplica por teléfono (se queda con la entrada MÁS RECIENTE: si
 * alguien rellenó el formulario dos veces, manda su última vez) y asigna
 * segmento por fecha.
 *
 * opts: {
 *   segmentoFijo        → fuerza un segmento para todas las filas
 *   segmentoPorDefecto  → si la fila no trae fecha (CSV simple). Def. 'viejos'
 *   cortes              → { corteVerano, corteSeptiembre } (YYYY-MM-DD)
 *   incluirExtranjeros  → los teléfonos no españoles también cuentan como válidos
 * }
 * Devuelve { validos, revisar, excluidos, porSegmento, stats }.
 */
function procesarFilas(filas, opts = {}) {
  const cortes = Object.assign({}, config.segmentos, opts.cortes || {});
  const porTelefono = new Map();
  const excluidos = [];
  let total = 0;

  for (const cruda of filas) {
    if (!cruda || Object.values(cruda).every((v) => !String(v == null ? '' : v).trim())) continue;
    total++;
    const l = filaALead(cruda);
    if (l.esTest) { excluidos.push({ ...l, motivo: 'fila de prueba de Meta' }); continue; }
    if (!l.nombre) { excluidos.push({ ...l, motivo: 'sin nombre' }); continue; }
    if (!esTelefonoPlausible(l.telefono)) {
      excluidos.push({ ...l, motivo: `teléfono no válido (${l.telRaw || 'vacío'})` });
      continue;
    }
    const prev = porTelefono.get(l.telefono);
    if (prev) {
      const nuevaEsMasReciente = (l.fechaLead || '') >= (prev.fechaLead || '');
      const descartada = nuevaEsMasReciente ? prev : l;
      const conservada = nuevaEsMasReciente ? l : prev;
      excluidos.push({
        ...descartada,
        motivo: `duplicado (mismo teléfono); se conserva la entrada del ${(conservada.fechaLead || '').slice(0, 10) || '?'}`,
      });
      porTelefono.set(l.telefono, conservada);
      continue;
    }
    porTelefono.set(l.telefono, l);
  }

  const validos = [];
  const revisar = [];
  const porSegmento = {};
  for (const l of porTelefono.values()) {
    l.segmento = opts.segmentoFijo
      || segmentoPorFecha(l.fechaLead, cortes)
      || opts.segmentoPorDefecto
      || 'viejos';
    l.extranjero = !esMovilEspanol(l.telefono);
    if (l.extranjero && !opts.incluirExtranjeros) { revisar.push(l); continue; }
    validos.push(l);
    porSegmento[l.segmento] = (porSegmento[l.segmento] || 0) + 1;
  }
  // Los más antiguos primero: la cola se contacta en orden de llegada.
  validos.sort((a, b) => (a.fechaLead || '').localeCompare(b.fechaLead || ''));

  return {
    validos,
    revisar,
    excluidos,
    porSegmento,
    stats: { total, validos: validos.length, revisar: revisar.length, excluidos: excluidos.length },
  };
}

// ─── CSV ──────────────────────────────────────────────────────────
// Parser sencillo (comillas, comas dentro de comillas, saltos \r\n). Devuelve
// un array de objetos cabecera → valor. Quita el BOM si lo hay.
function parseCSV(texto) {
  const text = String(texto || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* nada */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => _norm(h));
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] == null ? '' : r[i]; });
    return obj;
  });
}

module.exports = {
  SEGMENTOS,
  SEGMENTO_LABEL,
  limpiarTelefono,
  esMovilEspanol,
  esTelefonoPlausible,
  segmentoPorFecha,
  filaALead,
  procesarFilas,
  parseCSV,
};
