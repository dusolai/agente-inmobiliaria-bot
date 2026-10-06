/**
 * Dispatcher de mensajería con humanización.
 *
 * - Decide el canal (Telegram o WhatsApp) según el prefijo del lead:
 *     "tg:<chat_id>"  → Telegram
 *     cualquier otro  → WhatsApp (número de teléfono)
 * - Antes de cada envío:
 *     1) Envía indicador de "escribiendo…" al canal.
 *     2) Espera `typingDelaySeconds` (default 10s; configurable por mensaje).
 *     3) Envía el mensaje real.
 *
 * Esto simula una conversación humana — lo pidió Arkaitz en la reunión final.
 */

const config = require('../config/config');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');

const TG_PREFIX = telegram.TG_PREFIX || 'tg:';

// Deja constancia en el CRM de cada mensaje que sale (y de si salió bien).
// require perezoso para evitar ciclos de dependencia en el arranque.
function _registrarEnvio(telefono, text, resultado, extraMeta) {
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (!lead) return;
    activityLog.appendActivity(lead.id, 'message_sent', {
      // Mensaje COMPLETO: en el chat del CRM se ve tal cual le llega al lead.
      // 4096 = el máximo que admite un mensaje de WhatsApp, así que nunca corta.
      preview: String(text).slice(0, 4096),
      ok: resultado ? resultado.success !== false : null,
      modo: resultado && resultado.mode ? resultado.mode : undefined,
      // Si Meta lo rechazó, guardamos el motivo/código para verlo en el CRM
      // (antes solo salía "RECHAZADO POR META" sin decir por qué).
      error: resultado && resultado.success === false ? resultado.error : undefined,
      code: resultado && resultado.code != null ? resultado.code : undefined,
      ...(extraMeta || {}), // p. ej. { manual: true } cuando lo escribes tú desde el CRM
    });
  } catch (e) { /* el registro nunca debe romper un envío */ }
}

function esTelegram(telefono) {
  return typeof telefono === 'string' && telefono.startsWith(TG_PREFIX);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/**
 * Envía un mensaje de texto al lead, con un pequeño delay y el indicador de
 * "escribiendo" antes para que parezca humano.
 *
 * @param {string} telefono            – identificador del lead
 * @param {string} text                – texto del mensaje
 * @param {object} [opts]
 * @param {number} [opts.delaySeconds] – override del delay; null = sin delay
 */
async function sendTextMessage(telefono, text, opts = {}) {
  const delaySeconds = opts.delaySeconds != null ? opts.delaySeconds : config.agent.typingDelaySeconds;
  const conTipping = delaySeconds > 0;

  try {
    let resultado;
    if (esTelegram(telefono)) {
      if (conTipping) {
        await telegram.sendTypingAction(telefono);
        await sleep(delaySeconds * 1000);
      }
      resultado = await telegram.sendMessage(telefono, text);
    } else {
      if (conTipping) {
        await whatsapp.sendTypingAction(telefono);
        await sleep(delaySeconds * 1000);
      }
      resultado = await whatsapp.sendTextMessage(telefono, text);
    }
    _registrarEnvio(telefono, text, resultado, opts.meta);
    return resultado;
  } catch (err) {
    // Si algo falla en el typing, no abortamos el envío del mensaje
    console.error('⚠️  [Messaging] Error con typing, enviando directo:', err.message);
    const resultado = esTelegram(telefono)
      ? await telegram.sendMessage(telefono, text)
      : await whatsapp.sendTextMessage(telefono, text);
    _registrarEnvio(telefono, text, resultado, opts.meta);
    return resultado;
  }
}

/**
 * Envía el PRIMER contacto (la pregunta de filtrado) a un lead.
 *
 * - Con la API oficial (cloud): va como PLANTILLA aprobada, porque WhatsApp
 *   exige plantilla para iniciar conversación. La variable {{1}} es el nombre.
 *   El `textoFallback` (personalizado por LLM, etc.) NO se usa aquí: en cloud
 *   el primer mensaje es la plantilla fija y aprobada.
 * - Con Baileys: va como texto normal (el `textoFallback`), como hasta ahora.
 *
 * @param {object} lead
 * @param {string} textoFallback  texto a usar en Baileys (o si no hay plantilla)
 * @param {object} [opts] { delaySeconds }
 */
// Deja constancia de que a este lead ya se le envió la bienvenida / primer
// contacto, para que si luego escribe "hola" (en vez de responder 1/2) no se
// le repita el mensaje de bienvenida entero.
function _marcarBienvenida(telefono) {
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (lead) activityLog.appendActivity(lead.id, 'welcome_sent', null);
  } catch (e) { /* nunca romper el envío por esto */ }
}

/**
 * Plantilla de Meta para el PRIMER contacto de un lead según su segmento
 * (reunión 01-10: cada segmento tiene su mensaje). Devuelve { name, lang } o
 * null si ese segmento aún no tiene plantilla aprobada (y no se permite usar
 * la genérica): entonces el lead espera en cola, no se le manda otra cosa.
 */
function plantillaParaSegmento(segmento) {
  const seg = segmento || 'viejos';
  const porSeg = config.whatsapp.templatesPorSegmento || {};
  let name = porSeg[seg] || '';
  if (!name && (seg === 'viejos' || config.whatsapp.usarPlantillaGenericaSiFalta)) name = config.whatsapp.templateName;
  if (!name) return null;
  return { name, lang: config.whatsapp.templateLang };
}

