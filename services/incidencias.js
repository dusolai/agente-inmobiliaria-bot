const fs = require('fs');
const path = require('path');

/**
 * Incidencias del bot para la zona de desarrollador.
 *
 * Se calculan AL VUELO a partir del registro de actividad (no se guardan):
 * mensajes repetidos, landing enviada dos veces, descartes justo después de un
 * recordatorio, leads que piden una persona, envíos fallidos y mensajes sin
 * contestar. Lo único que se persiste es qué incidencias ya están RESUELTAS
 * (data/incidencias_resueltas.json), por su clave `${tipo}:${leadId}:${ts}`.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RESUELTAS_FILE = path.join(DATA_DIR, 'incidencias_resueltas.json');

const MIN = 60 * 1000;
const VENTANA_DUPLICADO = 10 * MIN;
const VENTANA_LANDING = 60 * MIN;
const VENTANA_DESCARTE = 120 * MIN;
const VENTANA_RESPUESTA = 30 * MIN;

// ─── Textos casi iguales ──────────────────────────────────────────
// Minúsculas, sin enlaces, sin emojis/puntuación/espacios. Si al quitar todo
// eso no queda nada (p. ej. un mensaje que es solo un enlace), se compara el
// texto en bruto para no juntar dos enlaces distintos.
function normalizar(texto) {
  const bruto = String(texto || '').toLowerCase().trim();
  const limpio = bruto
    .replace(/https?:\/\/\S+|www\.\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return limpio || bruto.replace(/\s+/g, '');
}

// Coeficiente de Dice sobre bigramas (0..1)
function _dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const big = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const k = a.slice(i, i + 2);
    big.set(k, (big.get(k) || 0) + 1);
  }
  let comunes = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const k = b.slice(i, i + 2);
    const n = big.get(k) || 0;
    if (n > 0) { big.set(k, n - 1); comunes++; }
  }
  return (2 * comunes) / (a.length - 1 + b.length - 1);
}

// ¿Dos textos son el mismo mensaje? Iguales, uno contiene al otro (con un
// mínimo de longitud para que "ok" no "contenga" medio mensaje) o muy parecidos.
function casiIguales(t1, t2) {
  const a = normalizar(t1);
  const b = normalizar(t2);
  if (!a || !b) return false;
  if (a === b) return true;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  if (corto.length >= 12 && largo.includes(corto)) return true;
  return corto.length >= 12 && _dice(a, b) >= 0.9;
}

// ─── Resueltas (persistidas en data/) ─────────────────────────────
function leerResueltas() {
  try {
    if (!fs.existsSync(RESUELTAS_FILE)) return {};
    const v = JSON.parse(fs.readFileSync(RESUELTAS_FILE, 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    console.error('❌ [Incidencias] Error leyendo incidencias_resueltas.json:', e.message);
    return {};
  }
}

function marcarResuelta(clave, resuelta = true) {
  const k = String(clave || '').trim();
  if (!k) return { error: 'Falta la clave' };
  const todas = leerResueltas();
  if (resuelta) todas[k] = new Date().toISOString();
  else delete todas[k];
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESUELTAS_FILE, JSON.stringify(todas, null, 2), 'utf-8');
  // Copia a Postgres a los pocos segundos (si está configurado)
  try { require('./backupDb').guardarPronto(); } catch (e) { /* sin copia */ }
  return { ok: true, clave: k, resuelta: !!resuelta };
}

