const axios = require('axios');
const config = require('../config/config');

/**
 * Canal WhatsApp con la API oficial (Cloud API de Meta / Graph API).
 *
 * A diferencia de Baileys, aquí NO hay QR ni sesión que se caiga: es HTTP
 * puro contra los servidores de Meta con un token permanente. Meta no
 * "banea" como Baileys; regula por calidad. Requiere:
 *   - WHATSAPP_PHONE_NUMBER_ID  (id del número en la app de Meta)
 *   - WHATSAPP_ACCESS_TOKEN     (token permanente del System User)
 *   - WHATSAPP_VERIFY_TOKEN     (el que tú inventes para el webhook)
 *   - WHATSAPP_TEMPLATE_NAME    (plantilla aprobada para el 1er mensaje)
 *
 * Reglas de WhatsApp que este módulo respeta:
 *   - El PRIMER mensaje (o cualquiera fuera de la ventana de 24h desde el
 *     último mensaje del lead) debe ser una PLANTILLA aprobada → sendTemplate.
 *   - Dentro de las 24h desde que el lead escribe, se puede mandar texto
 *     libre → sendTextMessage.
 */

const API = config.whatsapp.apiUrl.replace(/\/$/, '');
const PHONE_ID = config.whatsapp.phoneNumberId;
const TOKEN = config.whatsapp.accessToken;

// Solo dígitos para el destinatario (E.164 sin '+')
function _numero(to) {
  return String(to).replace(/[^\d]/g, '');
}

function _headers() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function initialize() {
  if (!isConfigured()) {
    console.warn('⚠️  [WhatsAppCloud] Faltan credenciales (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN). El canal no enviará.');
    return;
  }
  console.log('☁️  [WhatsAppCloud] API oficial de Meta activa. Sin QR: envío por HTTP.');
  if (!config.whatsapp.templateName) {
    console.warn('⚠️  [WhatsAppCloud] WHATSAPP_TEMPLATE_NAME sin definir: el primer contacto (plantilla) fallará hasta configurarlo.');
  }
}

// Con la API oficial, "configurado" = tenemos credenciales. Es sin estado:
// no hay conexión que se caiga, así que si hay credenciales, está listo.
function isConfigured() {
  return Boolean(PHONE_ID && TOKEN);
}

// No hay QR en la API oficial.
function getLatestQr() {
  return null;
}

