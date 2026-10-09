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
 *   - ANTHROPIC_API_KEY  → Claude Haiku (claude-haiku-5-5)
 *
 * Sin claves — o ante error, timeout o respuesta rara — devuelve null y el
 * flujo se comporta como siempre (el mensaje queda en "Sin responder" del
 * CRM). Límite: 20 respuestas LLM por lead y hora (LLM_MAX_RESPUESTAS_HORA),
 * solo como corta-bucles ante un fallo; en una conversación normal no se toca.
 */

const axios = require('axios');
const config = require('../config/config');
const activityLog = require('./activityLog');

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const HAIKU_MODEL = process.env.PERSONALIZER_MODEL || 'claude-haiku-5-5';
const MAX_RESPUESTAS_HORA = Math.max(1, parseInt(process.env.LLM_MAX_RESPUESTAS_HORA, 10) || 20);

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
        objetivo: 'que entre en la página y vea la presentación en vídeo (primero el vídeo corto y, según avanza, se desbloquea el webinar). Al terminar el webinar, en la propia página se activa el botón para agendar su reunión 1 a 1. Contesta su duda y recuérdale el enlace de la presentación.',
        enlace: landing,
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
    `Te llamas ${config.agent.agenteNombre} y eres del equipo de Three Inmobiliaria; respondes mensajes de WhatsApp desde el móvil. ` +
    'Si te preguntan quién eres, preséntate como tal ("Soy ' + config.agent.agenteNombre + ', del equipo de Three Inmobiliaria"). ' +
    'Español de España, tono cercano y natural, respuestas CORTAS (1 a 3 frases, como una persona), máximo un emoji.\n\n' +
    'Contexto del negocio: Three Inmobiliaria incorpora agentes inmobiliarios y personas que buscan un ingreso extra ' +
    '(prescriptores) a su red. El proceso con cada interesado es: (1) pregunta de perfil — responder 1 si es agente, ' +
    '2 si busca ingreso extra; (2) ver la presentación en vídeo en la página que se le envía (primero un vídeo corto y luego el webinar); ' +
    `(3) reunión individual con ${config.agent.directorNombre} (${config.agent.directorRol}) por Zoom para resolver dudas y concretar su entrada. NO existe ninguna "reserva de plaza" previa ni sesión grupal: del vídeo se pasa directo a la reunión 1 a 1.\n\n` +
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

// ═══ Router de decisión ══════════════════════════════════════════
// Para cada mensaje fuera de guion decide QUÉ hacer (no solo qué decir),
// mirando el estado del lead y la conversación:
//   responder → contestar (texto) y reconducir al siguiente paso
//   perfil    → en realidad nos ha dicho su perfil ("vendo pisos" → profesional)
//   baja      → no quiere seguir (aunque no use la palabra "baja")
//   humano    → pide una persona o algo que el bot no debe resolver
//   silencio  → no hace falta contestar ("ok" a un mensaje que no pedía nada,
//               mensajes que se cruzan…)
// Con IA (GROQ_API_KEY o ANTHROPIC_API_KEY) decide el modelo; sin IA, o si
// falla, deciden reglas fijas. Nunca se queda sin respuesta por falta de clave.

const ACCIONES = ['responder', 'perfil', 'baja', 'humano', 'silencio'];

function _norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
const ACK_REGEX = /^(ok+|okey|vale+|dale+|genial|perfecto|gracias|muchas gracias|guay|top|de acuerdo|entendido|listo|hecho|sii*|claro|bien|buenisimo|estupendo|👍|🙏|👌|😊|🙂)\b/u;
const SALUDO_REGEX = /^(e+i+|e+y+|hey+|hola+|holi+s?|buenas+|buenos dias|buenas (tardes|noches)|hi|hello|que tal|saludos)\b/u;
const HUMANO_REGEX = /(hablar con (alguien|una persona|arkaitz|un humano)|llamame|llamadme|me podeis llamar|me puedes llamar|eres (un )?(bot|robot|ia|maquina)|persona real)/;

