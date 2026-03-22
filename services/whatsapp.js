const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');

/**
 * Servicio de WhatsApp usando Baileys (WebSocket directo, SIN navegador)
 * Esto es muchísimo más ligero y estable que whatsapp-web.js + Puppeteer.
 * Funciona perfectamente en servidores Docker con recursos limitados.
 */

// Logger silencioso pero COMPLETO (Baileys necesita todas las funciones de pino)
const logger = pino({ level: 'silent' });

let sock = null;
let isReady = false;
let latestQr = null;
let latestQrDataUrl = null;

async function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp (Baileys)...');
  
  try {
    const authDir = path.join(process.cwd(), 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['Three Inmobiliaria', 'Chrome', '120.0.0'],
      logger: logger
    });
    
    // ─── Evento: Actualización de conexión ────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('\n======================================================');
        console.log('📲 Nuevo código QR generado. Escanealo desde la web.');
        console.log('======================================================\n');
        latestQr = qr;
        
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          console.log('✅ QR listo para mostrar en la web.');
        } catch (err) {
          console.error('Error generando QR image:', err);
        }
      }
      
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ [WhatsApp] Conexión cerrada. Reconectar: ${shouldReconnect}`);
        
        isReady = false;
        latestQr = null;
        latestQrDataUrl = null;
        
        if (shouldReconnect) {
          setTimeout(() => {
            console.log('🔄 Reintentando conexión...');
            initialize();
          }, 5000);
        } else {
          console.log('⚠️ [WhatsApp] Sesión cerrada por el usuario. Se requiere nuevo QR.');
          const fs = require('fs');
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
          setTimeout(() => initialize(), 3000);
        }
      }
      
      if (connection === 'open') {
        isReady = true;
        latestQr = null;
        latestQrDataUrl = null;
        console.log('✅ [WhatsApp] Cliente autenticado y listo para enviar mensajes.');
      }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
  } catch (err) {
    console.error('❌ [WhatsApp] Error crítico al inicializar:', err);
    setTimeout(() => initialize(), 10000);
  }
}

async function sendTextMessage(to, body) {
  if (!sock || !isReady) {
    console.log(`\n📲 [WhatsApp DEV] → ${to} (Cliente NO listo, guardando en log)`);
    console.log(`────────────────────────────────`);
    console.log(body);
    console.log(`────────────────────────────────\n`);
    return { success: true, mode: 'development', to, body };
  }

  try {
    const jid = `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: body });
    
    console.log(`✅ [WhatsApp] Mensaje enviado a ${to}`);
    return { success: true, mode: 'production' };
  } catch (err) {
    console.error(`❌ [WhatsApp] Error enviando a ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

const isConfigured = () => isReady;
const getLatestQr = () => latestQrDataUrl;

module.exports = {
  initialize,
  sendTextMessage,
  isConfigured,
  getLatestQr
};
