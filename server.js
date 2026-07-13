const express = require('express');
const cors = require('cors');

// ─── Controladores Globales de Errores ──────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Global] Rechazo de promesa no controlado:', reason);
});

const path = require('path');
const config = require('./config/config');

const app = express();

// ─── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb: para importar listas grandes de leads desde el CRM
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Protección del CRM y la API (ADMIN_TOKEN) ────────────────────
// Con ADMIN_TOKEN definido en Seenode, el panel y la API de leads piden
// usuario/contraseña (Basic auth: cualquier usuario + el token). Quedan
// públicos solo los endpoints que necesitan las landings y los webhooks:
// /tracking, /webhook, /r, /health, /api/config y la raíz (QR).
// Sin ADMIN_TOKEN no se protege nada (compatible con el comportamiento actual).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('⚠️  ADMIN_TOKEN no configurado: el CRM y /api/leads quedan PÚBLICOS. Configúralo en Seenode.');
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    if (pass === ADMIN_TOKEN) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="CRM Three Inmobiliaria"');
  return res.status(401).send('Autenticación requerida');
}

app.use((req, res, next) => {
  const p = req.path;
  const esPanel = p === '/monitor.html' || p === '/test.html' || p === '/qr' || p === '/crm' || p.startsWith('/admin');
  const esApiPrivada = p.startsWith('/api/') && p !== '/api/config';
  if (esPanel || esApiPrivada) return requireAdmin(req, res, next);
  next();
});

// ─── /admin redirige al panel CRM en vivo ─────────────────────────
// IMPORTANTE: este redirect debe ir ANTES del static middleware, porque si no
// express.static encuentra public/admin/index.html (panel antiguo) y lo sirve
// directamente, sin pasar por nuestro redirect.
app.get(['/admin', '/admin/', '/admin/index.html', '/crm'], (req, res) => {
  res.redirect('/monitor.html');
});

// ─── Archivos estáticos ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rutas ────────────────────────────────────────────────────────
app.use('/webhook', require('./routes/webhook'));
app.use('/webhook/zoom', require('./routes/zoomWebhook'));
app.use('/webhook/whatsapp', require('./routes/webhookWhatsapp'));
app.use('/api', require('./routes/api'));
app.use('/tracking', require('./routes/tracking'));
app.use('/r', require('./routes/redirector'));

// ─── Ruta de salud ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: config.env,
  });
});

// ─── Ruta principal → CRM ─────────────────────────────────────────
// La raíz lleva al panel (lo que se usa a diario). El QR de WhatsApp
// vive en /qr y también dentro del CRM, pestaña "WhatsApp".
app.get('/', (req, res) => {
  res.redirect('/monitor.html');
});

// ─── /qr (Generación Visual de QR de WhatsApp) ────────────────────
app.get('/qr', (req, res) => {
  const whatsapp = require('./services/whatsapp');

  // Con la API oficial no hay QR: la conexión es por token, no por escaneo.
  if (whatsapp.provider === 'cloud') {
    const ok = whatsapp.isConfigured();
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: ${ok ? '#27ae60' : '#e67e22'};">☁️ WhatsApp — API oficial de Meta</h1>
        <p>${ok
          ? 'Conectado por API oficial. No hay QR que escanear: la conexión es permanente por token.'
          : 'Faltan credenciales de Meta (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN) en Seenode.'}</p>
        <p><a href="/monitor.html" style="color: #3498db; text-decoration: none;">Ir al CRM</a></p>
      </div>
    `);
  }

  if (whatsapp.isConfigured()) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #27ae60;">✅ WhatsApp Vinculado Correctamente</h1>
        <p>El Agente Three Inmobiliaria ya está listo y esperando leads.</p>
        <p><a href="/test.html" style="color: #3498db; text-decoration: none;">Ir al Simulador de Registro</a></p>
      </div>
    `);
  }

  const qrDataUrl = whatsapp.getLatestQr();
  if (!qrDataUrl) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2>⏳ Generando el código QR de WhatsApp...</h2>
        <p>Esto puede tardar unos segundos. Por favor, <a href="/qr">refresca la página</a> en 10 segundos.</p>
      </div>
    `);
  }

  // Baileys genera el QR como base64 data URL, lo insertamos directamente
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><title>Vincular WhatsApp</title>
    <meta http-equiv="refresh" content="20">
    </head>
    <body style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #f0f2f5;">
      <h2>📲 Escanea este código QR con el WhatsApp de tu móvil</h2>
      <p>Abre WhatsApp > Ajustes > Dispositivos Vinculados > Vincular un dispositivo</p>
      <div style="background: white; padding: 20px; display: inline-block; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
        <img src="${qrDataUrl}" alt="WhatsApp QR Code" width="300" height="300" />
      </div>
      <p style="color: #555; font-size: 0.9em; margin-top: 20px;">La página se refresca automáticamente cada 20 segundos.</p>
      <p><a href="/qr" style="padding: 10px 20px; background: #3498db; color: white; border-radius: 5px; text-decoration: none;">Refrescar código</a></p>
    </body>
    </html>
  `);
});

// ─── Iniciar servidor ─────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🏠  Three Inmobiliaria – Embudo Agéntico           ║
║                                                      ║
║   🌐 Servidor: http://localhost:${config.port}               ║
║   🎬 Landing:  http://localhost:${config.port}               ║
║   📊 Admin:    http://localhost:${config.port}/admin          ║
║   💚 Health:   http://localhost:${config.port}/health         ║
║                                                      ║
║   📝 Modo: ${config.env.padEnd(15)}                       ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
  `);

  // ─── Restaurar desde Postgres ANTES de arrancar los servicios ────
  // Tras un redeploy el disco viene vacío: si hay DATABASE_URL, backupDb
  // recupera leads, actividad y la sesión de WhatsApp desde la última copia.
  // Solo después arrancan el scheduler y Baileys (que leen esos ficheros).
  const backupDb = require('./services/backupDb');
  backupDb
    .iniciar()
    .catch((err) => console.error('⚠️  [BackupDB] Error en el arranque:', err.message))
    .finally(() => {
      // ─── Iniciar scheduler de recordatorios ─────────────────────
      const scheduler = require('./services/scheduler');
      scheduler.iniciar();

      // ─── Iniciar cliente de WhatsApp (Baileys) ───────────────────
      const whatsapp = require('./services/whatsapp');
      whatsapp.initialize();

      // ─── Iniciar adaptador de Telegram (modo piloto) ─────────────
      // Si TELEGRAM_BOT_TOKEN está vacío, el adaptador se salta solo.
      const telegram = require('./services/telegram');
      telegram.initialize();
    });
});