function _ultimo(eventos, tipo) {
  const e = eventos.filter((x) => x.type === tipo).pop();
  return e ? Date.now() - new Date(e.ts).getTime() : Infinity;
}

/** Reglas sin IA: siempre devuelven una decisión razonable para el estado. */
function _decidirPorReglas(lead, texto) {
  const t = _norm(texto);
  const eventos = activityLog.getActivityByLead(lead.id);
  const ctx = _contextoDeEstado(lead);
  const nombre = lead.nombre && lead.nombre !== 'Sin nombre' ? ` ${lead.nombre}` : '';
  const HORA = 3600 * 1000;

  if (HUMANO_REGEX.test(t)) {
    return { accion: 'humano', texto: `Claro${nombre}, se lo paso a Arkaitz y te escribe él en cuanto pueda 🙂` };
  }
  // No repetir la misma respuesta automática una y otra vez: si ya hubo una
  // hace poco en esta misma fase, silencio (queda en "Sin responder").
  if (_ultimo(eventos.filter((e) => !e.meta || e.meta.estado === lead.estado), 'router_reply') < 6 * HORA) return { accion: 'silencio', motivo: 'ya hubo respuesta automática reciente' };

  const esAck = ACK_REGEX.test(t) || SALUDO_REGEX.test(t);
  switch (lead.estado) {
    case 'esperando_cualificacion':
      if (esAck) return { accion: 'silencio', motivo: 'saludo/ok con la pregunta 1/2 ya en pantalla' };
      return { accion: 'responder', texto: null }; // → re-pregunta 1/2 estándar
    case 'video_enviado':
    case 'video_visto':
      return {
        accion: 'responder',
        texto: esAck
          ? `¡Perfecto${nombre}! 🙌 Tómate tu tiempo con la presentación. Al terminar el webinar te aparece el botón para reservar tu reunión con Arkaitz.\n\nPor si la necesitas otra vez: ${ctx.enlace}`
          : `Buena pregunta${nombre}. Eso se explica con detalle en la presentación y, lo que quede, lo ves directamente con Arkaitz en la reunión 1 a 1.\n\nAquí la tienes: ${ctx.enlace}`,
      };
    case 'reunion_registrado':
      return {
        accion: 'responder',
        texto: esAck
          ? `¡Genial${nombre}! Cuando puedas, reserva aquí tu reunión con Arkaitz: ${ctx.enlace}`
          : `Eso lo ves directamente con Arkaitz en la reunión, que es para eso 🙂 Resérvala aquí: ${ctx.enlace}`,
      };
    default:
      if (esAck) return { accion: 'silencio', motivo: 'ok sin nada pendiente' };
      return { accion: 'humano', texto: `Gracias${nombre}, se lo paso al equipo y te escriben en cuanto puedan 🙂` };
  }
}

function _promptRouter(lead) {
  return (
    _systemPrompt(lead).replace(/- Responde SOLO con el texto[^\n]*$/, '') +
    '\n\nAhora NO escribes directamente: DECIDES qué hacer con su último mensaje. Responde SOLO con un JSON en una línea:\n' +
    '{"accion":"responder|perfil|baja|humano|silencio","texto":"mensaje a enviar o vacío","perfil":"profesional|emprendedor|"}\n' +
    '- "perfil": su mensaje deja claro si es agente/trabaja en inmobiliaria (profesional) o busca ingresos extra (emprendedor). Solo si está esperando la pregunta 1/2 o pide la otra presentación. texto vacío.\n' +
    '- "baja": no quiere seguir o pide que no le escribamos. texto vacío.\n' +
    '- "humano": pide hablar con una persona, se queja, o plantea algo que no debes resolver tú. texto = aviso breve de que Arkaitz o el equipo le escribe.\n' +
    '- "silencio": no hace falta contestar (un "ok"/"hola" cuando ya le hemos dicho lo que tiene que hacer justo antes y no ha pasado tiempo, o mensajes que se cruzan). texto vacío.\n' +
    '- "responder": cualquier otro caso. texto = respuesta corta que conteste y le lleve al siguiente paso. Si da un "ok/dale/gracias" a la presentación, anímale a verla y recuerda que al final se reserva la reunión.\n' +
    'Ante la duda entre silencio y responder, responde: es peor dejar a alguien sin contestar.'
  );
}

