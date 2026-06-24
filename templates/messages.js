const config = require('../config/config');

/**
 * Plantillas de mensajes para el Agente de WhatsApp/Telegram.
 * Tono: cercano, humano, como si fuera Arkaitz escribiendo desde su móvil.
 * Reglas: frases cortas, sin asteriscos en negrita salvo opciones 1/2,
 * un emoji máximo (a veces ninguno), variar arranques y muletillas.
 */

// ─── A. Mensaje inicial — pregunta de filtrado ────────────────────
function mensajeReactivacion({ nombre }) {
  return (
    `Hey ${nombre}, ¿qué tal? 👋\n\n` +
    `Soy del equipo de Three Inmobiliaria. Hace un tiempo te interesaste por el proyecto y justo ahora estamos reabriendo plazas.\n\n` +
    `Antes de mandarte info quería preguntarte una cosa rápida, así te paso lo que de verdad te encaje y no perdemos tiempo:\n\n` +
    `¿Trabajas en el sector inmobiliario o más bien estás buscando un sobresueldo / forma de generar ingresos extra?\n\n` +
    `1️⃣ Soy agente o trabajo en una inmobiliaria\n` +
    `2️⃣ Busco un sobresueldo / ingreso extra\n\n` +
    `Contéstame con el número que toque 🙂`
  );
}

// Re-pregunta si la respuesta no se entiende
function mensajeReintentarCualificacion({ nombre }) {
  return (
    `Perdona ${nombre}, igual no me he explicado bien.\n\n` +
    `Solo necesito que me digas un número para mandarte la info correcta:\n\n` +
    `1 → si trabajas en el sector inmobiliario\n` +
    `2 → si buscas generar ingresos extra`
  );
}

// ─── A2. Ramas según el perfil ───────────────────────────────────
// Tras cualificar, enviamos directamente el Calendly grupal — el lead se
// compromete reservando hueco; a la hora reservada (o antes) le llega el
// acceso a la presentación.
function mensajeRamaProfesional({ nombre, enlaceCalendly }) {
  return (
    `¡Genial ${nombre}!\n\n` +
    `Tenemos una presentación de 25 min con todo lo que necesitas saber. Para que sea el momento perfecto, reserva tu hueco (slots cada 15 min):\n\n` +
    `${enlaceCalendly}\n\n` +
    `En cuanto reserves te paso el enlace al instante 🎬`
  );
}

function mensajeRamaEmprendedor({ nombre, enlaceCalendly }) {
  return (
    `Entendido ${nombre} 🚀\n\n` +
    `Lo que hacemos lo explicamos en una presentación de 25 min — va al grano. Reserva tu hueco aquí (slots cada 15 min):\n\n` +
    `${enlaceCalendly}\n\n` +
    `En cuanto reserves te paso el acceso al vídeo.`
  );
}

// Justo después de reservar en Calendly grupal: enviamos el acceso a la
// landing con el vídeo. Pueden verlo ya o esperar a su hora reservada.
function mensajeAccesoVideoTrasReserva({ nombre, enlaceLanding }) {
  return (
    `¡Listo ${nombre}! Tu hueco está reservado ✅\n\n` +
    `Aquí tienes el acceso a la presentación. Puedes verla ya mismo o a la hora que reservaste, como prefieras:\n` +
    `${enlaceLanding}\n\n` +
    `Cuando termines el vídeo, en la propia página se activa el botón para reservar tu reunión 1 a 1 con Arkaitz 🎯`
  );
}

// Tras ver el vídeo (CTA pulsado en la landing): enviamos el Calendly 1-a-1.
function mensajeAcceso1a1({ nombre, enlace1a1 }) {
  return (
    `¡Bien ${nombre}! 🙌\n\n` +
    `Último paso: una reunión 1 a 1 con Arkaitz por Zoom para ver tu caso y diseñar tu entrada al proyecto.\n\n` +
    `Reserva el hueco que mejor te encaje:\n` +
    `${enlace1a1}\n\n` +
    `Los huecos vuelan, intenta cogerlo cuanto antes.`
  );
}

