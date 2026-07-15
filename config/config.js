require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',

  whatsapp: {
    // Proveedor del canal WhatsApp:
    //   'cloud'   → API oficial de Meta (recomendado, no banea; requiere
    //               WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN)
    //   'baileys' → método no oficial por QR (riesgo de baneo)
    // Si no se fuerza con WHATSAPP_PROVIDER, se autodetecta: cloud cuando hay
    // credenciales de Meta, baileys en caso contrario.
    provider: process.env.WHATSAPP_PROVIDER
      || ((process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) ? 'cloud' : 'baileys'),
    apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v19.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    // Plantilla aprobada en Meta para el PRIMER mensaje (fuera de la ventana
    // de 24h hay que usar plantilla, no texto libre).
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || '',
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'es',
    // ID de la cuenta de WhatsApp Business (WABA). Solo se usa para LEER el
    // texto real de las plantillas aprobadas y poder registrar en el CRM lo
    // que de verdad recibe el lead (no un texto de reserva que no se envía).
    wabaId: process.env.WHATSAPP_WABA_ID || '',
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
    calendlyGrupalUrl: process.env.CALENDLY_GRUPAL_URL || process.env.REUNION_GRUPAL_URL || 'https://calendly.com/arkaitzasr24/presentacion-de-negocio-three-inmobiliaria',
    calendlyIndividualUrl: process.env.CALENDLY_INDIVIDUAL_URL || process.env.CALENDLY_URL || 'https://calendly.com/arkaitzasr24/reunion-1-a-1-three-inmobiliaria',

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
    // Nombre con el que se presenta el agente ("Soy Diego, del equipo de...").
    agenteNombre: process.env.AGENTE_NOMBRE || 'Diego',
    // Quién lleva la reunión 1-a-1, con su rol (se menciona por primera vez con
    // el rol para que el lead sepa quién es: "con Arkaitz, el director del proyecto").
    directorNombre: process.env.DIRECTOR_NOMBRE || 'Arkaitz',
    directorRol: process.env.DIRECTOR_ROL || 'el director del proyecto',
    // Recordatorios a ritmo de 2 al día (cada 12 h).
    reminderIntervalHours: parseInt(process.env.REMINDER_INTERVAL_HOURS) || 12,
    // Cadencia pedida: DOS recordatorios cada 24 h → uno cada 12 h (720 min).
    // Con 4 intentos son 2 días de seguimiento antes de desistir.
    maxReminders: parseInt(process.env.MAX_REMINDERS) || 4,
    reminderIntervalsMinutes: (process.env.REMINDER_INTERVALS_MINUTES || '720,720,720,720')
      .split(',')
      .map((s) => parseInt(s.trim()) || 0),
    // Reunión 22-05/Agente: el botón de agenda aparece tras 1 min de vídeo
    delayedButtonSeconds: parseInt(process.env.DELAYED_BUTTON_SECONDS) || 60,
    // Delay del bot para simular escritura humana (segundos)
    typingDelaySeconds: parseInt(process.env.TYPING_DELAY_SECONDS) || 10,
  },
};
