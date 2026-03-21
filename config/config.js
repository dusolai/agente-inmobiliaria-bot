require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',

  whatsapp: {
    apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v19.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  },

  google: {
    sheetsId: process.env.GOOGLE_SHEETS_ID || '',
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID || '',
    clientId: process.env.ZOOM_CLIENT_ID || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  },

  landing: {
    vslVideoUrl: process.env.VSL_VIDEO_URL || 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    landingUrl: process.env.LANDING_URL || 'http://localhost:3000',
    calendlyUrl: process.env.CALENDLY_URL || '#',
    reunionGrupalUrl: process.env.REUNION_GRUPAL_URL || '#',
  },

  agent: {
    empresaNombre: process.env.EMPRESA_NOMBRE || 'Three Inmobiliaria',
    expertoNombre: process.env.EXPERTO_NOMBRE || 'Nuestro Experto',
    reminderIntervalHours: parseInt(process.env.REMINDER_INTERVAL_HOURS) || 48,
    maxReminders: parseInt(process.env.MAX_REMINDERS) || 3,
    delayedButtonSeconds: parseInt(process.env.DELAYED_BUTTON_SECONDS) || 300,
  },
};
