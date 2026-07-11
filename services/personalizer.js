/**
 * Personalizador de mensajes con LLM (anti-baneo).
 *
 * Cientos de envíos con texto casi idéntico es el patrón que los filtros
 * antispam de WhatsApp detectan primero. Este servicio reescribe el mensaje
 * inicial para cada lead con un modelo barato (Claude Haiku), de forma que
 * cada envío sea único manteniendo el significado y las opciones 1/2.
 *
 * Se activa solo si ANTHROPIC_API_KEY está definida en el entorno (Seenode).
 * Sin la clave — o ante cualquier error o timeout — devuelve el texto base
 * sin tocar: el envío NUNCA se bloquea por culpa del personalizador.
 *
 * Coste aproximado con claude-haiku-4-5: ~0,001-0,002 USD por mensaje
 * (los 595 leads completos cuestan menos de 1 EUR).
 */

const MODEL = process.env.PERSONALIZER_MODEL || 'claude-haiku-4-5';

let _client = null;
let _clientFallido = false;

function _getClient() {
  if (!process.env.ANTHROPIC_API_KEY || _clientFallido) return null;
  if (_client) return _client;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    _client = new Anthropic({
      timeout: 15000, // ms — si el LLM tarda, mandamos el texto base y listo
      maxRetries: 1,
    });
    console.log(`✨ [Personalizer] Activo (${MODEL}): cada mensaje inicial será único`);
    return _client;
  } catch (err) {
    _clientFallido = true;
    console.error('⚠️  [Personalizer] No se pudo iniciar el SDK, se usarán las variantes fijas:', err.message);
    return null;
  }
}

function estaActivo() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && !_clientFallido;
}

// El mensaje reescrito debe conservar las dos opciones y un tamaño razonable;
// si el modelo se sale del guion, volvemos al texto base.
function _esValido(texto, base) {
  if (!texto || typeof texto !== 'string') return false;
  const t = texto.trim();
  if (t.length < 80 || t.length > base.length * 2 + 200) return false;
  if (!t.includes('1') || !t.includes('2')) return false;
  return true;
}

/**
 * Reescribe `textoBase` para que sea único, manteniendo significado, tono y
 * las opciones de respuesta. Devuelve el texto base ante cualquier problema.
 */
async function personalizarMensaje(textoBase, lead = {}) {
  const client = _getClient();
  if (!client) return textoBase;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system:
        'Reescribes mensajes de WhatsApp en español de España, tono cercano e informal, ' +
        'como si los escribiera una persona desde su móvil. Reglas estrictas: ' +
        '(1) conserva exactamente el mismo significado y toda la información; ' +
        '(2) conserva las dos opciones de respuesta numeradas 1 y 2 con su sentido intacto; ' +
        '(3) longitud similar al original; ' +
        '(4) no inventes datos, nombres, cifras ni promesas nuevas; ' +
        '(5) varía saludo, orden de las frases y vocabulario para que el texto sea único; ' +
        '(6) máximo un emoji o dos, como el original. ' +
        'Responde ÚNICAMENTE con el mensaje reescrito, sin comillas ni explicaciones.',
      messages: [
        {
          role: 'user',
          content: `Reescribe este mensaje para ${lead.nombre || 'el destinatario'}:\n\n${textoBase}`,
        },
      ],
    });

    const texto = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!_esValido(texto, textoBase)) {
      console.warn('⚠️  [Personalizer] Respuesta fuera de guion, uso el texto base');
      return textoBase;
    }
    console.log(`✨ [Personalizer] Mensaje personalizado para ${lead.nombre || '?'}`);
    return texto;
  } catch (err) {
    console.error('⚠️  [Personalizer] Error, uso el texto base:', err.message);
    return textoBase;
  }
}

module.exports = { personalizarMensaje, estaActivo };