// El indicador "escribiendo…" en la API oficial se manda marcando como leído
// el mensaje entrante + typing_indicator. Se muestra hasta 25s o hasta que
// enviamos la respuesta. Como ahora el LLM tarda un poco en contestar, esto
// hace que el lead vea "escribiendo…" mientras tanto (como una persona real).
// Necesita el ID del mensaje entrante (lo pasa el webhook).
async function sendTyping(messageId) {
  if (!isConfigured() || !messageId) return;
  try {
    await axios.post(
      `${API}/${PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers: _headers(), timeout: 8000 }
    );
  } catch (err) {
    // El typing es opcional: si falla, no rompemos nada.
  }
}

// Compatibilidad con la interfaz de Baileys (que recibe el teléfono). En la
// API oficial el typing necesita el ID del mensaje, así que aquí no hace nada;
// el webhook llama a sendTyping(messageId) directamente.
async function sendTypingAction() {
  return;
}

async function _post(payload, tipo) {
  const to = payload.to;
  if (!isConfigured()) {
    console.log(`📲 [WhatsAppCloud DEV] → ${to} (sin credenciales, no enviado)`);
    return { success: true, mode: 'development', to };
  }
  try {
    const res = await axios.post(`${API}/${PHONE_ID}/messages`, payload, {
      headers: _headers(),
      timeout: 15000,
    });
    const id = res.data?.messages?.[0]?.id;
    console.log(`✅ [WhatsAppCloud] ${tipo} enviado a ${to} (id ${id || '?'})`);
    return { success: true, mode: 'production', id };
  } catch (err) {
    const meta = err.response?.data?.error;
    const codigo = meta?.code;
    // 131047 = fuera de la ventana de 24h (hay que usar plantilla)
    // 131026 = el número no tiene WhatsApp / no se puede entregar
    const detalle = meta ? `${meta.code} ${meta.message}` : err.message;
    console.error(`❌ [WhatsAppCloud] Error enviando ${tipo} a ${to}: ${detalle}`);
    return { success: false, mode: 'production', error: detalle, code: codigo };
  }
}

/**
 * Envía texto libre. Solo válido dentro de la ventana de 24h desde el último
 * mensaje del lead. Fuera de ella Meta devuelve error 131047 → usar plantilla.
 */
async function sendTextMessage(to, body) {
  return _post(
    {
      messaging_product: 'whatsapp',
      to: _numero(to),
      type: 'text',
      text: { body: String(body), preview_url: true },
    },
    'texto'
  );
}

// ─── Texto real de las plantillas aprobadas ───────────────────────
// El CRM debe mostrar lo que RECIBE el lead. Antes registraba un texto de
// reserva que no se enviaba (el de Baileys), así que el panel enseñaba un
// mensaje distinto del real. Leemos de Meta el cuerpo aprobado (una vez, en
// caché) para poder registrar el texto exacto.
let _plantillas = null;
async function _cargarPlantillas() {
  if (_plantillas) return _plantillas;
  const waba = config.whatsapp.wabaId;
  if (!waba || !config.whatsapp.accessToken) return null;
  try {
    const { data } = await axios.get(
      `${API}/${waba}/message_templates?limit=50&access_token=${encodeURIComponent(config.whatsapp.accessToken)}`,
      { timeout: 10000 }
    );
    _plantillas = {};
    for (const t of data.data || []) {
      const body = (t.components || []).find((c) => c.type === 'BODY');
      const btns = (t.components || []).find((c) => c.type === 'BUTTONS');
      if (body && body.text) {
        _plantillas[`${t.name}|${t.language}`] = {
          texto: body.text,
          // Los botones también los ve el lead: se muestran en el chat del CRM
          // para que sea idéntico a lo que tiene él en WhatsApp.
          botones: ((btns && btns.buttons) || []).map((b) => b.text).filter(Boolean),
        };
      }
    }
    console.log(`📋 [WhatsAppCloud] ${Object.keys(_plantillas).length} plantillas leídas de Meta`);
    return _plantillas;
  } catch (err) {
    console.warn('⚠️  [WhatsAppCloud] No pude leer las plantillas de Meta:', err.message);
    return null;
  }
}

/**
 * Devuelve el texto REAL de una plantilla con las variables sustituidas, o
 * null si no se puede leer. Soporta variables numeradas ({{1}}) y con nombre
 * ({{nombre}}) — el editor nuevo de Meta usa unas u otras según la plantilla.
 */
async function renderTemplate(name, lang, params = []) {
  const tpl = await _cargarPlantillas();
  const p = tpl && tpl[`${name}|${lang}`];
  if (!p || !p.texto) return null;
  let out = p.texto;
  params.forEach((v, i) => { out = out.split(`{{${i + 1}}}`).join(String(v)); });
  if (params.length) out = out.replace(/\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/gi, String(params[0]));
  return out;
}

/** Botones de una plantilla aprobada (los que ve el lead), o [] si no hay. */
async function getTemplateBotones(name, lang) {
  const tpl = await _cargarPlantillas();
  const p = tpl && tpl[`${name}|${lang}`];
  return (p && p.botones) || [];
}

// Devuelve los NOMBRES de las variables de una plantilla en el orden en que
// aparecen: ["1","2"] si son numeradas, ["nombre"] si tiene nombre. Vacío si no
// se puede leer (sin WABA_ID). Sirve para mandar el formato que Meta exige.
async function getTemplateVars(name, lang) {
  const tpl = await _cargarPlantillas();
  const p = tpl && tpl[`${name}|${lang}`];
  if (!p || !p.texto) return [];
  const matches = p.texto.match(/\{\{\s*([^}]+?)\s*\}\}/g) || [];
  return matches.map((m) => m.replace(/[{}]/g, '').trim());
}

/**
 * Envía una plantilla aprobada. Para el primer contacto y cualquier envío
 * fuera de la ventana de 24h.
 *
 * IMPORTANTE — variables con nombre vs numeradas: el editor nuevo de Meta
 * permite variables con NOMBRE ({{nombre}}) además de numeradas ({{1}}). Una
 * plantilla con {{nombre}} EXIGE mandar `parameter_name` en cada parámetro; si
 * se manda en formato posicional Meta la RECHAZA (error 132000). Por eso aquí
 * detectamos el tipo de variable (por `opts.varNames` explícito, o leyendo la
 * plantilla de Meta) y construimos el formato correcto.
 *
 * @param {string} to
 * @param {string[]} bodyParams  valores para las variables del cuerpo, en orden
 * @param {object} [opts] { name, lang, varNames }  (por defecto, los de la config)
 */
async function sendTemplate(to, bodyParams = [], opts = {}) {
  const name = opts.name || config.whatsapp.templateName;
  const lang = opts.lang || config.whatsapp.templateLang;
  if (!name) {
    console.error('❌ [WhatsAppCloud] No hay WHATSAPP_TEMPLATE_NAME: no puedo enviar el primer contacto');
    return { success: false, mode: 'production', error: 'sin plantilla configurada' };
  }

  // Nombres de variables: explícitos (opts.varNames) o leídos de Meta. Si no se
  // pueden averiguar, asumimos numeradas (comportamiento clásico).
  let varNames = opts.varNames;
  if (!varNames) {
    try { varNames = await getTemplateVars(name, lang); } catch (e) { varNames = []; }
  }
  const usaNombres = varNames && varNames.some((v) => !/^\d+$/.test(v));

  let parameters;
  if (usaNombres) {
    // Formato con nombre: cada variable lleva su parameter_name en orden.
    parameters = varNames.map((vn, i) => ({
      type: 'text',
      parameter_name: vn,
      text: String(bodyParams[i] != null ? bodyParams[i] : (bodyParams[0] || '')),
    }));
  } else {
    parameters = bodyParams.map((t) => ({ type: 'text', text: String(t) }));
  }

  const components = parameters.length ? [{ type: 'body', parameters }] : [];
  return _post(
    {
      messaging_product: 'whatsapp',
      to: _numero(to),
      type: 'template',
      template: { name, language: { code: lang }, components },
    },
    `plantilla ${name}`
  );
}

module.exports = {
  initialize,
  sendTextMessage,
  sendTemplate,
  renderTemplate,
  getTemplateBotones,
  getTemplateVars,
  sendTyping,
  sendTypingAction,
  isConfigured,
  getLatestQr,
};
