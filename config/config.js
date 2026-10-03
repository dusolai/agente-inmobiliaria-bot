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
    // ─── Plantillas por SEGMENTO (lanzamiento octubre 2026) ───────
    // Cada segmento de la lista recibe su propio primer mensaje (reuniones
    // 24-09 y 01-10). Son plantillas aprobadas en Meta con la variable
    // {{nombre}} y dos botones de respuesta rápida. Si un segmento no tiene
    // plantilla propia, los "viejos" usan WHATSAPP_TEMPLATE_NAME (la de
    // "reabrimos plazas"); los demás esperan en cola (ver abajo).
    templatesPorSegmento: {
      viejos: process.env.WHATSAPP_TEMPLATE_VIEJOS || process.env.WHATSAPP_TEMPLATE_NAME || '',
      verano: process.env.WHATSAPP_TEMPLATE_VERANO || '',
      septiembre: process.env.WHATSAPP_TEMPLATE_SEPTIEMBRE || '',
      directo: process.env.WHATSAPP_TEMPLATE_DIRECTO || '',
    },
    // Si un segmento no tiene plantilla, ¿usamos la genérica (1) o lo dejamos
    // en cola hasta que la tenga (por defecto)? Mandar a un lead de
    // septiembre el texto de "hace un tiempo mostraste interés" es justo lo
    // que Arkaitz quería evitar, así que por defecto se espera.
    usarPlantillaGenericaSiFalta: process.env.WHATSAPP_PLANTILLA_GENERICA_SI_FALTA === '1',
    // Plantilla para recordar la reserva de la presentación en directo (modo
    // presentación). Sin ella el recordatorio va como texto, que solo llega
    // dentro de la ventana de 24h.
    templateRecordatorioGrupal: process.env.WHATSAPP_TEMPLATE_RECORDATORIO_GRUPAL || '',
  },

  // Canal Telegram (modo piloto previo a producción)
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },

  google: {
    sheetsId: process.env.GOOGLE_SHEETS_ID || '',
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    // Lector automático de la hoja de Karen (leads nuevos en directo).
    sheetsTab: process.env.GOOGLE_SHEETS_TAB || 'DIC25',
    pollMinutes: Math.max(1, parseInt(process.env.SHEETS_POLL_MINUTES, 10) || 10),
    pollEnabled: process.env.SHEETS_POLL_ENABLED !== '0',
    // Solo se dan de alta filas con fecha ≥ SHEETS_DESDE (YYYY-MM-DD). Si
    // falta, se fija el día del primer arranque (lo anterior ya vino del CSV).
    desde: process.env.SHEETS_DESDE || '',
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

  // ─── Segmentos de la lista por fecha del lead (reunión 01-10) ─────
  //   viejos: antes de corteVerano · verano: [corteVerano, corteSeptiembre)
  //   septiembre: desde corteSeptiembre · directo: entran tras el lanzamiento
  segmentos: {
    corteVerano: process.env.SEGMENTO_CORTE_VERANO || '2026-07-01',
    corteSeptiembre: process.env.SEGMENTO_CORTE_SEPTIEMBRE || '2026-09-01',
  },

  // ─── Flujo del embudo ──────────────────────────────────────────
  flujo: {
    // Qué recibe el lead al responder 1/2:
    //   'landing'      → la landing con los vídeos (VSL → webinar → botón 1-a-1).
    //                    Flujo actual, el del lanzamiento de octubre.
    //   'presentacion' → invitación a la PRESENTACIÓN EN DIRECTO (Calendly
    //                    grupal → Zoom); tras asistir se le manda el 1-a-1.
    //                    Decidido el 01-10 como siguiente fase ("formato 30-30");
    //                    se activa cuando Marta/Arkaitz tengan la agenda.
    trasCualificar: process.env.FLUJO_TRAS_CUALIFICAR === 'presentacion' ? 'presentacion' : 'landing',
    // Alta automática de quien escribe al WhatsApp del agente sin ser lead
    // (es el número que Karen pone en el formulario). Se crea en la campaña
    // activa como "directo" y se le hace la pregunta de filtrado.
    autoAltaWhatsapp: process.env.AUTOALTA_WHATSAPP !== '0',
    autoAltaMaxPorHora: parseInt(process.env.AUTOALTA_MAX_HORA, 10) || 20,
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
