const config = require('../config/config');

/**
 * Plantillas de mensajes para el Agente de WhatsApp.
 * Cada función recibe un objeto con las variables necesarias y devuelve el texto final.
 */

// ─── A. Mensaje de Reactivación con pregunta de filtrado (29-05) ──
// Inicia la conversación, personaliza con el nombre y segmenta al lead.
function mensajeReactivacion({ nombre }) {
  return (
    `Hola ${nombre}, ¿qué tal? 👋\n\n` +
    `Hace un tiempo pediste información sobre nuestro proyecto inmobiliario y justo ahora estamos reabriendo nuevas plazas.\n\n` +
    `Antes de enviarte la información, quería preguntarte algo rápido para pasarte directamente a lo que más te encaje:\n\n` +
    `*¿Actualmente trabajas en el sector inmobiliario o estás buscando una oportunidad adicional para generar un sobresueldo?*\n\n` +
    `Responde con el número:\n` +
    `1️⃣ Soy agente / trabajo en una inmobiliaria\n` +
    `2️⃣ Busco una oportunidad para generar un sobresueldo`
  );
}

// Re-pregunta si la respuesta no se entiende
function mensajeReintentarCualificacion({ nombre }) {
  return (
    `Perdona ${nombre}, no te he entendido. 🙏\n\n` +
    `Para enviarte la información correcta, responde con un número:\n` +
    `1️⃣ Soy agente / trabajo en una inmobiliaria\n` +
    `2️⃣ Busco una oportunidad para generar un sobresueldo`
  );
}

// ─── A2. Ramas según el perfil ───────────────────────────────────
function mensajeRamaProfesional({ nombre, enlaceLanding }) {
  return (
    `¡Genial, ${nombre}! 🙌\n\n` +
    `Creo que te puede interesar más la parte profesional: estamos trabajando con agentes y agencias inmobiliarias.\n\n` +
    `Aquí tienes toda la información:\n` +
    `👉 ${enlaceLanding}\n\n` +
    `Cuando la veas, te explico también cómo lo están aplicando otros profesionales del sector. 🎬`
  );
}

function mensajeRamaEmprendedor({ nombre, enlaceLanding }) {
  return (
    `¡Perfecto, ${nombre}! 🚀\n\n` +
    `Lo que más te encaja es nuestro modelo de emprendedores y colaboradores que generan ingresos dentro del sector inmobiliario *sin necesidad de dedicarse profesionalmente a ello*.\n\n` +
    `Te dejo aquí toda la información:\n` +
    `👉 ${enlaceLanding}\n\n` +
    `Échale un vistazo al vídeo y, al terminar, se activará el siguiente paso. 🎬`
  );
}

// ─── A0. (Legacy) Mensaje de Bienvenida directo a vídeo ───────────
function mensajeBienvenida({ nombre, enlaceVideo }) {
  return (
    `¡Hola ${nombre}! 👋 Soy el asistente de ${config.agent.empresaNombre}.\n\n` +
    `Hemos recibido tu solicitud. Para ver si podemos ayudarte, es necesario que veas este breve video explicativo sobre nuestro método. 🎬\n\n` +
    `Míralo aquí ahora:\n` +
    `👉 ${enlaceVideo}\n\n` +
    `⚠️ Importante: solo las personas que vean el video completo recibirán el enlace para poder inscribirse en la presentación privada por Zoom.\n\n` +
    `Al final del video se activará la opción para continuar. ¡Saludos!`
  );
}

// ─── B. Rama "NO vio el video" (Recordatorios cada 48h) ──────────
function recordatorioVideo1({ nombre, enlaceVideo }) {
  return (
    `Hola ${nombre}, noté que no has podido terminar el video aún. 👀\n\n` +
    `Hay un punto clave sobre la oportunidad inmobiliaria que te interesa mucho. Tienes que verlo hasta el final para desbloquear el siguiente paso.\n\n` +
    `👇 Aquí tienes el acceso:\n` +
    `${enlaceVideo}`
  );
}

function recordatorioVideo2({ nombre, enlaceVideo }) {
  return (
    `${nombre}, el acceso al video explicativo caducará pronto. ⏳\n\n` +
    `Si realmente quieres conocer esta oportunidad, este es el primer paso indispensable.\n` +
    `¿Puedes verlo hoy?\n\n` +
    `🎥 ${enlaceVideo}`
  );
}

function recordatorioVideo3({ nombre, enlaceVideo }) {
  return (
    `${nombre}, este es tu último recordatorio. 🔔\n\n` +
    `El acceso a la información del proyecto se cerrará pronto. No queremos que pierdas esta oportunidad.\n\n` +
    `Último acceso:\n` +
    `👉 ${enlaceVideo}`
  );
}

// ─── C. Rama "Sí vio el video" — DOS OPCIONES (15-06) ────────────
// Tras ver el vídeo corto, le ofrecemos VER la presentación completa de 25
// minutos ya mismo (en caliente) o RESERVAR una sesión grupal para verla más
// tarde. El usuario contesta 1 o 2.
function mensajeOpcionesVerPresentacion({ nombre }) {
  return (
    `¡Genial, ${nombre}! 🎉\n\n` +
    `El siguiente paso es la *presentación de negocio completa* (unos 25 min). ` +
    `Puedes verla ya mismo o reservar para verla cuando te venga mejor:\n\n` +
    `1️⃣ *Ver la presentación ahora* (te abrimos el enlace al instante)\n` +
    `2️⃣ *Reservar una sesión grupal* para verla en el horario que te encaje\n\n` +
    `Responde con 1 o 2 y te paso el enlace correspondiente.`
  );
}

