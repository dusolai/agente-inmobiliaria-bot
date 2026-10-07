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
  // Estado del número y del nombre visible: antes que la calidad. Con el
  // número sin conectar o el nombre rechazado, Meta no entrega (o limita).
  if (meta.estadoNumero && meta.estadoNumero !== 'CONNECTED') {
    const extra = meta.estadoNombre === 'DECLINED'
      ? ' Meta ha RECHAZADO el nombre visible: cámbialo en WhatsApp Manager por uno que coincida con el negocio (p. ej. "Three Inmobiliaria") y espera la aprobación.'
      : '';
    return { nivel: 'rojo', texto: `El número NO está activo en Meta (estado ${meta.estadoNumero}). No reanudes campañas hasta que salga CONNECTED.${extra}` };
  }
  if (meta.estadoNombre === 'DECLINED') {
    return { nivel: 'amarillo', texto: 'Meta ha RECHAZADO el nombre visible del número. Cámbialo en WhatsApp Manager por uno que coincida con el negocio y espera la aprobación antes de lanzar.' };
  }
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

// ─── Diagnóstico completo del número (cuando algo no va) ─────────
// health_status es lo más útil que da Meta: dice si el número PUEDE enviar
// y, si no, por qué y cómo arreglarlo (texto de Meta). Las peticiones van
// por separado para que un campo no permitido no tire las demás.
function _get(path, params) {
  const { apiUrl, accessToken } = config.whatsapp;
  const API = apiUrl.replace(/\/$/, '');
  return axios.get(`${API}/${path}`, { params: { ...(params || {}), access_token: accessToken }, timeout: 15000 })
    .then((r) => ({ data: r.data }))
    .catch((err) => {
      const e = err.response && err.response.data && err.response.data.error;
      return { error: e ? `Meta ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.message}` : err.message };
    });
}
function _post(path, body) {
  const { apiUrl, accessToken } = config.whatsapp;
  const API = apiUrl.replace(/\/$/, '');
  return axios.post(`${API}/${path}`, body, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000 })
    .then((r) => ({ ok: true, data: r.data }))
    .catch((err) => {
      const e = err.response && err.response.data && err.response.data.error;
      return { ok: false, error: e ? `Meta ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.message}${e.error_user_msg ? ' — ' + e.error_user_msg : ''}` : err.message };
    });
}

async function diagnostico() {
  const { phoneNumberId, accessToken, wabaId, verifyToken } = config.whatsapp;
  const out = { consultado: new Date().toISOString(), phoneNumberId: phoneNumberId || null, wabaId: wabaId || null, webhookEsperado: `${config.backendPublicUrl.replace(/\/$/, '')}/webhook/whatsapp`, verifyTokenConfigurado: Boolean(verifyToken) };
  if (!phoneNumberId || !accessToken) { out.error = 'Faltan WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN en Seenode'; return out; }
  const [basico, extra, salud, webhookCfg] = await Promise.all([
    _get(phoneNumberId, { fields: 'verified_name,display_phone_number,status,name_status,code_verification_status,quality_rating,messaging_limit_tier,platform_type' }),
    _get(phoneNumberId, { fields: 'new_name_status,new_display_name,account_mode,is_pin_enabled,last_onboarded_time,is_official_business_account' }),
    _get(phoneNumberId, { fields: 'health_status' }),
    _get(phoneNumberId, { fields: 'webhook_configuration' }),
  ]);
  out.numero = Object.assign({}, basico.data || {}, extra.data || {});
  if (basico.error) out.numeroError = basico.error;
  out.health = salud.data ? salud.data.health_status : null;
  if (salud.error) out.healthError = salud.error;
  out.webhookNumero = webhookCfg.data ? webhookCfg.data.webhook_configuration : null;
  if (wabaId) {
    const [cuenta, apps, numeros] = await Promise.all([
      _get(wabaId, { fields: 'name,account_review_status,business_verification_status,ownership_type,country' }),
      _get(`${wabaId}/subscribed_apps`),
      _get(`${wabaId}/phone_numbers`, { fields: 'display_phone_number,status,name_status,quality_rating,code_verification_status' }),
    ]);
    out.cuenta = cuenta.data || null; if (cuenta.error) out.cuentaError = cuenta.error;
    out.appsSuscritas = apps.data ? (apps.data.data || []) : null; if (apps.error) out.appsError = apps.error;
    out.numerosDeLaCuenta = numeros.data ? (numeros.data.data || []) : null; if (numeros.error) out.numerosError = numeros.error;
  }
  // Resumen en una frase
  const n = out.numero || {};
  const puede = out.health && out.health.can_send_message;
  const problemas = [];
  if (n.status && n.status !== 'CONNECTED') problemas.push(`número en estado ${n.status} (debe ser CONNECTED)`);
  if (n.code_verification_status && n.code_verification_status !== 'VERIFIED') problemas.push(`verificación del número: ${n.code_verification_status}`);
  if (n.name_status === 'DECLINED') problemas.push('nombre visible RECHAZADO por Meta');
  if (out.appsSuscritas && out.appsSuscritas.length === 0) problemas.push('la app NO está suscrita al webhook de la cuenta (no entra ningún mensaje)');
  if (out.cuenta && out.cuenta.account_review_status && out.cuenta.account_review_status !== 'APPROVED') problemas.push(`revisión de la cuenta: ${out.cuenta.account_review_status}`);
  if (out.health && Array.isArray(out.health.entities)) {
    for (const ent of out.health.entities) {
      for (const er of ent.errors || []) problemas.push(`${ent.entity_type}: ${er.error_description}${er.possible_solution ? ' → ' + er.possible_solution : ''}`);
    }
  }
  out.puedeEnviar = puede === 'AVAILABLE' ? true : (puede ? false : null);
  out.problemas = problemas;
  out.resumen = problemas.length ? problemas.join(' · ') : (out.puedeEnviar === false ? `Meta dice que el número no puede enviar (${puede})` : 'Sin problemas detectados');
  _cache = null; // la próxima lectura de salud, fresca
  return out;
}

/**
 * Registra el número en la Cloud API (arregla el 133010 "Account not
 * registered" y el estado PENDING). Necesita el PIN de 6 cifras de la
 * verificación en dos pasos del número (si no estaba activada, este PIN la
 * activa). Es la llamada oficial POST /{phone_number_id}/register.
 */
async function registrar(pin) {
  const { phoneNumberId } = config.whatsapp;
  const p = String(pin || '').trim();
  if (!/^\d{6}$/.test(p)) return { ok: false, error: 'El PIN debe tener 6 cifras' };
  const r = await _post(`${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin: p });
  _cache = null;
  console.log(r.ok ? '✅ [WhatsApp] Número registrado en la Cloud API' : `❌ [WhatsApp] Registro rechazado: ${r.error}`);
  return r;
}

/** Vuelve a suscribir la app al webhook de la cuenta (idempotente). */
async function suscribirWebhook() {
  const { wabaId } = config.whatsapp;
  if (!wabaId) return { ok: false, error: 'Falta WHATSAPP_WABA_ID en Seenode' };
  const r = await _post(`${wabaId}/subscribed_apps`, {});
  console.log(r.ok ? '✅ [WhatsApp] App suscrita al webhook de la cuenta' : `❌ [WhatsApp] No se pudo suscribir: ${r.error}`);
  return r;
}

module.exports = { estado, diagnostico, registrar, suscribirWebhook };
