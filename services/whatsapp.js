const path = require('path');
const QRCode = require('qrcode');

/**
 * Servicio de WhatsApp usando Baileys (WebSocket directo, SIN navegador)
 * Usa import() dinámico porque Baileys v6 es un módulo ESM.
 */

let sock = null;
let isReady = false;
let latestQr = null;
let latestQrDataUrl = null;
let retryCount = 0;
const MAX_RETRIES = 10;

async function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp (Baileys)...');
  
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch(e) {}
    sock = null;
  }
  
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = baileys;
    
    const pinoModule = await import('pino');
    const pino = pinoModule.default;
    const logger = pino({ level: 'warn' });
    
    const authDir = path.join(process.cwd(), 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // Obtenemos dinámicamente la ultimísima versión de WhatsApp Web para evitar Error 405 (versiones baneadas)
    console.log('🌐 Consultando última versión de web.whatsapp.com...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🤖 Versión de WhatsApp obtenida: ${version.join('.')} (Última: ${isLatest})`);
    
    console.log('🔗 Creando socket de WhatsApp...');
    
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      version: version, // <-- Fundamental para evitar el error 405 Connection Failure
      browser: ['Three Inmobiliaria', 'Chrome', '120.0.0'],
      logger: logger,
      connectTimeoutMs: 60000, 
    });
    
    console.log('✅ Socket creado. Esperando eventos de conexión...');
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log('📡 connection.update:', JSON.stringify({ 
        connection, 
        qr: qr ? 'QR_PRESENT' : undefined, 
        hasError: !!lastDisconnect?.error,
        statusCode: lastDisconnect?.error?.output?.statusCode
      }));
      
      if (qr) {
        retryCount = 0; 
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ [WhatsApp] Conexión cerrada (código: ${statusCode}). Error: ${lastDisconnect?.error?.message || 'ninguno'}. Reconectar: ${shouldReconnect}`);
        
        isReady = false;
        
        if (shouldReconnect) {
          retryCount++;
          
          if (retryCount > MAX_RETRIES) {
            console.log(`⚠️ [WhatsApp] Demasiados reintentos (${retryCount}). Esperando 5 minutos antes de reintentar...`);
            latestQr = null;
            latestQrDataUrl = null;
            setTimeout(() => {
              retryCount = 0;
              initialize();
            }, 5 * 60 * 1000); // 5 minutos
            return;
          }
          
          const delay = Math.min(10000 * Math.pow(2, retryCount - 1), 120000);
          console.log(`🔄 Reintento ${retryCount}/${MAX_RETRIES} en ${delay/1000}s...`);
          setTimeout(() => initialize(), delay);
        } else {
          console.log('⚠️ [WhatsApp] Sesión cerrada por el usuario. Se requiere nuevo QR.');
          latestQr = null;
          latestQrDataUrl = null;
          const fs = require('fs');
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
          retryCount = 0;
          setTimeout(() => initialize(), 5000);
        }
      }
      
      if (connection === 'open') {
        isReady = true;
        latestQr = null;
        latestQrDataUrl = null;
        retryCount = 0;
        console.log('✅ [WhatsApp] Cliente autenticado y listo para enviar mensajes.');
      }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
  } catch (err) {
    console.error('❌ [WhatsApp] Error crítico al inicializar:', err.message);
    console.error(err.stack);
    setTimeout(() => initialize(), 30000);
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
