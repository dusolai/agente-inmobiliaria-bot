const express = require('express');
const cors = require('cors');

// ─── Controladores Globales de Errores para evitar Crash de Puppeteer ──
process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.message && reason.message.includes('Execution context was destroyed')) {
    console.log('⚠️ [Puppeteer] Contexto destruido durante recarga (Normal en vinculación inicial). Ignorando...');
  } else {
    console.error('⚠️ [Global] Rechazo de promesa no controlado:', reason);
  }
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

  // ─── Iniciar cliente de WhatsApp Web (QR) ───────────────────────
  const whatsapp = require('./services/whatsapp');
  whatsapp.initialize();
});
