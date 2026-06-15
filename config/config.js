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

  // Canal Telegram (modo piloto previo a producción)
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
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
    // Secret Token de las Event Subscriptions de la app Server-to-Server.
    // Se usa para verificar la firma de los webhooks entrantes.
    webhookSecretToken: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '',
    // Si el lead estuvo al menos estos minutos en la sala, se considera
    // que asistió y se le envía el cierre 1-a-1.
    minutosAsistenciaValida: parseInt(process.env.ZOOM_MIN_MINUTES) || 20,
  },

  // URL pública del propio backend (la que se usa en los enlaces que envía el
  // agente, p. ej. el redirector /r/grupal?l=...). En Seenode se configura
  // con BACKEND_PUBLIC_URL para que apunte al dominio real.
  backendPublicUrl:
    process.env.BACKEND_PUBLIC_URL ||
    'https://web-78t58qun41lt.up-de-fra1-k8s-1.apps.run-on-seenode.com',

  landing: {
    vslVideoUrl: process.env.VSL_VIDEO_URL || 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    landingUrl: process.env.LANDING_URL || 'https://three-inmobiliaria-emprende.pages.dev/',

    // Dos landing pages reales según el perfil del lead (reunión 29-05).
    // Profesional → agentes inmobiliarios | Emprendedor → sobresueldo/colaboradores.
    landingProfesionalUrl: process.env.LANDING_PROFESIONAL_URL || 'https://threeinmobiliaria.pages.dev/',
    landingEmprendedorUrl: process.env.LANDING_EMPRENDEDOR_URL || 'https://three-inmobiliaria-emprende.pages.dev/',

    // Dos integraciones de Calendly: grupal (genérica) e individual (post-cierre)
    calendlyGrupalUrl: process.env.CALENDLY_GRUPAL_URL || process.env.REUNION_GRUPAL_URL || '#',
    calendlyIndividualUrl: process.env.CALENDLY_INDIVIDUAL_URL || process.env.CALENDLY_URL || '#',

    // Compatibilidad con nombres antiguos
    calendlyUrl: process.env.CALENDLY_URL || '#',
    reunionGrupalUrl: process.env.REUNION_GRUPAL_URL || '#',

    // URL del vídeo de presentación de negocio de 25 min (la que va después
    // del primer vídeo corto). Si el lead elige "Ver ahora" tras el vídeo
    // corto, le mandamos esta URL a través del redirector con tracking.
    presentacionVideoUrl: process.env.PRESENTACION_VIDEO_URL || '#',
  },

  agent: {
    empresaNombre: process.env.EMPRESA_NOMBRE || 'Three Inmobiliaria',
    expertoNombre: process.env.EXPERTO_NOMBRE || 'Nuestro Experto',
    // Reunión 22-05: recordatorios cada 24 h (antes 48)
    reminderIntervalHours: parseInt(process.env.REMINDER_INTERVAL_HOURS) || 24,
    // Reunión final 15-06: secuencia de 4 intentos (5 min, 24h, 48h, 72h)
    // antes de desistir y pedir la razón.
    maxReminders: parseInt(process.env.MAX_REMINDERS) || 4,
    reminderIntervalsMinutes: (process.env.REMINDER_INTERVALS_MINUTES || '5,1440,2880,4320')
      .split(',')
      .map((s) => parseInt(s.trim()) || 0),
    // Reunión 22-05/Agente: el botón de agenda aparece tras 1 min de vídeo
    delayedButtonSeconds: parseInt(process.env.DELAYED_BUTTON_SECONDS) || 60,
    // Delay del bot para simular escritura humana (segundos)
    typingDelaySeconds: parseInt(process.env.TYPING_DELAY_SECONDS) || 10,
  },
};
