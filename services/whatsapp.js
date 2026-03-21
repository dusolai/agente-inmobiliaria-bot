const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config/config');

/**
 * Servicio de WhatsApp modificado para usar whatsapp-web.js (Método QR)
 * Esto permite vincular una SIM física escaneando el código QR en la terminal.
 */

let client = null;
let isReady = false;

function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp Web...');
  
  // LocalAuth guarda la sesión en la carpeta .wwebjs_auth para no tener que escanear el QR cada vez
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions'],
    }
  });

  client.on('qr', (qr) => {
    // Genera el código QR en la terminal
    console.log('\n======================================================');
    console.log('📲 Escanea este código QR con el WhatsApp de tu móvil:');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    isReady = true;
    console.log('✅ [WhatsApp Web] Cliente autenticado y listo para enviar mensajes.');
  });

  client.on('authenticated', () => {
    console.log('✅ [WhatsApp Web] Autenticación exitosa (Sesión guardada).');
  });

  client.on('auth_failure', msg => {
    console.error('❌ [WhatsApp Web] Falla en la autenticación:', msg);
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    console.log('❌ [WhatsApp Web] Cliente desconectado:', reason);
    // Reiniciar cliente si se desconecta
    client.destroy();
    client.initialize();
  });

  client.initialize();
}

/**
 * Envía un mensaje de texto por WhatsApp.
 * @param {string} to – Número de teléfono con código de país (ej. "34612345678")
 * @param {string} body – Texto del mensaje
 */
async function sendTextMessage(to, body) {
  if (!client || !isReady) {
    console.log(`\n📲 [WhatsApp DEV] → ${to} (Cliente NO listo, guardando en log)`);
    console.log(`────────────────────────────────`);
    console.log(body);
    console.log(`────────────────────────────────\n`);
    return { success: true, mode: 'development', to, body };
  }

  try {
    // whatsapp-web.js requiere el formato 'numero@c.us'
    const chatId = `${to}@c.us`;
    await client.sendMessage(chatId, body);
    
    console.log(`✅ [WhatsApp] Mensaje enviado a ${to}`);
    return { success: true, mode: 'production' };
  } catch (err) {
    console.error(`❌ [WhatsApp] Error enviando a ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Identificador de si el servicio ha sido configurado/está listo
 */
const isConfigured = () => isReady;

module.exports = {
  initialize,
  sendTextMessage,
  isConfigured
};
