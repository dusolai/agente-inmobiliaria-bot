const config = require('../config/config');

/**
 * Plantillas de mensajes para el Agente de WhatsApp/Telegram.
 * Tono: cercano, humano, como si fuera Arkaitz escribiendo desde su móvil.
 * Reglas: frases cortas, sin asteriscos en negrita salvo opciones 1/2,
 * un emoji máximo (a veces ninguno), variar arranques y muletillas.
 */

// ─── A. Mensaje inicial — pregunta de filtrado ────────────────────
// Varias redacciones del mismo mensaje, elegidas al azar: cientos de envíos
// con texto idéntico es el patrón que los filtros antispam de WhatsApp
// detectan primero. Mismo contenido, distinta forma.
const VARIANTES_REACTIVACION = [
  ({ nombre }) =>
    `¡Hola ${nombre}! 👋 Soy del equipo de Three Inmobiliaria.\n\n` +
    `Hace un tiempo mostraste interés en el proyecto, y te escribo porque justo ahora estamos reabriendo plazas para sumar gente nueva — y me acordé de ti.\n\n` +
    `Antes de mandarte nada, dime una cosa rápida para pasarte exactamente lo que te encaja (y no hacerte perder el tiempo):\n\n` +
    `¿Trabajas en el sector inmobiliario, o más bien buscas una forma de generar un ingreso extra?\n\n` +
    `1️⃣ Soy agente / trabajo en una inmobiliaria\n` +
    `2️⃣ Busco un sobresueldo / ingreso extra\n\n` +
    `Respóndeme con el 1 o el 2 y seguimos 🙂`,
  ({ nombre }) =>
    `¡Hola ${nombre}! ¿Cómo va todo? 👋\n\n` +
    `Te escribo del equipo de Three Inmobiliaria. En su día dejaste tus datos interesándote por el proyecto, y ahora mismo estamos abriendo plazas de nuevo, así que quería contactarte personalmente.\n\n` +
    `Para mandarte justo la información que te sirva, cuéntame una cosa:\n\n` +
    `¿Lo tuyo es el sector inmobiliario, o buscas más bien un ingreso extra?\n\n` +
    `1️⃣ Trabajo en el sector inmobiliario\n` +
    `2️⃣ Busco generar un ingreso extra\n\n` +
    `Con que me digas 1 o 2 me vale, y te lo paso 👌`,
  ({ nombre }) =>
    `¡Buenas ${nombre}! 👋 Del equipo de Three Inmobiliaria.\n\n` +
    `Estamos retomando el contacto con gente que se interesó por el proyecto, porque acabamos de reabrir plazas y hay una buena oportunidad ahora mismo.\n\n` +
    `Una pregunta rápida antes de nada, para orientarte bien:\n\n` +
    `¿Eres del sector inmobiliario, o lo que buscas es más un sobresueldo?\n\n` +
    `1️⃣ Soy agente / trabajo en inmobiliaria\n` +
    `2️⃣ Busco un ingreso extra\n\n` +
    `Dime el número que toque y seguimos 🙂`,
];