// ─── Cálculo ──────────────────────────────────────────────────────
const _t = (e) => new Date(e.ts).getTime();
const _corta = (s, n = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const _enviado = (e) => e.type === 'message_sent' && !(e.meta && e.meta.ok === false);

/**
 * Incidencias de un conjunto de leads.
 * @param {object[]} eventos  registro de actividad (cualquier orden)
 * @param {object[]} leads    leads a revisar ({ id, nombre, telefono, estado })
 * @param {object}   opts     { desde: ms — solo incidencias a partir de aquí, ahora: ms }
 * @returns {object[]} [{ tipo, leadId, nombre, telefono, ts, detalle, clave }] — más recientes primero
 */
function calcular(eventos, leads, { desde = 0, ahora = Date.now() } = {}) {
  const leadsById = new Map(leads.map((l) => [l.id, l]));
  // Contexto: se miran eventos algo anteriores a `desde` para no perder
  // la primera mitad de un duplicado o el recordatorio previo a un descarte.
  const desdeCtx = desde - VENTANA_DESCARTE;
  const porLead = new Map();
  for (const e of eventos) {
    if (!leadsById.has(e.leadId)) continue;
    const t = _t(e);
    if (isNaN(t) || t < desdeCtx) continue;
    if (!porLead.has(e.leadId)) porLead.set(e.leadId, []);
    porLead.get(e.leadId).push(e);
  }

  const out = [];
  for (const [leadId, evs] of porLead.entries()) {
    const lead = leadsById.get(leadId);
    evs.sort((a, b) => _t(a) - _t(b));
    const add = (tipo, ts, detalle) => {
      if (new Date(ts).getTime() < desde) return;
      out.push({
        tipo, leadId, nombre: lead.nombre || '', telefono: lead.telefono || '',
        ts, detalle, clave: `${tipo}:${leadId}:${ts}`,
      });
    };
    const enviados = evs.filter(_enviado);

    // duplicado: mensajes casi iguales en menos de 10 min entre uno y el siguiente
    const grupos = [];
    for (const e of enviados) {
      const txt = (e.meta && e.meta.preview) || '';
      const g = grupos.find((x) => _t(e) - x.ultimo <= VENTANA_DUPLICADO && casiIguales(x.texto, txt));
      if (g) { g.n++; g.ultimo = _t(e); } else grupos.push({ ts: e.ts, texto: txt, n: 1, ultimo: _t(e) });
    }
    for (const g of grupos) {
      if (g.n >= 2) add('duplicado', g.ts, `×${g.n} en ${Math.max(1, Math.round((g.ultimo - _t(g)) / MIN))} min: "${_corta(g.texto)}"`);
    }

    // landing_doble: el enlace de la landing (pages.dev) dos veces en 1 hora
    const landings = enviados.filter((e) => /pages\.dev/i.test((e.meta && e.meta.preview) || ''));
    let grupoL = null;
    const gruposL = [];
    for (const e of landings) {
      if (grupoL && _t(e) - grupoL.ultimo <= VENTANA_LANDING) { grupoL.n++; grupoL.ultimo = _t(e); }
      else { grupoL = { ts: e.ts, n: 1, ultimo: _t(e) }; gruposL.push(grupoL); }
    }
    for (const g of gruposL) {
      if (g.n >= 2) add('landing_doble', g.ts, `Landing enviada ${g.n} veces en ${Math.max(1, Math.round((g.ultimo - _t(g)) / MIN))} min`);
    }

    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const m = e.meta || {};
      const t = _t(e);

      // descarte_tras_recordatorio: pasa a descartado < 2 h después de un
      // recordatorio por plantilla. No cuenta si el motivo fue real (baja o
      // número sin WhatsApp) ni si lo forzaste tú a mano.
      if (e.type === 'state_changed' && m.to === 'descartado' && !m.force) {
        const motivoReal = evs.some((x) => (x.type === 'opt_out' || x.type === 'sin_whatsapp') && Math.abs(_t(x) - t) <= MIN);
        const rec = !motivoReal && enviados.slice().reverse().find((x) =>
          _t(x) <= t && t - _t(x) <= VENTANA_DESCARTE &&
          String((x.meta && x.meta.preview) || '').startsWith('[plantilla recordatorio'));
        if (rec) add('descarte_tras_recordatorio', e.ts, `Descartado ${Math.round((t - _t(rec)) / MIN)} min después de "${_corta(rec.meta.preview, 80)}"`);
      }

      // pide_humano: el lead insiste en hablar con una persona
      if (e.type === 'pide_humano') add('pide_humano', e.ts, `"${_corta(m.texto, 200)}"`);

      // error_envio: Meta rechazó el envío o no llegó al móvil
      if (e.type === 'message_sent' && m.ok === false) {
        add('error_envio', e.ts, `Rechazado por Meta${m.code ? ` [${m.code}]` : ''}${m.error ? ` — ${_corta(m.error, 120)}` : ''} · "${_corta(m.preview, 80)}"`);
      }
      if (e.type === 'message_status' && m.status === 'failed') {
        add('error_envio', e.ts, `No llegó al móvil${m.code ? ` [${m.code}]` : ''}${m.error ? ` — ${_corta(m.error, 120)}` : ''}`);
      }

      // sin_respuesta: escribió y en 30 min no salió nada. Solo se mira el
      // último mensaje de cada ráfaga, y no cuentan las respuestas automáticas
      // de empresas, las bajas ni los silencios decididos por el router.
      if (e.type === 'message_received' && lead.estado !== 'descartado' && ahora - t >= VENTANA_RESPUESTA) {
        const siguienteRecibido = evs.find((x, j) => j > i && x.type === 'message_received');
        if (siguienteRecibido && _t(siguienteRecibido) - t <= VENTANA_RESPUESTA) continue;
        const ignorar = evs.some((x) => _t(x) >= t && _t(x) - t <= 2 * MIN && (
          x.type === 'auto_respuesta' || x.type === 'opt_out' ||
          (x.type === 'router_decision' && x.meta && x.meta.accion === 'silencio')));
        if (ignorar) continue;
        const contestado = enviados.some((x) => _t(x) >= t && _t(x) - t <= VENTANA_RESPUESTA);
        if (!contestado) add('sin_respuesta', e.ts, `"${_corta(m.texto, 200)}"`);
      }
    }
  }

  return out.sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

module.exports = {
  normalizar,
  casiIguales,
  calcular,
  leerResueltas,
  marcarResuelta,
  RESUELTAS_FILE,
};
