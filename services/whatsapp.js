const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const QRCode = require('qrcode');

/**
 * Servicio de WhatsApp usando Baileys (WebSocket directo, SIN navegador)
 * Esto es muchísimo más ligero y estable que whatsapp-web.js + Puppeteer.
 * Funciona perfectamente en servidores Docker con recursos limitados.
 */

let sock = null;
let isReady = false;
let latestQr = null;
let latestQrDataUrl = null; // QR como imagen base64 para la web

async function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp (Baileys)...');
  
  try {
    // Cargamos la sesión guardada (si existe) desde la carpeta auth_info
    const authDir = path.join(process.cwd(), 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // Crear socket de WhatsApp
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console.log)
      },
      printQRInTerminal: true, // También imprime el QR en la consola de logs
      browser: ['Three Inmobiliaria', 'Chrome', '120.0.0'],
      // Silenciar los logs excesivos de Baileys
      logger: {
        level: 'silent',
        child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: console.warn, error: console.error })
      }
    });
    
    // ─── Evento: Actualización de conexión ────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Nuevo QR generado
      if (qr) {
        console.log('\n======================================================');
        console.log('📲 Escanea este código QR con el WhatsApp de tu móvil:');
        console.log('======================================================\n');
        latestQr = qr;
        
        // Generar la imagen QR como data URL para la web
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch (err) {
          console.error('Error generando QR image:', err);
        }
      }
      
      // Conexión cerrada
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ [WhatsApp] Conexión cerrada (código: ${statusCode}). Reconectar: ${shouldReconnect}`);
        
        isReady = false;
        latestQr = null;
        latestQrDataUrl = null;
        
        if (shouldReconnect) {
          // Esperar un poco y reintentar
          setTimeout(() => {
            console.log('🔄 Reintentando conexión...');
            initialize();
          }, 5000);
        } else {
          console.log('⚠️ [WhatsApp] Sesión cerrada por el usuario. Se requiere nuevo QR.');
          // Limpiar la sesión guardada
          const fs = require('fs');
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
          setTimeout(() => initialize(), 3000);
        }
      }
      
      // Conexión abierta exitosamente
      if (connection === 'open') {
        isReady = true;
        latestQr = null;
        latestQrDataUrl = null;
        console.log('✅ [WhatsApp] Cliente autenticado y listo para enviar mensajes.');
      }
    });
    
    // ─── Evento: Guardar credenciales actualizadas ────────────────────
    sock.ev.on('creds.update', saveCreds);
    
  } catch (err) {
    console.error('❌ [WhatsApp] Error crítico al inicializar:', err);
    // Reintentar tras 10 segundos
    setTimeout(() => initialize(), 10000);
  }
}

/**
 * Envía un mensaje de texto por WhatsApp.
 * @param {string} to – Número de teléfono con código de país (ej. "34612345678")
 * @param {string} body – Texto del mensaje
 */
async function sendTextMessage(to, body) {
  if (!sock || !isReady) {
    console.log(`\n📲 [WhatsApp DEV] → ${to} (Cliente NO listo, guardando en log)`);
    console.log(`────────────────────────────────`);
    console.log(body);
    console.log(`────────────────────────────────\n`);
    return { success: true, mode: 'development', to, body };
  }

  try {
    // Baileys requiere el formato 'numero@s.whatsapp.net'
    const jid = `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: body });
    
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
 * Devuelve el último código QR generado (como data URL base64 para <img>)
 */
const getLatestQr = () => latestQrDataUrl;

/**
 * Devuelve el string raw del QR (para verificar existencia)
 */
const hasQr = () => !!latestQr;

module.exports = {
  initialize,
  sendTextMessage,
  isConfigured,
  getLatestQr,
  hasQr
};
