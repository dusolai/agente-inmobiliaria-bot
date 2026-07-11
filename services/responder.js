/**
 * Respondedor conversacional con LLM.
 *
 * La máquina de estados sigue mandando (opt-out, "1"/"2", enlaces del
 * embudo). Pero cuando el lead escribe algo fuera del guion ("¿esto qué
 * es?", "¿cuánto cuesta?", "¿quién eres?"), antes el bot callaba. Con este
 * servicio, un LLM barato responde en contexto y reconduce al siguiente
 * paso del embudo.
 *
 * Proveedores (se usa el primero configurado):
 *   - GROQ_API_KEY       → Groq (llama-3.3-70b-versatile; capa gratuita)
 *   - ANTHROPIC_API_KEY  → Claude Haiku (claude-haiku-4-5, ~0,001 USD/resp.)
 *
 * Sin claves — o ante error, timeout o respuesta rara — devuelve null y el
 * flujo se comporta como siempre (el mensaje queda en "Sin responder" del
 * CRM). Límite: 4 respuestas LLM por lead y hora, para cortar bucles.
 */

const axios = require('axios');
const config = require('../config/config');
const activityLog = require('./activityLog');

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const HAIKU_MODEL = process.env.PERSONALIZER_MODEL || 'claude-haiku-4-5';
const MAX_RESPUESTAS_HORA = Math.max(1, parseInt(process.env.LLM_MAX_RESPUESTAS_HORA, 10) || 4);

function estaActivo() {
  return Boolean(process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// ─── Límite por lead (en memoria) ─────────────────────────────────
const _envios = new Map(); // leadId -> [timestamps]
function _dentroDeLimite(leadId) {
  const ahora = Date.now();
  const lista = (_envios.get(leadId) || []).filter((t) => ahora - t < 3600 * 1000);
  _envios.set(leadId, lista);
  if (lista.length >= MAX_RESPUESTAS_HORA) return false;
  lista.push(ahora);
  return true;
}

// ─── Objetivo y enlace según el estado del lead ───────────────────
function _contextoDeEstado(lead) {
  const base = config.backendPublicUrl.replace(/\/$/, '');
  const landing = (lead.perfil === 'profesional'
    ? config.landing.landingProfesionalUrl
    : config.landing.landingEmprendedorUrl) + `?lead=${lead.id}`;

  switch (lead.estado) {
    case 'esperando_cualificacion':
      return {
        objetivo: 'que responda con "1" (si es agente inmobiliario) o "2" (si busca un ingreso extra). Contesta su duda brevemente y termina recordándole que responda 1 o 2.',
        enlace: null,
      };
    case 'video_enviado':
      return {
        objetivo: 'que reserve su plaza para la presentación en el enlace de reserva. Contesta su duda y recuérdale el enlace.',
        enlace: `${base}/r/grupal?l=${encodeURIComponent(lead.id)}`,
      };
    case 'video_visto':
      return {
        objetivo: 'que entre en la página de la presentación y vea los vídeos hasta el final (al terminar se le desbloquea el botón para agendar). Contesta su duda y recuérdale el acceso.',
        enlace: landing,
      };
    case 'reunion_registrado':
      return {
        objetivo: 'que reserve su reunión 1 a 1 con Arkaitz en el enlace. Contesta su duda y recuérdale el enlace.',
        enlace: `${base}/r/individual?l=${encodeURIComponent(lead.id)}`,
      };
    default:
      return {
        objetivo: 'atenderle con amabilidad; si necesita algo concreto, dile que Arkaitz o alguien del equipo le escribe en cuanto pueda.',
        enlace: null,
      };
  }
}

function _systemPrompt(lead) {
  const ctx = _contextoDeEstado(lead);
  return (
    'Eres del equipo de Three Inmobiliaria y respondes mensajes de WhatsApp desde el móvil. ' +
    'Español de España, tono cercano y natural, respuestas CORTAS (1 a 3 frases, como una persona), máximo un emoji.\n\n' +
    'Contexto del negocio: Three Inmobiliaria incorpora agentes inmobiliarios y personas que buscan un ingreso extra ' +
    '(prescriptores) a su red. El proceso con cada interesado es: (1) pregunta de perfil — responder 1 si es agente, ' +
    '2 si busca ingreso extra; (2) reservar plaza para una presentación del negocio; (3) ver la presentación en vídeo; ' +
    '(4) reunión individual con Arkaitz por Zoom para resolver dudas y concretar su entrada.\n\n' +
    'REGLAS ESTRICTAS:\n' +
    '- NO inventes datos, cifras, precios, comisiones ni promesas. Si preguntan cuánto cuesta o cuánto se gana, di que ' +
    'eso se explica con detalle en la presentación y en la reunión con Arkaitz, sin dar números.\n' +
    '- Si pide hablar con una persona, dile que Arkaitz o alguien del equipo le escribirá en cuanto pueda.\n' +
    `- Tu objetivo ahora mismo: ${ctx.objetivo}\n` +
    (ctx.enlace ? `- Enlace que puedes incluir si encaja: ${ctx.enlace}\n` : '- No incluyas ningún enlace.\n') +
    '- Responde SOLO con el texto del mensaje de WhatsApp, sin comillas ni explicaciones.'
  );
}

// Historial corto para que el LLM tenga contexto de la conversación
function _historial(leadId) {
  try {
    const eventos = activityLog.getActivityByLead(leadId);
    return eventos
      .filter((e) => e.type === 'message_sent' || e.type === 'message_received')
      .slice(-8)
      .map((e) => (e.type === 'message_sent'
        ? `TÚ: ${(e.meta && e.meta.preview) || ''}`
        : `LEAD: ${(e.meta && e.meta.texto) || ''}`))
      .join('\n');
  } catch (e) {
    return '';
  }
}

function _esValida(texto) {
  if (!texto || typeof texto !== 'string') return false;
  const t = texto.trim();
  return t.length >= 2 && t.length <= 700;
}

async function _llamarGroq(system, user) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      timeout: 15000,
    }
  );
  return res.data?.choices?.[0]?.message?.content;
}