function mensajePresentacionVerAhora({ nombre, enlacePresentacion }) {
  return (
    `¡Perfecto, ${nombre}! 🚀\n\n` +
    `Aquí tienes el enlace a la presentación de negocio:\n` +
    `🎥 ${enlacePresentacion}\n\n` +
    `Cuando termines de verla, te activamos el siguiente paso: una *reunión 1-a-1* ` +
    `con Arkaitz para resolver dudas y diseñar tu plan de entrada.`
  );
}

function mensajePresentacionReservar({ nombre, enlaceReunion }) {
  return (
    `¡Listo, ${nombre}! 📅\n\n` +
    `Reserva tu plaza para la sesión grupal en el horario que te encaje:\n` +
    `🔗 ${enlaceReunion}\n\n` +
    `Tras la sesión te activamos la *reunión 1-a-1* con Arkaitz.`
  );
}

// Reintento si la respuesta a la opción no se entiende
function mensajeReintentarOpciones({ nombre }) {
  return (
    `Perdona ${nombre}, no te he entendido. 🙏\n\n` +
    `Responde con un número:\n` +
    `1️⃣ Ver la presentación ahora\n` +
    `2️⃣ Reservar una sesión grupal para verla más tarde`
  );
}

// (Legacy: se mantiene por compatibilidad pero ya no se usa directamente)
function mensajeVideoVisto({ nombre, enlaceReunion }) {
  return (
    `¡Genial, ${nombre}! He visto que terminaste el video. 🎉\n\n` +
    `Por si se cerró la página antes de reservar, aquí tienes el enlace directo a la Sesión Grupal de Estrategia:\n\n` +
    `Reserva tu plaza aquí:\n` +
    `📅 ${enlaceReunion}\n\n` +
    `Las plazas son limitadas y se asignan por orden de inscripción.`
  );
}

// ─── D. Rama "NO asistió a la reunión" (Recordatorios cada 48h) ──
function recordatorioReunion1({ nombre, enlaceReunion }) {
  return (
    `Hola ${nombre}, te echamos de menos en la sesión de ayer. 😔\n\n` +
    `Hubo preguntas muy interesantes. No quiero que pierdas la oportunidad, ¿te va bien agendar para la próxima?\n\n` +
    `🗓 ${enlaceReunion}`
  );
}

function recordatorioReunion2({ nombre, enlaceReunion }) {
  return (
    `${nombre}, ¿sigues interesado en el proyecto inmobiliario? 🤔\n\n` +
    `He visto que no pudiste sumarte. Intenta reservar con tiempo aquí:\n` +
    `🔗 ${enlaceReunion}\n\n` +
    `Si ya no te interesa, ignora este mensaje.`
  );
}

function recordatorioReunion3({ nombre, enlaceReunion }) {
  return (
    `${nombre}, última oportunidad de reagendar tu sesión grupal. 📌\n\n` +
    `Después de este mensaje no podremos insistir más.\n\n` +
    `🗓 ${enlaceReunion}`
  );
}

// ─── E. Rama "Sí asistió a la reunión" (Cierre grupal → individual) ─
// Tras la sesión grupal, al interesado se le ofrece una reunión individual (29-05).
function mensajeCierre({ nombre, enlaceCalendly }) {
  return (
    `¡Hola ${nombre}! Gracias por participar en la sesión de hoy. 🙌\n\n` +
    `Ya tienes toda la información. Si quieres dar el paso e iniciar en el proyecto, puedes reservar una *reunión individual* para verlo en detalle.\n\n` +
    `Agenda tu hueco personal aquí (plazas limitadas):\n` +
    `✅ ${enlaceCalendly}`
  );
}

// ─── F. Mensaje de Desistimiento Final (4º intento) ──────────────
// Pide al lead que comparta la razón para mejorar el sistema y deja la
// puerta abierta a retomar en el futuro (reunión final 15-06).
function mensajeDescarte({ nombre }) {
  return (
    `Hola ${nombre}, hemos intentado contactar contigo varias veces y entendemos ` +
    `que quizás no era el momento adecuado. 🙏\n\n` +
    `Antes de dar por cerrada tu petición, *¿te importaría compartirnos brevemente* ` +
    `*el motivo?* Cualquier respuesta nos ayuda muchísimo a mejorar para ` +
    `próximas personas.\n\n` +
    `Y por supuesto, la puerta queda abierta: si más adelante quieres ` +
    `retomar el tema, solo tienes que escribirnos.\n\n` +
    `Un saludo y mucha suerte 🤝\n` +
    `— ${config.agent.empresaNombre}`
  );
}

module.exports = {
  mensajeReactivacion,
  mensajeReintentarCualificacion,
  mensajeRamaProfesional,
  mensajeRamaEmprendedor,
  mensajeBienvenida,
  recordatorioVideo1,
  recordatorioVideo2,
  recordatorioVideo3,
  mensajeOpcionesVerPresentacion,
  mensajePresentacionVerAhora,
  mensajePresentacionReservar,
  mensajeReintentarOpciones,
  mensajeVideoVisto,
  recordatorioReunion1,
  recordatorioReunion2,
  recordatorioReunion3,
  mensajeCierre,
  mensajeDescarte,
};
