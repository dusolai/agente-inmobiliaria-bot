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
    
    // WA_AUTH_DIR permite apuntar la sesión a un disco persistente de Seenode
    // para que el número NO se desvincule en cada redeploy. Sin la variable,
    // usa ./auth_info como hasta ahora.
    const authDir = process.env.WA_AUTH_DIR || path.join(process.cwd(), 'auth_info');
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

        // Nombres de los códigos de cierre de Baileys, para que el log de
        // Seenode diga QUÉ pasó y no solo un número.
        const RAZONES = {
          401: 'SESIÓN CERRADA (loggedOut): el móvil desvinculó este dispositivo o WhatsApp revocó la sesión',
          408: 'timeout de conexión',
          411: 'desajuste multidispositivo',
          428: 'conexión perdida (red)',
          440: 'CONFLICTO: OTRA instancia del bot está usando esta misma sesión (¿dos contenedores en Seenode?)',
          500: 'error interno de WhatsApp',
          503: 'servicio no disponible',
          515: 'reinicio requerido tras vincular (normal justo después de escanear el QR)',
        };
        console.log(`❌ [WhatsApp] Conexión cerrada (código ${statusCode}: ${RAZONES[statusCode] || 'desconocido'}). Error: ${lastDisconnect?.error?.message || 'ninguno'}. Reconectar: ${shouldReconnect}`);

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

          // El 515 tras escanear el QR es un reinicio obligatorio y esperado:
          // reconectamos al instante para no perder los primeros mensajes.
          const delay = statusCode === 515 ? 500 : Math.min(10000 * Math.pow(2, retryCount - 1), 120000);
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

    // ─── Mensajes entrantes: respuesta a la pregunta de cualificación ──
    sock.ev.on('messages.upsert', async ({ messages: incoming, type }) => {
      if (type !== 'notify') return;

      for (const msg of incoming) {
        try {
          if (!msg.message || msg.key.fromMe) continue;

          const jid = msg.key.remoteJid || '';
          // Chats directos: @s.whatsapp.net (clásico) o @lid (cuentas con
          // identificador enlazado — WhatsApp lo usa cada vez más). Ignorar
          // grupos (@g.us) y estados (@broadcast).
          const esDirecto = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
          if (!esDirecto) continue;

          // Con @lid el remoteJid NO es el número: el teléfono real viene en
          // remoteJidAlt / senderPn. Nos quedamos con solo los dígitos.
          const jidReal = String(msg.key.remoteJidAlt || msg.key.senderPn || jid);
          const telefono = jidReal.split('@')[0].split(':')[0].replace(/[^\d]/g, '');

          const m = msg.message;
          const texto =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.buttonsResponseMessage?.selectedButtonId ||
            m.buttonsResponseMessage?.selectedDisplayText ||
            m.listResponseMessage?.title ||
            '';

          if (!texto) continue;

          // Log SIEMPRE: si un mensaje no genera respuesta, que al menos el
          // log de Seenode diga que llegó y de quién.
          console.log(`📥 [WhatsApp] Mensaje de ${telefono} (jid ${jid}): "${texto.slice(0, 60)}"`);

          const conversationFlow = require('./conversationFlow');
          await conversationFlow.handleIncoming(telefono, texto);
        } catch (err) {
          console.error('❌ [WhatsApp] Error procesando mensaje entrante:', err.message);
        }
      }
    });

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
    // Solo dígitos en el JID: un teléfono con espacios/+/guiones haría que
    // el mensaje se "enviara" a una dirección inexistente sin dar error.
    const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`;
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

/**
 * Envía "escribiendo…" al contacto (Baileys: presence 'composing').
 */
async function sendTypingAction(to) {
  if (!sock || !isReady) return;
  try {
    const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`;
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
  } catch (err) {
    // El typing es opcional, no rompemos el flujo
  }
}

module.exports = {
  initialize,
  sendTextMessage,
  sendTypingAction,
  isConfigured,
  getLatestQr
};
