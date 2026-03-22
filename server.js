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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Archivos estáticos ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rutas ────────────────────────────────────────────────────────
app.use('/webhook', require('./routes/webhook'));
app.use('/api', require('./routes/api'));
app.use('/tracking', require('./routes/tracking'));

// ─── Ruta de salud ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: config.env,
  });
});

// ─── Ruta catch-all para SPA ──────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ─── Ruta principal (Generación Visual de QR) ─────────────────────
app.get('/', (req, res) => {
  const whatsapp = require('./services/whatsapp');
  
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
        <p>Esto puede tardar unos segundos. Por favor, <a href="/">refresca la página</a> en 10 segundos.</p>
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
      <p><a href="/" style="padding: 10px 20px; background: #3498db; color: white; border-radius: 5px; text-decoration: none;">Refrescar código</a></p>
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

  // ─── Iniciar scheduler de recordatorios ─────────────────────────
  const scheduler = require('./services/scheduler');
  scheduler.iniciar();

  // ─── Iniciar cliente de WhatsApp (Baileys) ───────────────────────
  const whatsapp = require('./services/whatsapp');
  whatsapp.initialize();
});
