const axios = require('axios');
const config = require('../config/config');
const messages = require('../templates/messages');

/**
 * Plantillas de WhatsApp en Meta, gestionadas desde el CRM (sin entrar en
 * WhatsApp Manager). Usa el mismo token y la misma cuenta (WABA) con los que
 * el sistema envía, así que se crean justo donde hacen falta.
 *
 *   listar()      → todas las plantillas de la cuenta con su estado
 *   requeridas()  → las que necesita el lanzamiento y si existen / su estado
 *   crear(clave)  → la da de alta en Meta (queda "PENDING" hasta que Meta la
 *                   revise, de minutos a 24 h)
 *
 * Formato: variable CON NOMBRE {{nombre}} (parameter_format NAMED), categoría
 * MARKETING, español, y 3 botones de respuesta rápida (el tercero, "No me
 * interesa", da de baja: evita bloqueos).
 */

function _api() { return config.whatsapp.apiUrl.replace(/\/$/, ''); }
function _waba() { return config.whatsapp.wabaId; }
function _err(err) {
  const e = err.response && err.response.data && err.response.data.error;
  return e ? `Meta ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.error_user_msg || e.message}` : err.message;
}

// Qué plantillas necesita el lanzamiento: clave → variable de Seenode
const REQUERIDAS = [
  { clave: 'viejos', variable: 'WHATSAPP_TEMPLATE_VIEJOS', para: 'Campaña Viejos (dic-jun)' },
  { clave: 'verano', variable: 'WHATSAPP_TEMPLATE_VERANO', para: 'Campaña Verano (jul-ago)' },
  { clave: 'septiembre', variable: 'WHATSAPP_TEMPLATE_SEPTIEMBRE', para: 'Campaña Septiembre' },
  { clave: 'directo', variable: 'WHATSAPP_TEMPLATE_DIRECTO', para: 'Nuevos en directo' },
  { clave: 'recordatorio', variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_CUALIFICACION', para: 'Recordatorio único (todas)' },
  { clave: 'recordatorio_presentacion', variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_PRESENTACION', para: 'Recordatorio: no terminó la presentación' },
  { clave: 'recordatorio_sesion', variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_SESION', para: 'Recordatorio: no se apuntó a la sesión' },
  { clave: 'sesion_preparacion', variable: 'WHATSAPP_TEMPLATE_SESION_PREPARACION', para: 'Sesión reservada: ¿has visto la presentación?' },
  { clave: 'sesion_hoy', variable: 'WHATSAPP_TEMPLATE_SESION_HOY', para: 'Sesión reservada: aviso del mismo día (confirmar)' },
  { clave: 'sesion_huecos', variable: 'WHATSAPP_TEMPLATE_SESION_HUECOS', para: 'Repesca: huecos de la semana a quien ya dijo su perfil' },
  { clave: 'sesion_zoom', variable: 'WHATSAPP_TEMPLATE_SESION_ZOOM', para: 'Sesión reservada: acceso al Zoom (botón de enlace)' },
];

async function listar() {
  if (!_waba() || !config.whatsapp.accessToken) {
    return { ok: false, error: 'Faltan WHATSAPP_WABA_ID / WHATSAPP_ACCESS_TOKEN en Seenode' };
  }
  try {
    const out = [];
    let url = `${_api()}/${_waba()}/message_templates`;
    let params = { fields: 'name,status,language,category,rejected_reason,quality_score,components', limit: 100, access_token: config.whatsapp.accessToken };
    for (let i = 0; i < 5 && url; i++) {
      const { data } = await axios.get(url, { params, timeout: 15000 });
      out.push(...(data.data || []));
      url = data.paging && data.paging.next ? data.paging.next : null;
      params = undefined; // el "next" ya trae los parámetros
    }
    return {
      ok: true,
      plantillas: out.map((t) => {
        const body = (t.components || []).find((c) => c.type === 'BODY');
        const btns = (t.components || []).find((c) => c.type === 'BUTTONS');
        return {
          name: t.name, status: t.status, language: t.language, category: t.category,
          rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
          calidad: t.quality_score && t.quality_score.score ? t.quality_score.score : null,
          texto: body ? body.text : '',
          botones: btns ? (btns.buttons || []).map((b) => b.text) : [],
        };
      }),
    };
  } catch (err) {
    return { ok: false, error: _err(err) };
  }
}

// Dónde vive en config la plantilla de cada clave (las de segmento, en
// templatesPorSegmento[clave]).
const CLAVE_CONFIG = {
  recordatorio: 'templateRecordatorioCualificacion',
  recordatorio_presentacion: 'templateRecordatorioPresentacion',
  recordatorio_sesion: 'templateRecordatorioSesion',
  sesion_preparacion: 'templateSesionPreparacion',
  sesion_hoy: 'templateSesionHoy',
  sesion_huecos: 'templateSesionHuecos',
  sesion_zoom: 'templateSesionZoom',
};
function _configurada(clave) {
  const k = CLAVE_CONFIG[clave];
  return k ? config.whatsapp[k] : (config.whatsapp.templatesPorSegmento || {})[clave];
}
function _configurar(clave, nombre) {
  const k = CLAVE_CONFIG[clave];
  if (k) config.whatsapp[k] = nombre;
  else {
    config.whatsapp.templatesPorSegmento = config.whatsapp.templatesPorSegmento || {};
    config.whatsapp.templatesPorSegmento[clave] = nombre;
  }
}

/**
 * Activación automática (19-10): cada plantilla que Meta tiene APROBADA con
 * su nombre sugerido se usa aunque la variable de Seenode esté vacía. Antes,
 * una plantilla aprobada se quedaba sin usar hasta que alguien añadía la
 * variable a mano (los recordatorios de la sesión estuvieron días parados
 * así). La variable de Seenode, si existe, manda. Se refresca cada hora.
 */
const _automaticas = new Set();
let _ultimaActivacion = 0;
async function activarAprobadas({ forzar = false } = {}) {
  if (!forzar && Date.now() - _ultimaActivacion < 60 * 60 * 1000) return { ok: true, activadas: [] };
  const l = await listar();
  if (!l.ok) return { ok: false, error: l.error };
  _ultimaActivacion = Date.now();
  const porNombre = new Map(l.plantillas.map((t) => [t.name, t]));
  const activadas = [];
  for (const r of REQUERIDAS) {
    const def = messages.PLANTILLAS_META[r.clave];
    const t = porNombre.get(def.nombreSugerido);
    if (t && t.status === 'APPROVED' && !_configurada(r.clave)) {
      _configurar(r.clave, def.nombreSugerido);
      _automaticas.add(r.clave);
      activadas.push(def.nombreSugerido);
    }
  }
  if (activadas.length) console.log(`📝 [Plantillas] Activadas automáticamente (aprobadas en Meta, sin variable en Seenode): ${activadas.join(', ')}`);
  return { ok: true, activadas };
}

async function requeridas() {
  const l = await listar();
  const porNombre = new Map(((l.ok && l.plantillas) || []).map((t) => [t.name, t]));
  return {
    ok: l.ok,
    error: l.error,
    todas: l.plantillas || [],
    requeridas: REQUERIDAS.map((r) => {
      const def = messages.PLANTILLAS_META[r.clave];
      const enMeta = porNombre.get(def.nombreSugerido) || null;
      const enSeenode = _configurada(r.clave);
      return {
        ...r,
        nombre: def.nombreSugerido,
        cuerpo: def.cuerpo,
        botones: def.botones || messages.PLANTILLAS_META.botones,
        enMeta: enMeta ? { status: enMeta.status, rejected_reason: enMeta.rejected_reason, language: enMeta.language } : null,
        enSeenode: enSeenode || null,
        seenodeOk: enSeenode === def.nombreSugerido,
        // true cuando se activó sola al verla aprobada en Meta (sin variable)
        automatica: _automaticas.has(r.clave),
      };
    }),
  };
}

async function crear(clave) {
  const r = REQUERIDAS.find((x) => x.clave === clave);
  const def = r && messages.PLANTILLAS_META[clave];
  if (!def) return { ok: false, error: `Plantilla desconocida: ${clave}` };
  if (!_waba() || !config.whatsapp.accessToken) return { ok: false, error: 'Faltan WHATSAPP_WABA_ID / WHATSAPP_ACCESS_TOKEN en Seenode' };
  const body = {
    name: def.nombreSugerido,
    language: 'es',
    category: 'MARKETING',
    parameter_format: 'NAMED',
    components: [
      {
        type: 'BODY',
        text: def.cuerpo,
        example: { body_text_named_params: (def.variables || [{ nombre: 'nombre', ejemplo: 'María' }]).map((v) => ({ param_name: v.nombre, example: v.ejemplo })) },
      },
      {
        type: 'BUTTONS',
        // Botón de enlace con sufijo variable (Zoom) o botones de respuesta rápida
        buttons: def.botonUrl
          ? [{ type: 'URL', text: def.botonUrl.texto, url: `${def.botonUrl.base}{{1}}`, example: [def.botonUrl.ejemplo] }]
          : (def.botones || messages.PLANTILLAS_META.botones).map((t) => ({ type: 'QUICK_REPLY', text: t })),
      },
    ],
  };
  try {
    const { data } = await axios.post(`${_api()}/${_waba()}/message_templates`, body, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    console.log(`📝 [Plantillas] Creada en Meta: ${def.nombreSugerido} (${data.status || 'PENDING'})`);
    return { ok: true, id: data.id, status: data.status || 'PENDING', nombre: def.nombreSugerido };
  } catch (err) {
    const e = _err(err);
    console.error(`❌ [Plantillas] No se pudo crear ${def.nombreSugerido}: ${e}`);
    return { ok: false, error: e };
  }
}

module.exports = { listar, requeridas, crear, activarAprobadas, REQUERIDAS };