function mensajeReactivacion({ nombre }) {
  const variante = VARIANTES_REACTIVACION[Math.floor(Math.random() * VARIANTES_REACTIVACION.length)];
  return variante({ nombre });
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
// Tras cualificar, enviamos la presentación (landing con los vídeos) DIRECTAMENTE.
// En la landing ven primero el VSL, luego se desbloquea el webinar, y al
// terminarlo aparece el botón para reservar la reunión 1 a 1. El Calendly
// grupal queda como OPCIÓN secundaria por si prefieren verlo en directo.
function mensajeRamaProfesional({ nombre, enlaceLanding, enlaceGrupal }) {
  return (
    `¡Genial ${nombre}!\n\n` +
    `Aquí tienes la presentación completa del proyecto. Empieza por el vídeo corto y, según avanzas, se desbloquea el resto:\n` +
    `${enlaceLanding}\n\n` +
    `Cuando termines, en la propia página se activa el botón para reservar tu reunión 1 a 1 con Arkaitz 🎯` +
    (enlaceGrupal ? `\n\n¿Prefieres verlo en directo con nosotros? También puedes reservar aquí:\n${enlaceGrupal}` : '')
  );
}

function mensajeRamaEmprendedor({ nombre, enlaceLanding, enlaceGrupal }) {
  return (
    `Entendido ${nombre} 🚀\n\n` +
    `Aquí tienes la presentación, va al grano. Verás primero un vídeo corto y, según avanzas, se desbloquea el resto:\n` +
    `${enlaceLanding}\n\n` +
    `Al terminar, en la misma página se activa el botón para reservar tu reunión 1 a 1 con Arkaitz.` +
    (enlaceGrupal ? `\n\n¿Prefieres verlo en directo? También puedes reservar aquí:\n${enlaceGrupal}` : '')
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

// ─── B2. Recordatorios "no reservó el grupal" (estado video_enviado) ─
// El lead recibió el Calendly grupal tras cualificar pero no ha reservado.
// Se le reenvía el enlace de reserva, NO la landing (aún no le toca).
function recordatorioGrupal1({ nombre, enlaceCalendly }) {
  return (
    `Oye ${nombre}, vi que no llegaste a reservar tu hueco para la presentación 👀\n\n` +
    `Es el primer paso y son dos clics. Te dejo el enlace otra vez:\n` +
    `${enlaceCalendly}`
  );
}

function recordatorioGrupal2({ nombre, enlaceCalendly }) {
  return (
    `${nombre}, una cosa: estamos cerrando los huecos de esta semana.\n\n` +
    `Si te sigue interesando, reserva el tuyo hoy:\n` +
    `${enlaceCalendly}`
  );
}

function recordatorioGrupal3({ nombre, enlaceCalendly }) {
  return (
    `${nombre}, último aviso por mi parte 🔔\n\n` +
    `Vamos a cerrar plazas en breve. Si quieres entrar, reserva aquí:\n` +
    `${enlaceCalendly}\n\n` +
    `Si no es el momento, no pasa nada, ignora este mensaje.`
  );
}

// ─── B3. Recordatorios "entró al funnel y lo dejó a medias" ───────
// Estado video_visto: reservó el grupal y tiene la landing, pero no ha
// llegado a pulsar el botón de agendar. La etapa se deduce del registro
// de actividad del lead:
//   'inicio'  → no llegó a darle al play al primer vídeo
//   'vsl'     → empezó el vídeo corto pero no lo terminó
//   'webinar' → desbloqueó el webinar pero no llegó al final
function _lineaEtapaFunnel(etapa) {
  if (etapa === 'webinar') {
    return 'empezaste el webinar pero te quedaste a mitad — justo al final está lo importante';
  }
  if (etapa === 'vsl') {
    return 'no llegaste a terminar el primer vídeo';
  }
  return 'aún no has entrado a ver la presentación';
}

function recordatorioFunnel1({ nombre, enlaceLanding, etapa }) {
  return (
    `Oye ${nombre}, vi que ${_lineaEtapaFunnel(etapa)} 👀\n\n` +
    `Retomas justo donde lo dejaste. Te dejo el acceso otra vez:\n` +
    `${enlaceLanding}`
  );
}

function recordatorioFunnel2({ nombre, enlaceLanding, etapa }) {
  return (
    `${nombre}, el acceso a la presentación lo vamos a cerrar pronto.\n\n` +
    `Vi que ${_lineaEtapaFunnel(etapa)}. ¿Puedes terminarla hoy?\n` +
    `${enlaceLanding}`
  );
}

function recordatorioFunnel3({ nombre, enlaceLanding, etapa }) {
  return (
    `${nombre}, último aviso por mi parte 🔔\n\n` +
    `Vamos a cerrar el acceso en breve. Lo tienes aquí:\n` +
    `${enlaceLanding}\n\n` +
    `Si no es el momento, no pasa nada, ignora este mensaje.`
  );
}

// ─── D2. Recordatorios "no reservó el 1-a-1" (reunion_registrado) ─
// El lead terminó el webinar y pulsó agendar (se le envió el enlace del
// 1-a-1) pero no ha reservado. Se le reenvía el enlace individual.
function recordatorio1a1Primero({ nombre, enlace1a1 }) {
  return (
    `Oye ${nombre}, vi que no llegaste a reservar tu reunión 1 a 1 con Arkaitz 👀\n\n` +
    `Es el último paso. Coge tu hueco aquí:\n` +
    `${enlace1a1}`
  );
}

function recordatorio1a1Segundo({ nombre, enlace1a1 }) {
  return (
    `${nombre}, los huecos de la agenda de Arkaitz van volando.\n\n` +
    `Si quieres ver tu caso con él, reserva hoy:\n` +
    `${enlace1a1}`
  );
}

function recordatorio1a1Tercero({ nombre, enlace1a1 }) {
  return (
    `${nombre}, te escribo por última vez por aquí 📌\n\n` +
    `Si quieres dar el paso, este es el momento:\n` +
    `${enlace1a1}\n\n` +
    `Si no, lo dejamos estar y todo bien por mi parte.`
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
  recordatorioGrupal1,
  recordatorioGrupal2,
  recordatorioGrupal3,
  recordatorioFunnel1,
  recordatorioFunnel2,
  recordatorioFunnel3,
  recordatorio1a1Primero,
  recordatorio1a1Segundo,
  recordatorio1a1Tercero,
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