// ─── A0. (Legacy) Mensaje de Bienvenida directo a vídeo ───────────
function mensajeBienvenida({ nombre, enlaceVideo }) {
  return (
    `Hola ${nombre} 👋\n\n` +
    `Soy del equipo de ${config.agent.empresaNombre}. Tenemos pendiente tu solicitud.\n\n` +
    `Antes de seguir, échale un vistazo a este vídeo corto — te resume cómo funciona todo:\n` +
    `${enlaceVideo}\n\n` +
    `Al final del vídeo se desbloquea el siguiente paso. Cualquier cosa, me escribes.`
  );
}

// ─── B. Rama "NO vio el video" — Recordatorios ───────────────────
function recordatorioVideo1({ nombre, enlaceVideo }) {
  return (
    `Oye ${nombre}, vi que no llegaste a terminar el vídeo 👀\n\n` +
    `Hay una parte hacia el final que es la que de verdad explica de qué va esto. Si te interesa el tema, merece la pena verlo hasta el final.\n\n` +
    `Te lo dejo otra vez por si lo perdiste:\n` +
    `${enlaceVideo}`
  );
}

function recordatorioVideo2({ nombre, enlaceVideo }) {
  return (
    `${nombre}, una cosa: el acceso al vídeo lo vamos a cerrar pronto.\n\n` +
    `Si te sigue interesando, es literalmente el primer paso. ¿Puedes verlo hoy?\n\n` +
    `${enlaceVideo}`
  );
}

function recordatorioVideo3({ nombre, enlaceVideo }) {
  return (
    `${nombre}, último aviso por mi parte 🔔\n\n` +
    `Vamos a cerrar las plazas en breve. Si todavía te interesa entrar:\n` +
    `${enlaceVideo}\n\n` +
    `Si no es el momento, no pasa nada, ignora este mensaje.`
  );
}

// ─── C. Rama "Sí vio el video" — DOS OPCIONES ────────────────────
function mensajeOpcionesVerPresentacion({ nombre }) {
  return (
    `¡Bien ${nombre}! 🙌\n\n` +
    `El siguiente paso es la presentación completa del modelo de negocio (unos 25 min). Va al grano.\n\n` +
    `¿Cómo lo prefieres?\n\n` +
    `1️⃣ Verla ahora — te paso el enlace al momento\n` +
    `2️⃣ Reservarla para luego — eliges hueco y te aviso\n\n` +
    `Solo dime 1 o 2 👌`
  );
}

function mensajePresentacionVerAhora({ nombre, enlacePresentacion }) {
  return (
    `Genial ${nombre}, vamos al lío 🚀\n\n` +
    `Aquí lo tienes:\n` +
    `${enlacePresentacion}\n\n` +
    `Tómatelo con calma, son 25 min. Cuando termines te activamos una reunión 1 a 1 con Arkaitz para resolver dudas y ver tu plan de entrada.`
  );
}

// Confirmación tras reservar en Calendly: le mandamos el enlace de la
// presentación directo, así no depende solo del email recordatorio de Calendly.
function mensajeReservaConfirmada({ nombre, enlacePresentacion }) {
  return (
    `¡Listo ${nombre}! 🙌 Tu hueco está reservado.\n\n` +
    `Te dejo el enlace de la presentación aquí mismo para que lo tengas a mano:\n` +
    `${enlacePresentacion}\n\n` +
    `Te avisaré justo antes de tu hora con un recordatorio. Si necesitas cambiar el horario, lo gestionamos sin problema.`
  );
}

function mensajePresentacionReservar({ nombre, enlaceReunion }) {
  return (
    `Perfecto ${nombre}, así con tranquilidad mejor 📅\n\n` +
    `Reserva el hueco que mejor te encaje:\n` +
    `${enlaceReunion}\n\n` +
    `Te mandaré un recordatorio justo antes para que no se te pase. Y al terminar, abrimos la reunión 1 a 1 con Arkaitz.`
  );
}

