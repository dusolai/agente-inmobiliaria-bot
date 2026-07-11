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

// El indicador "escribiendo…" de la API oficial solo se puede mandar como
// respuesta a un mensaje recibido; lo omitimos para simplificar.
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

/**
 * Envía una plantilla aprobada. Para el primer contacto y cualquier envío
 * fuera de la ventana de 24h.
 * @param {string} to
 * @param {string[]} bodyParams  valores para las variables {{1}}, {{2}}... del cuerpo
 * @param {object} [opts] { name, lang }  (por defecto, los de la config)
 */
async function sendTemplate(to, bodyParams = [], opts = {}) {
  const name = opts.name || config.whatsapp.templateName;
  const lang = opts.lang || config.whatsapp.templateLang;
  if (!name) {
    console.error('❌ [WhatsAppCloud] No hay WHATSAPP_TEMPLATE_NAME: no puedo enviar el primer contacto');
    return { success: false, mode: 'production', error: 'sin plantilla configurada' };
  }
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : [];
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
  sendTypingAction,
  isConfigured,
  getLatestQr,
};
