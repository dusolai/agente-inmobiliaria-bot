const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config/config');

/**
 * Servicio de WhatsApp modificado para usar whatsapp-web.js (Método QR)
 * Esto permite vincular una SIM física escaneando el código QR en la terminal.
 */

let client = null;
let isReady = false;
let latestQr = null;

function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp Web...');
  
  // LocalAuth guarda la sesión en la carpeta .wwebjs_auth para no tener que escanear el QR cada vez
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: '/usr/bin/chromium', // <-- Fuerza el uso de Chromium del sistema operativo
      protocolTimeout: 0, // <-- INFINITO para ordenadores/servidores muy lentos al conectar
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        // Ocultar que es un navegador sin interfaz gráfica
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-zygote',
        // ELIMINADO: '--single-process' causa crashes (Target closed) en Linux con WhatsApp Web
        '--disable-gpu'
      ],
      timeout: 120000 // Aumentado a 2 minutos para evitar timeout en servidores lentos
    },
    // Engañamos a WhatsApp fingiendo ser un navegador Chrome normal de Windows
    // Si sabe que somos un "Headless" Linux, bloquea el intento de escanear el QR ("No se pudo vincular el dispositivo")
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    
    // Evitamos descargar la última versión ultra-pesada de WhatsApp Web que puede crashear servidores pequeños
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1012111644-alpha.html'
    }
  });

  client.on('qr', (qr) => {
    // Genera el código QR en la terminal
    console.log('\n======================================================');
    console.log('📲 Escanea este código QR con el WhatsApp de tu móvil:');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
    latestQr = qr;
  });

  client.on('ready', () => {
    isReady = true;
    latestQr = null;
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
    latestQr = null;
    console.log('❌ [WhatsApp Web] Cliente desconectado:', reason);
    // Reiniciar cliente si se desconecta
    client.destroy();
    client.initialize();
  });

  client.initialize().catch(err => {
    console.error('❌ [WhatsApp Web] Error crítico al inicializar el navegador:', err);
  });
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

/**
 * Devuelve el último código QR generado
 */
const getLatestQr = () => latestQr;

module.exports = {
  initialize,
  sendTextMessage,
  isConfigured,
  getLatestQr
};