async function _llamarHaiku(system, user) {
  const mod = require('@anthropic-ai/sdk');
  const Anthropic = mod.default || mod;
  const client = new Anthropic({ timeout: 15000, maxRetries: 1 });
  const res = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Genera una respuesta conversacional para el mensaje de un lead.
 * Devuelve el texto a enviar, o null si no procede (sin claves, límite
 * alcanzado o error) — en cuyo caso el flujo sigue como hasta ahora.
 */
async function responder(lead, textoLead) {
  if (!estaActivo()) return null;
  if (!_dentroDeLimite(lead.id)) {
    console.log(`🧠 [Responder] Límite por hora alcanzado para ${lead.nombre} — silencio (queda en Sin responder)`);
    return null;
  }

  const system = _systemPrompt(lead);
  const historial = _historial(lead.id);
  const user =
    (historial ? `Conversación hasta ahora:\n${historial}\n\n` : '') +
    `El lead ${lead.nombre} acaba de escribir: "${textoLead}"`;

  try {
    const proveedor = process.env.GROQ_API_KEY ? 'groq' : 'anthropic';
    const bruto = proveedor === 'groq'
      ? await _llamarGroq(system, user)
      : await _llamarHaiku(system, user);

    const texto = String(bruto || '').trim();
    if (!_esValida(texto)) {
      console.warn('🧠 [Responder] Respuesta fuera de guion, silencio');
      return null;
    }
    activityLog.appendActivity(lead.id, 'llm_reply', { proveedor });
    console.log(`🧠 [Responder] (${proveedor}) → ${lead.nombre}: "${texto.slice(0, 60)}"`);
    return texto;
  } catch (err) {
    console.error('🧠 [Responder] Error, silencio:', err.message);
    return null;
  }
}

module.exports = { responder, estaActivo };