// Reintento si la respuesta a la opción no se entiende
function mensajeReintentarOpciones({ nombre }) {
  return (
    `Perdona ${nombre}, no te pillé.\n\n` +
    `1 → la veo ahora\n` +
    `2 → me la reservo para luego`
  );
}

// Legacy (compat)
function mensajeVideoVisto({ nombre, enlaceReunion }) {
  return (
    `¡Genial ${nombre}! Vi que terminaste el vídeo 🎉\n\n` +
    `Por si se te cerró antes de reservar, te dejo el enlace directo:\n` +
    `${enlaceReunion}\n\n` +
    `Las plazas vuelan, te aviso.`
  );
}

// ─── D. Rama "NO asistió a la reunión" — Recordatorios ───────────
function recordatorioReunion1({ nombre, enlaceReunion }) {
  return (
    `Hey ${nombre}, te echamos en falta en la sesión 😔\n\n` +
    `Salió chula, mucha gente preguntando cosas interesantes. ¿Te apetece coger hueco para la próxima?\n\n` +
    `${enlaceReunion}`
  );
}

function recordatorioReunion2({ nombre, enlaceReunion }) {
  return (
    `${nombre}, ¿te sigue cuadrando lo del proyecto? Cuéntame.\n\n` +
    `Si quieres reagendar, aquí tienes:\n` +
    `${enlaceReunion}\n\n` +
    `Y si ahora mismo no es el momento, dímelo y te dejo en paz, sin problema.`
  );
}

function recordatorioReunion3({ nombre, enlaceReunion }) {
  return (
    `${nombre}, te escribo por última vez por aquí 📌\n\n` +
    `Si quieres entrar, este es el momento:\n` +
    `${enlaceReunion}\n\n` +
    `Si no, lo dejamos estar y todo bien por mi parte.`
  );
}

// ─── E. Cierre tras asistir a la reunión (envío 1-a-1) ───────────
function mensajeCierre({ nombre, enlaceCalendly }) {
  return (
    `¡${nombre}! Mil gracias por sumarte hoy 🙌\n\n` +
    `Ya tienes una idea bastante completa del proyecto. Si te ves dentro y quieres dar el paso, te toca una reunión 1 a 1 conmigo para verlo a tu caso concreto.\n\n` +
    `Agenda aquí tu hueco (van por orden, intenta cogerlo cuanto antes):\n` +
    `${enlaceCalendly}`
  );
}

// ─── F. Mensaje de desistimiento final ───────────────────────────
function mensajeDescarte({ nombre }) {
  return (
    `Hola ${nombre}, te he escrito varias veces y no ha habido manera, así que entiendo que ahora mismo no es tu momento — todo bien.\n\n` +
    `Antes de cerrarte el contacto, ¿te importaría decirme en una línea qué te ha frenado? No para insistir, solo para que mejoremos cómo lo planteamos a la próxima persona.\n\n` +
    `Y si más adelante quieres retomarlo, me escribes y seguimos donde lo dejamos.\n\n` +
    `Un abrazo,\n` +
    `— ${config.agent.empresaNombre}`
  );
}

module.exports = {
  mensajeReactivacion,
  mensajeReintentarCualificacion,
  mensajeRamaProfesional,
  mensajeRamaEmprendedor,
  mensajeAccesoVideoTrasReserva,
  mensajeAcceso1a1,
  mensajeBienvenida,
  recordatorioVideo1,
  recordatorioVideo2,
  recordatorioVideo3,
  mensajeOpcionesVerPresentacion,
  mensajePresentacionVerAhora,
  mensajePresentacionReservar,
  mensajeReservaConfirmada,
  mensajeReintentarOpciones,
  mensajeVideoVisto,
  recordatorioReunion1,
  recordatorioReunion2,
  recordatorioReunion3,
  mensajeCierre,
  mensajeDescarte,
};
