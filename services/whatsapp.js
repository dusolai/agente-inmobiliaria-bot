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

async function initialize() {
  console.log('🔄 Inicializando cliente de WhatsApp (Baileys)...');
  
  try {
    // Import dinámico porque Baileys v6 es ESM y nuestro proyecto usa CommonJS
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = baileys;
    
    // Importar pino también dinámicamente (v9 también es ESM)
    const pinoModule = await import('pino');
    const pino = pinoModule.default;
    const logger = pino({ level: 'warn' }); // Solo mostrar warnings y errores
    
    const authDir = path.join(process.cwd(), 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    console.log('🔗 Creando socket de WhatsApp...');
    
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['Three Inmobiliaria', 'Chrome', '120.0.0'],
      logger: logger
    });
    
    console.log('✅ Socket creado. Esperando eventos de conexión...');
    
    // ─── Evento: Actualización de conexión ────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log('📡 connection.update:', JSON.stringify({ connection, qr: qr ? 'QR_PRESENT' : undefined, hasError: !!lastDisconnect?.error }));
      
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ [WhatsApp] Conexión cerrada (código: ${statusCode}). Error: ${lastDisconnect?.error?.message || 'ninguno'}. Reconectar: ${shouldReconnect}`);
        
        isReady = false;
        latestQr = null;
        latestQrDataUrl = null;
        
        if (shouldReconnect) {
          // Espera progresiva para no saturar
          const delay = 10000; // 10 segundos entre reintentos
          console.log(`🔄 Reintentando conexión en ${delay/1000}s...`);
          setTimeout(() => initialize(), delay);
        } else {
          console.log('⚠️ [WhatsApp] Sesión cerrada por el usuario. Se requiere nuevo QR.');
          const fs = require('fs');
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
          setTimeout(() => initialize(), 5000);
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
    console.error('❌ [WhatsApp] Error crítico al inicializar:', err.message);
    console.error(err.stack);
    setTimeout(() => initialize(), 15000);
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