async function sendPrimerContacto(lead, textoFallback, opts = {}) {
  const telefono = lead.telefono;
  let resultado;

  // Telegram o Baileys → texto normal
  if (esTelegram(telefono) || whatsapp.provider !== 'cloud') {
    resultado = await sendTextMessage(telefono, textoFallback, opts);
  } else {
    // API oficial → plantilla (sin typing/delay: es un envío server-to-server)
    const nombre = lead.nombre && lead.nombre !== 'Sin nombre' ? lead.nombre : 'hola';
    const plantilla = plantillaParaSegmento(lead.segmento);
    if (!plantilla) {
      const msg = `sin plantilla aprobada para el segmento "${lead.segmento || 'viejos'}" (WHATSAPP_TEMPLATE_${String(lead.segmento || 'viejos').toUpperCase()})`;
      console.warn(`⚠️  [Messaging] ${lead.nombre}: ${msg}`);
      return { success: false, mode: 'sin_plantilla', error: msg };
    }
    try {
      resultado = await whatsapp.sendTemplate(telefono, [nombre], { name: plantilla.name, lang: plantilla.lang });
    } catch (err) {
      console.error('⚠️  [Messaging] Error enviando plantilla:', err.message);
      resultado = { success: false, error: err.message };
    }
    // Registrar EXACTAMENTE lo que recibe el lead: el texto de la plantilla
    // aprobada con el nombre ya sustituido. Antes se guardaba `textoFallback`
    // (el texto de Baileys, que en cloud NO se envía), así que el CRM enseñaba
    // un mensaje distinto del real. Si no se puede leer la plantilla, se deja
    // una etiqueta honesta en vez de inventar un texto.
    let textoReal = null;
    let botones = [];
    try {
      if (typeof whatsapp.renderTemplate === 'function') {
        textoReal = await whatsapp.renderTemplate(plantilla.name, plantilla.lang, [nombre]);
      }
      if (typeof whatsapp.getTemplateBotones === 'function') {
        botones = await whatsapp.getTemplateBotones(plantilla.name, plantilla.lang);
      }
    } catch (e) { /* si falla, etiqueta honesta */ }
    _registrarEnvio(
      telefono,
      textoReal || `[plantilla ${plantilla.name} · texto aprobado en Meta]`,
      resultado,
      { plantilla: plantilla.name, segmento: lead.segmento || null, ...(botones.length ? { botones } : {}) }
    );
  }
  _marcarBienvenida(telefono);
  return resultado;
}

/**
 * Envía una plantilla aprobada (para recordatorios). Wrapper de whatsapp.sendTemplate.
 * @param {string} telefono
 * @param {string[]} params  valores para reemplazar {{1}}, {{nombre}}, etc.
 * @param {object} opts  { name, lang } (plantilla)
 */
async function sendTemplate(telefono, params = [], opts = {}) {
  const resultado = await whatsapp.sendTemplate(telefono, params, opts);
  _registrarEnvio(telefono, `[plantilla ${opts.name || config.whatsapp.templateName}]`, resultado);
  return resultado;
}

/**
 * ¿Está abierta la ventana de 24 h de WhatsApp con este lead? (el lead nos
 * escribió hace menos de 24 h). Fuera de ella Meta NO entrega texto libre
 * (error 131047 "Re-engagement message"): en la campaña de prueba 200
 * mensajes se perdieron así, casi todos el mensaje de despedida.
 * Telegram y Baileys no tienen ventana.
 */
function dentroDeVentana(telefono) {
  if (esTelegram(telefono) || whatsapp.provider !== 'cloud') return true;
  try {
    const leadManager = require('./leadManager');
    const activityLog = require('./activityLog');
    const lead = leadManager.getLeadByPhone(telefono);
    if (!lead) return false;
    const ult = activityLog.getActivityByLead(lead.id)
      .filter((e) => e.type === 'message_received')
      .reduce((m, e) => Math.max(m, new Date(e.ts).getTime()), 0);
    return ult > 0 && Date.now() - ult < 23.5 * 3600 * 1000; // margen de 30 min
  } catch (e) { return true; }
}

/**
 * Texto libre si la ventana está abierta; si no, la plantilla aprobada
 * `plantilla` ({ name, lang, varNames }) con el nombre del lead; si no hay
 * plantilla, NO se envía nada (mode 'fuera_ventana'): mandar texto que Meta
 * va a rechazar solo empeora la calidad del número.
 */
async function sendTextoOPlantilla(lead, texto, plantilla = null, opts = {}) {
  if (dentroDeVentana(lead.telefono)) return sendTextMessage(lead.telefono, texto, opts);
  if (plantilla && plantilla.name) {
    console.log(`🪟 [Messaging] ${lead.nombre}: ventana de 24h cerrada → plantilla ${plantilla.name} en vez de texto`);
    return sendTemplate(lead.telefono, [lead.nombre], plantilla);
  }
  console.log(`🪟 [Messaging] ${lead.nombre}: ventana de 24h cerrada y sin plantilla → no se envía (Meta lo rechazaría)`);
  return { success: false, mode: 'fuera_ventana', error: 'ventana de 24h cerrada' };
}

// Plantilla aprobada que recuerda reservar el 1-a-1 (variable numerada {{1}})
const PLANTILLA_1A1 = { name: 'recordatorio_reunion', lang: 'en', varNames: ['1'] };

module.exports = {
  sendTextMessage, sendPrimerContacto, sendTemplate, sendTextoOPlantilla, dentroDeVentana,
  plantillaParaSegmento, esTelegram, TG_PREFIX, PLANTILLA_1A1,
};
