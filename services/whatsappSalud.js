const axios = require('axios');
const config = require('../config/config');

/**
 * Salud del número de WhatsApp (lo mismo que scripts/check-whatsapp.js, pero
 * visible en el CRM). Pregunta a Meta por la CALIDAD del número y su límite de
 * mensajería, y si hay WHATSAPP_WABA_ID, por las entregas de los últimos días.
 * Le suma lo que ve el propio CRM (acuses entregado / leído / fallido y bajas).
 *
 * Calidad (la pone Meta según bloqueos y denuncias de los destinatarios):
 *   GREEN  → entrega normal
 *   YELLOW → Meta vigila: bajar el ritmo
 *   RED    → Meta limita la entrega: parar y dejar descansar el número
 *
 * Se cachea 10 min para no consultar Meta en cada refresco del panel.
 */

const CACHE_MS = 10 * 60 * 1000;
let _cache = null;

const CALIDAD = {
  GREEN: { nivel: 'verde', texto: 'Buena: Meta entrega con normalidad' },
  YELLOW: { nivel: 'amarilla', texto: 'Media: Meta empieza a vigilar el número' },
  RED: { nivel: 'roja', texto: 'Mala: Meta está limitando la entrega' },
  UNKNOWN: { nivel: 'sin datos', texto: 'Aún sin calificación (pocos envíos)' },
};

const LIMITES = {
  TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null,
};

async function _meta() {
  const { apiUrl, phoneNumberId, accessToken, wabaId } = config.whatsapp;
  if (!phoneNumberId || !accessToken) {
    return { configurado: false, error: 'Faltan WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN en Seenode' };
  }
  const API = apiUrl.replace(/\/$/, '');
  const out = { configurado: true };
  try {
    const fields = 'verified_name,display_phone_number,quality_rating,messaging_limit_tier,status,name_status';
    const { data } = await axios.get(`${API}/${phoneNumberId}`, {
      params: { fields, access_token: accessToken },
      timeout: 15000,
    });
    out.numero = data.display_phone_number || null;
    out.nombre = data.verified_name || null;
    out.estadoNumero = data.status || null;
    out.estadoNombre = data.name_status || null;
    out.calidadMeta = data.quality_rating || 'UNKNOWN';
    out.limiteTier = data.messaging_limit_tier || null;
    out.limiteDia = data.messaging_limit_tier in LIMITES ? LIMITES[data.messaging_limit_tier] : null;
  } catch (err) {
    const e = err.response && err.response.data && err.response.data.error;
    out.error = e ? `Meta ${e.code}: ${e.message}` : err.message;
    if (e && e.code === 190) out.error += ' (el token no vale o ha caducado)';
    return out;
  }

  // Entregas según Meta (últimos 3 días) — necesita el WABA ID
  if (wabaId) {
    try {
      const fin = Math.floor(Date.now() / 1000);
      const ini = fin - 3 * 24 * 3600;
      const { data } = await axios.get(`${API}/${wabaId}`, {
        params: { fields: `analytics.start(${ini}).end(${fin}).granularity(DAY)`, access_token: accessToken },
        timeout: 15000,
      });
      const puntos = (data.analytics && data.analytics.data_points) || [];
      out.entregaMeta = puntos.map((p) => ({
        dia: new Date((p.end - 1) * 1000).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'short' }),
        enviados: p.sent || 0,
        entregados: p.delivered || 0,
      }));
    } catch (err) {
      const e = err.response && err.response.data && err.response.data.error;
      out.entregaMetaError = e ? e.message : err.message;
    }
  }
  return out;
}

/** Lo que ve el CRM en los últimos `dias` (acuses de Meta por webhook y bajas). */
function _crm(dias = 3) {
  const activityLog = require('./activityLog');
  const desde = Date.now() - dias * 24 * 3600 * 1000;
  const r = { dias, enviados: 0, rechazados: 0, entregados: 0, leidos: 0, fallidos: 0, sinWhatsapp: 0, bajas: 0 };
  for (const e of activityLog.getRecentActivity(10000)) {
    const t = new Date(e.ts).getTime();
    if (isNaN(t) || t < desde) continue;
    const m = e.meta || {};
    if (e.type === 'message_sent' && !m.manual) { if (m.ok === false) r.rechazados++; else r.enviados++; }
    else if (e.type === 'message_status') {
      if (m.status === 'delivered') r.entregados++;
      else if (m.status === 'read') r.leidos++;
      else if (m.status === 'failed') r.fallidos++;
    } else if (e.type === 'sin_whatsapp') r.sinWhatsapp++;
    else if (e.type === 'opt_out') r.bajas++;
  }
  return r;
}

function _veredicto(meta, crm, cupoTotal) {
  const bloqueo = require('./scheduler').getBloqueo();
  if (bloqueo) return { nivel: 'rojo', texto: `ENVÍOS PARADOS desde ${new Date(bloqueo.desde).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}: ${bloqueo.motivo} (Meta ${bloqueo.code}). Arréglalo en Meta y pulsa «Reanudar envíos» en el panel de la lista.` };
  const cal = meta.calidadMeta;
  if (!meta.configurado) return { nivel: 'gris', texto: 'Sin credenciales de Meta: no se puede consultar la calidad.' };
  if (meta.error) return { nivel: 'gris', texto: `No se pudo consultar Meta: ${meta.error}` };
  if (cal === 'RED') return { nivel: 'rojo', texto: 'Número PENALIZADO. Pausa todas las campañas, deja descansar el número 24-48 h y vuelve muy despacio (5/día).' };
  if (cal === 'YELLOW') return { nivel: 'amarillo', texto: `Meta vigila el número. Baja el ritmo (10/día en total) y mira las bajas. Ahora mismo el cupo total es ${cupoTotal}/día.` };
  const avisos = [];
  if (meta.limiteDia && cupoTotal > meta.limiteDia) avisos.push(`el cupo total (${cupoTotal}/día) supera el límite de Meta (${meta.limiteDia}/día)`);
  const base = crm.entregados + crm.leidos + crm.fallidos;
  if (base >= 10 && crm.fallidos / base > 0.2) avisos.push(`${crm.fallidos} de ${base} mensajes no llegaron en ${crm.dias} días`);
  if (crm.enviados >= 20 && crm.bajas / crm.enviados > 0.05) avisos.push(`${crm.bajas} bajas de ${crm.enviados} envíos (más del 5%)`);
  if (avisos.length) return { nivel: 'amarillo', texto: `Calidad buena, pero ojo: ${avisos.join('; ')}.` };
  if (cal === 'GREEN') return { nivel: 'verde', texto: `Todo bien. Se puede mantener el ritmo actual (${cupoTotal}/día).` };
  return { nivel: 'gris', texto: 'Sin calificación de Meta todavía: empieza con pocos y vigila las entregas.' };
}

async function estado({ forzar = false } = {}) {
  if (!forzar && _cache && Date.now() - _cache.ts < CACHE_MS) {
    return { ..._cache.data, crm: _crm(3), cacheHaceMin: Math.round((Date.now() - _cache.ts) / 60000) };
  }
  const meta = await _meta();
  const cupoTotal = require('./scheduler').getLeadsPorDia();
  const crm = _crm(3);
  const data = {
    consultado: new Date().toISOString(),
    ...meta,
    calidad: CALIDAD[meta.calidadMeta] || (meta.calidadMeta ? { nivel: meta.calidadMeta, texto: '' } : null),
    cupoTotal,
    veredicto: _veredicto(meta, crm, cupoTotal),
  };
  _cache = { ts: Date.now(), data };
  return { ...data, crm, cacheHaceMin: 0 };
}

module.exports = { estado };