function _parsearDecision(bruto) {
  try {
    const m = String(bruto || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (!ACCIONES.includes(d.accion)) return null;
    if (d.accion === 'perfil' && !['profesional', 'emprendedor'].includes(d.perfil)) return null;
    if ((d.accion === 'responder' || d.accion === 'humano') && d.texto && !_esValida(d.texto)) return null;
    return { accion: d.accion, texto: d.texto ? String(d.texto).trim() : null, perfil: d.perfil || null };
  } catch (e) {
    return null;
  }
}

/**
 * Decide qué hacer con un mensaje fuera de guion.
 * Devuelve { accion, texto?, perfil?, via: 'ia'|'reglas' }.
 */
async function decidir(lead, textoLead) {
  let d = null;
  let via = 'reglas';
  if (estaActivo() && _dentroDeLimite(lead.id)) {
    const historial = _historial(lead.id);
    const user =
      (historial ? `Conversación hasta ahora:\n${historial}\n\n` : '') +
      `Estado del lead en el embudo: ${lead.estado}. El lead ${lead.nombre} acaba de escribir: "${textoLead}"`;
    try {
      const system = _promptRouter(lead);
      const bruto = process.env.GROQ_API_KEY ? await _llamarGroq(system, user) : await _llamarHaiku(system, user);
      d = _parsearDecision(bruto);
      if (d) via = 'ia';
      else console.warn('🧭 [Router] Respuesta de la IA no válida → reglas');
    } catch (err) {
      console.error('🧭 [Router] Error de la IA → reglas:', err.message);
    }
  }
  if (!d) d = _decidirPorReglas(lead, textoLead);
  d.via = via;
  activityLog.appendActivity(lead.id, 'router_decision', { accion: d.accion, via, perfil: d.perfil || undefined, motivo: d.motivo });
  if (d.accion === 'responder' || d.accion === 'humano') activityLog.appendActivity(lead.id, 'router_reply', { via, estado: lead.estado });
  console.log(`🧭 [Router] ${lead.nombre} (${lead.estado}) "${String(textoLead).slice(0, 40)}" → ${d.accion} [${via}]`);
  return d;
}

/** Comprueba la IA de verdad (zona de desarrollador): proveedor, modelo y error exacto. */
async function probar() {
  const clave = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const proveedor = process.env.GROQ_API_KEY ? 'groq' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  const out = {
    proveedor,
    modelo: proveedor === 'groq' ? GROQ_MODEL : proveedor === 'anthropic' ? HAIKU_MODEL : null,
    clave: clave ? `${clave.slice(0, 4)}…${clave.slice(-4)} (${clave.length} caracteres)` : null,
    otrasVariables: Object.keys(process.env).filter((k) => /GROK|XAI|OPENAI|GROQ|ANTHROPIC/i.test(k)),
  };
  if (!proveedor) return { ...out, ok: false, error: 'No hay GROQ_API_KEY ni ANTHROPIC_API_KEY en Seenode' };
  if (proveedor === 'groq' && !/^gsk_/.test(clave)) out.aviso = 'Las claves de Groq empiezan por "gsk_": ¿es de Grok (xAI) en vez de Groq?';
  try {
    const t = proveedor === 'groq'
      ? await _llamarGroq('Responde solo: OK', 'Di OK')
      : await _llamarHaiku('Responde solo: OK', 'Di OK');
    return { ...out, ok: true, respuesta: String(t || '').slice(0, 50) };
  } catch (err) {
    const d = err.response && err.response.data;
    return { ...out, ok: false, status: err.response && err.response.status, error: (d && d.error && (d.error.message || JSON.stringify(d.error))) || err.message };
  }
}

module.exports = { responder, decidir, probar, estaActivo, _decidirPorReglas };
