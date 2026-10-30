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
    `¡Hola ${nombre}! 👋 Soy ${config.agent.agenteNombre}, del equipo de Three Inmobiliaria.\n\n` +
    `Hace un tiempo mostraste interés en el proyecto, y te escribo porque justo ahora estamos reabriendo plazas para sumar gente nueva — y me acordé de ti.\n\n` +
    `Antes de mandarte nada, dime una cosa rápida para pasarte exactamente lo que te encaja (y no hacerte perder el tiempo):\n\n` +
    `¿Trabajas en el sector inmobiliario, o más bien buscas una forma de generar un ingreso extra?\n\n` +
    `1️⃣ Soy agente / trabajo en una inmobiliaria\n` +
    `2️⃣ Busco un sobresueldo / ingreso extra\n\n` +
    `Respóndeme con el 1 o el 2 y seguimos 🙂`,
  ({ nombre }) =>
    `¡Hola ${nombre}! ¿Cómo va todo? 👋\n\n` +
    `Soy ${config.agent.agenteNombre}, del equipo de Three Inmobiliaria. En su día dejaste tus datos interesándote por el proyecto, y ahora mismo estamos abriendo plazas de nuevo, así que quería contactarte personalmente.\n\n` +
    `Para mandarte justo la información que te sirva, cuéntame una cosa:\n\n` +
    `¿Lo tuyo es el sector inmobiliario, o buscas más bien un ingreso extra?\n\n` +
    `1️⃣ Trabajo en el sector inmobiliario\n` +
    `2️⃣ Busco generar un ingreso extra\n\n` +
    `Con que me digas 1 o 2 me vale, y te lo paso 👌`,
  ({ nombre }) =>
    `¡Buenas ${nombre}! 👋 Soy ${config.agent.agenteNombre}, del equipo de Three Inmobiliaria.\n\n` +
    `Estamos retomando el contacto con gente que se interesó por el proyecto, porque acabamos de reabrir plazas y hay una buena oportunidad ahora mismo.\n\n` +
    `Una pregunta rápida antes de nada, para orientarte bien:\n\n` +
    `¿Eres del sector inmobiliario, o lo que buscas es más un sobresueldo?\n\n` +
    `1️⃣ Soy agente / trabajo en inmobiliaria\n` +
    `2️⃣ Busco un ingreso extra\n\n` +
    `Dime el número que toque y seguimos 🙂`,
];

// ─── Mensajes por SEGMENTO (lanzamiento octubre 2026) ────────────
// Textos acordados por Arkaitz y Diego (30-09, tras la reunión del 24-09).
// En la API oficial el primer contacto va como PLANTILLA aprobada en Meta
// con estos mismos cuerpos (PLANTILLAS_META, con {{nombre}} y dos botones de
// respuesta rápida). Estos textos se usan tal cual en Baileys/Telegram y
// como referencia para dar de alta las plantillas; en texto libre se añaden
// las opciones 1/2 porque ahí no hay botones.
const OPCIONES_TEXTO =
  `\n\n1️⃣ Trabajo en el sector inmobiliario\n` +
  `2️⃣ Busco ingresos extra\n\n` +
  `Respóndeme con el 1 o el 2 y seguimos 🙂`;

const PLANTILLAS_META = {
  viejos: {
    nombreSugerido: 'reactivacion_viejos',
    variable: 'WHATSAPP_TEMPLATE_VIEJOS',
    cuerpo:
      `¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.\n\n` +
      `Hace unos meses mostraste interés en nuestro proyecto y, como hemos renovado la presentación con muchas novedades, quería retomar el contacto contigo. 😊\n\n` +
      `Antes de enviarte nada, una pregunta rápida para saber qué puede encajarte mejor:\n\n` +
      `👉 ¿Actualmente trabajas en el sector inmobiliario 🏠 o estás buscando una oportunidad para generar ingresos extra? 💰`,
  },
  verano: {
    nombreSugerido: 'reactivacion_verano',
    variable: 'WHATSAPP_TEMPLATE_VERANO',
    cuerpo:
      `¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.\n\n` +
      `Con el verano de por medio, estamos retomando estos días el contacto con las personas que mostraron interés en nuestro proyecto durante julio y agosto.\n\n` +
      `Antes de enviarte toda la información, quería preguntarte algo muy rápido para saber qué puede encajarte mejor:\n\n` +
      `👉 ¿Actualmente trabajas en el sector inmobiliario 🏠 o estás buscando una oportunidad para generar ingresos extra? 💰`,
  },
  septiembre: {
    nombreSugerido: 'reactivacion_septiembre',
    variable: 'WHATSAPP_TEMPLATE_SEPTIEMBRE',
    cuerpo:
      `¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.\n\n` +
      `Hace unos días mostraste interés en nuestro proyecto y quería ponerme en contacto contigo para contarte cómo funciona y las novedades que tenemos actualmente. 😊\n\n` +
      `Antes de enviarte información, una pregunta rápida para orientarte mejor:\n\n` +
      `👉 ¿Actualmente trabajas en el sector inmobiliario 🏠 o estás buscando una oportunidad para generar ingresos extra?`,
  },
  directo: {
    nombreSugerido: 'bienvenida_directo',
    variable: 'WHATSAPP_TEMPLATE_DIRECTO',
    cuerpo:
      `¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.\n\n` +
      `He visto que acabas de mostrar interés en nuestro proyecto y quería contactar contigo para conocer un poquito mejor qué estás buscando 😊\n\n` +
      `Antes de enviarte información, una pregunta rápida:\n\n` +
      `👉 ¿Ya trabajas en el sector inmobiliario 🏠 o estás buscando una nueva oportunidad para generar ingresos? 💰`,
  },
  // Recordatorio ÚNICO a quien no contestó (WHATSAPP_TEMPLATE_RECORDATORIO_CUALIFICACION).
  // Texto distinto al primero y salida fácil: mejor un "No me interesa" que
  // un bloqueo o una denuncia de spam (es lo que hunde la cuenta).
  recordatorio: {
    nombreSugerido: 'recordatorio_cualificacion',
    variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_CUALIFICACION',
    cuerpo:
      `Hola {{nombre}}, te escribí hace un par de días desde Three Inmobiliaria y no quiero ser pesado 🙂\n\n` +
      `Si todavía te interesa conocer el proyecto, dime si trabajas en el sector inmobiliario o buscas ingresos extra y te paso la información.\n\n` +
      `Si no es para ti, pulsa "No me interesa" y no te volveremos a escribir.`,
  },
  // Botones de respuesta rápida de TODAS las plantillas (máx. 25 caracteres).
  // El flujo reconoce "agente" / "ingreso(s)" y trata "No me interesa" como
  // BAJA inmediata (sin más mensajes). El tercer botón es el que evita que,
  // quien no quiere, nos bloquee.
  botones: ['Soy agente inmobiliario', 'Busco ingresos extra', 'No me interesa'],
  // Recordatorios de mitad de embudo (cuenta nueva de Three). Botones propios.
  recordatorio_presentacion: {
    nombreSugerido: 'recordatorio_presentacion_three',
    variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_PRESENTACION',
    cuerpo:
      `Hola {{nombre}} 👋 Te escribo de Three Inmobiliaria.\n\n` +
      `Vi que todavía no has terminado la presentación. Si tienes dudas, lo más rápido es la sesión de dudas en grupo con Arkaitz por Zoom: 30 min, gratis y sin compromiso.\n\n` +
      `¿Te paso el enlace para elegir día? Si ya no te interesa, pulsa "No me interesa" y no te escribimos más.`,
    botones: ['Pásame el enlace', 'No me interesa'],
  },
  recordatorio_sesion: {
    nombreSugerido: 'recordatorio_sesion_three',
    variable: 'WHATSAPP_TEMPLATE_RECORDATORIO_SESION',
    cuerpo:
      `Hola {{nombre}} 👋 Te escribo de Three Inmobiliaria.\n\n` +
      `Ya viste la presentación: el siguiente paso es la sesión de dudas en grupo con Arkaitz por Zoom (30 min), donde puedes preguntar todo en directo.\n\n` +
      `¿Te paso el enlace para elegir día? Si no es para ti, pulsa "No me interesa".`,
    botones: ['Sí, pásame el enlace', 'No me interesa'],
  },
  // Tras RESERVAR la sesión (18-10): que lleguen con la presentación vista y
  // que no falten. Los botones los reconoce el flujo (BOTONES_SESION).
  sesion_preparacion: {
    nombreSugerido: 'sesion_preparacion_three',
    variable: 'WHATSAPP_TEMPLATE_SESION_PREPARACION',
    cuerpo:
      `Hola {{nombre}} 👋 Te escribo de Three Inmobiliaria.\n\n` +
      `Ya tienes reservada tu sesión de dudas con Arkaitz. Para sacarle el máximo partido, ¿has podido ver la presentación? Así en la sesión vamos directos a tus dudas.\n\n` +
      `Cuéntame qué te ha parecido o qué te gustaría preguntarle.`,
    botones: ['Ya la he visto', 'Pásame la presentación', 'Cambiar de día'],
  },
  // Repesca (18-10): a quien ya dijo su perfil, con los huecos REALES de
  // Calendly de esta semana en {{huecos}}. "Sí, pásame el enlace" → Calendly.
  sesion_huecos: {
    nombreSugerido: 'sesion_huecos_three',
    variable: 'WHATSAPP_TEMPLATE_SESION_HUECOS',
    cuerpo:
      `Hola {{nombre}} 👋 Te escribo de Three Inmobiliaria.\n\n` +
      `Esta semana Arkaitz hace la sesión de dudas en grupo por Zoom (30 min, gratis y sin compromiso): {{huecos}}.\n\n` +
      `Ahí te explica cómo funciona y resuelves todas tus dudas en directo. ¿Te paso el enlace para reservar tu plaza?`,
    variables: [{ nombre: 'nombre', ejemplo: 'María' }, { nombre: 'huecos', ejemplo: 'el lunes 19 a las 17:00, el martes 20 a las 16:30 o el miércoles 21 a las 19:00' }],
    botones: ['Sí, pásame el enlace', 'No me interesa'],
  },
  sesion_hoy: {
    nombreSugerido: 'sesion_hoy_three',
    variable: 'WHATSAPP_TEMPLATE_SESION_HOY',
    cuerpo:
      `Hola {{nombre}} 👋 Te recuerdo que {{cuando}} tienes la sesión de dudas en grupo con Arkaitz por Zoom (30 min).\n\n` +
      `¿Cuento contigo? Si te ha surgido algo, pulsa "Cambiar de día" y eliges otro momento.`,
    variables: [{ nombre: 'nombre', ejemplo: 'María' }, { nombre: 'cuando', ejemplo: 'hoy a las 19:00' }],
    botones: ['Allí estaré', 'Cambiar de día'],
  },
  // Aviso INTERNO a Arkaitz por cada reserva nueva (30-10): quién, cuándo y
  // su teléfono. Categoría UTILIDAD y sin botones.
  aviso_reserva: {
    nombreSugerido: 'aviso_reserva_three',
    variable: 'WHATSAPP_TEMPLATE_AVISO_RESERVA',
    categoria: 'UTILITY',
    sinBotones: true,
    cuerpo:
      `Nueva reserva en la sesión de dudas: {{nombre}} se ha apuntado {{cuando}}. Su teléfono es {{telefono}}.\n\n` +
      `Tienes su seguimiento completo en three.dusolai.com/sesiones`,
    variables: [{ nombre: 'nombre', ejemplo: 'Txelo Campa' }, { nombre: 'cuando', ejemplo: 'el viernes 30 de octubre a las 10:00' }, { nombre: 'telefono', ejemplo: '+34 600 000 000' }],
  },
  aviso_cancelacion: {
    nombreSugerido: 'aviso_cancelacion_three',
    variable: 'WHATSAPP_TEMPLATE_AVISO_CANCELACION',
    categoria: 'UTILITY',
    sinBotones: true,
    cuerpo:
      `{{nombre}} ha cancelado su sesión de dudas de {{cuando}}. Su teléfono es {{telefono}}, por si quieres llamarle para recuperarle.\n\n` +
      `Tienes su seguimiento en three.dusolai.com/sesiones`,
    variables: [{ nombre: 'nombre', ejemplo: 'Txelo Campa' }, { nombre: 'cuando', ejemplo: 'el viernes 30 de octubre a las 10:00' }, { nombre: 'telefono', ejemplo: '+34 600 000 000' }],
  },
  // Acceso al Zoom con BOTÓN DE ENLACE: vale fuera de la ventana de 24 h. La
  // base del enlace es fija (todas las salas de Arkaitz cuelgan de ella) y
  // el sufijo (id + contraseña) va como variable del botón.
  sesion_zoom: {
    nombreSugerido: 'sesion_zoom_three',
    variable: 'WHATSAPP_TEMPLATE_SESION_ZOOM',
    cuerpo:
      `Hola {{nombre}} 👋 ¡Es la hora! Tu sesión de dudas con Arkaitz por Zoom empieza {{cuando}}.

` +
      `Pulsa el botón para entrar. Entra un par de minutos antes y ten a mano tus preguntas 🙌`,
    variables: [{ nombre: 'nombre', ejemplo: 'María' }, { nombre: 'cuando', ejemplo: 'hoy a las 17:00' }],
    botonUrl: { texto: 'Entrar al Zoom', base: 'https://us06web.zoom.us/j/', ejemplo: '86040440455?pwd=abc123' },
  },
};

function _textoSegmento(segmento, nombre) {
  const p = PLANTILLAS_META[segmento];
  if (!p || !p.cuerpo) return null;
  // Sin nombre (alta automática sin nombre de perfil): "¡Hola!" a secas.
  const n = !nombre || nombre === 'Sin nombre' ? '' : String(nombre).trim();
  return p.cuerpo.split('{{nombre}}').join(n).replace('¡Hola, !', '¡Hola!') + OPCIONES_TEXTO;
}

/**
 * Primer mensaje (pregunta de filtrado). `segmento` decide el texto:
 *   sin segmento → variantes "reabrimos plazas"
 *   viejos / verano / septiembre / directo → texto acordado para ese segmento
 */
function mensajeReactivacion({ nombre, segmento }) {
  const porSegmento = _textoSegmento(segmento, nombre);
  if (porSegmento) return porSegmento;
  const variante = VARIANTES_REACTIVACION[Math.floor(Math.random() * VARIANTES_REACTIVACION.length)];
  return variante({ nombre });
}

// Recordatorio único (texto libre: Telegram/Baileys). En WhatsApp oficial va
// la plantilla PLANTILLAS_META.recordatorio con botones.
function recordatorioCualificacion({ nombre }) {
  return (
    `Hola ${nombre}, te escribí hace un par de días desde Three Inmobiliaria y no quiero ser pesado 🙂\n\n` +
    `Si todavía te interesa, dime 1 si trabajas en el sector inmobiliario o 2 si buscas ingresos extra y te paso la información.\n\n` +
    `Si no es para ti, responde "No me interesa" y no te volveremos a escribir.`
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
// Tras cualificar, enviamos la presentación (landing con los vídeos) DIRECTAMENTE.
// En la landing ven primero el VSL, luego se desbloquea el webinar, y al
// terminarlo aparece el botón para reservar la reunión 1 a 1. El Calendly grupal
// NO se ofrece aquí: generaba fricción ("míralo ahora" + "resérvalo para otro
// momento" a la vez). El camino es uno solo: ver la presentación → reservar 1-a-1.
// Un solo vídeo por landing (22-10): la presentación larga. Minutos que se
// citan en los mensajes (la de agentes dura 33, la de emprendedores 21).
const MINUTOS_PRESENTACION = { profesional: 33, emprendedor: 21 };
function minutosPresentacion(perfil) {
  return MINUTOS_PRESENTACION[perfil] || MINUTOS_PRESENTACION.emprendedor;
}

// Reservar primero (18-10): con `enlaceSesion`, el mensaje tras cualificar
// lleva PRIMERO el enlace para elegir día y después la presentación, que se
// le recuerda ver antes de la sesión (Fase Sesión del scheduler). Sin él, el
// orden antiguo: presentación → al terminar el webinar se abre la sesión.
function _ramaReservaPrimero({ saludo, enlaceLanding, enlaceSesion, perfil }) {
  return (
    `${saludo}\n\n` +
    `El siguiente paso es la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}, por Zoom: 30 min, gratis y sin compromiso. Elige el día que te venga bien:\n` +
    `${enlaceSesion}\n\n` +
    `Y para llegar con todo claro, aquí tienes la presentación completa del proyecto (${minutosPresentacion(perfil)} min):\n` +
    `${enlaceLanding}` +
    _notaPortugues(perfil)
  );
}

function mensajeRamaProfesional({ nombre, enlaceLanding, enlaceSesion }) {
  if (enlaceSesion) return _ramaReservaPrimero({ saludo: `¡Genial ${nombre}! 🙌`, enlaceLanding, enlaceSesion, perfil: 'profesional' });
  return (
    `¡Genial ${nombre}!\n\n` +
    `Aquí tienes la presentación completa del proyecto (${minutosPresentacion('profesional')} min):\n` +
    `${enlaceLanding}\n\n` +
    `Al terminarla, apúntate a la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}, por Zoom 🎯\n\n` +
    `Lo hacemos así a propósito: a esa sesión se viene con la presentación ya vista, para aprovecharla resolviendo dudas en directo.`
  );
}

function mensajeRamaEmprendedor({ nombre, enlaceLanding, enlaceSesion }) {
  if (enlaceSesion) return _ramaReservaPrimero({ saludo: `Entendido ${nombre} 🚀`, enlaceLanding, enlaceSesion, perfil: 'emprendedor' });
  return (
    `Entendido ${nombre} 🚀\n\n` +
    `Aquí tienes la presentación completa del proyecto, va al grano (${minutosPresentacion('emprendedor')} min):\n` +
    `${enlaceLanding}\n\n` +
    `Al terminarla, apúntate a la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}, por Zoom 🎯\n\n` +
    `Lo hacemos así a propósito: a esa sesión se viene con la presentación ya vista, para aprovecharla resolviendo dudas en directo.` +
    _notaPortugues('emprendedor')
  );
}

// Nota que recuerda que la landing de EMPRENDE tiene versión en portugués
// (botón en la propia página). Solo se añade al perfil emprendedor: la landing
// de profesionales no tiene versión portuguesa. Se usa en TODOS los mensajes
// que reenvían el vídeo de emprende (inicial, recordatorios y tras reservar).
function _notaPortugues(perfil) {
  if (perfil !== 'emprendedor') return '';
  return `\n\n🇵🇹 ¿La prefieres en portugués? En la página tienes un botón para verla en portugués. (Se preferires em português, usa o botão na página.)`;
}

// Justo después de reservar en Calendly grupal: enviamos el acceso a la
// landing con el vídeo. Pueden verlo ya o esperar a su hora reservada.
function mensajeAccesoVideoTrasReserva({ nombre, enlaceLanding, perfil }) {
  return (
    `¡Listo ${nombre}! Tu hueco está reservado ✅\n\n` +
    `Aquí tienes el acceso a la presentación. Puedes verla ya mismo o a la hora que reservaste, como prefieras:\n` +
    `${enlaceLanding}\n\n` +
    `Cuando termines el vídeo, en la propia página se activa el botón para apuntarte a la sesión de dudas con Arkaitz 🎯` +
    _notaPortugues(perfil)
  );
}

// Tras ver el vídeo (CTA pulsado en la landing): enviamos el Calendly 1-a-1.
function mensajeAcceso1a1({ nombre, enlace1a1 }) {
  return (
    `¡Bien ${nombre}! 🙌\n\n` +
    `Último paso: la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}, por Zoom (30 min). Ahí resuelves todas tus dudas en directo.\n\n` +
    `Elige el día que mejor te encaje:\n` +
    `${enlace1a1}\n\n` +
    `Las plazas de cada sesión son limitadas.`
  );
}

// ─── A0. (Legacy) Mensaje de Bienvenida directo a vídeo ───────────
function mensajeBienvenida({ nombre, enlaceVideo }) {
  return (
    `Hola ${nombre} 👋\n\n` +
    `Soy del equipo de ${config.agent.empresaNombre}. Tenemos pendiente tu solicitud.\n\n` +
    `Antes de seguir, échale un vistazo a la presentación — te explica cómo funciona todo:\n` +
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
    return 'empezaste la presentación pero te quedaste a mitad — justo al final está lo importante';
  }
  if (etapa === 'vsl_hecho') {
    return 'te queda por ver la presentación — ahí está lo que de verdad importa';
  }
  if (etapa === 'vsl') {
    return 'no llegaste a terminar el primer vídeo';
  }
  return 'aún no has entrado a ver la presentación';
}

function recordatorioFunnel1({ nombre, enlaceLanding, etapa, perfil }) {
  return (
    `Oye ${nombre}, vi que ${_lineaEtapaFunnel(etapa)} 👀\n\n` +
    `Retomas justo donde lo dejaste. Te dejo el acceso otra vez:\n` +
    `${enlaceLanding}` +
    _notaPortugues(perfil)
  );
}

function recordatorioFunnel2({ nombre, enlaceLanding, etapa, perfil }) {
  return (
    `${nombre}, el acceso a la presentación lo vamos a cerrar pronto.\n\n` +
    `Vi que ${_lineaEtapaFunnel(etapa)}. ¿Puedes terminarla hoy?\n` +
    `${enlaceLanding}` +
    _notaPortugues(perfil)
  );
}

function recordatorioFunnel3({ nombre, enlaceLanding, etapa, perfil }) {
  return (
    `${nombre}, último aviso por mi parte 🔔\n\n` +
    `Vamos a cerrar el acceso en breve. Lo tienes aquí:\n` +
    `${enlaceLanding}` +
    _notaPortugues(perfil) +
    `\n\nSi no es el momento, no pasa nada, ignora este mensaje.`
  );
}

// ─── D2. Recordatorios "no reservó el 1-a-1" (reunion_registrado) ─
// El lead terminó el webinar y pulsó agendar (se le envió el enlace del
// 1-a-1) pero no ha reservado. Se le reenvía el enlace individual.
function recordatorio1a1Primero({ nombre, enlace1a1 }) {
  return (
    `Oye ${nombre}, vi que aún no te has apuntado a la sesión de dudas con Arkaitz 👀\n\n` +
    `Es el último paso. Elige día aquí:\n` +
    `${enlace1a1}`
  );
}

function recordatorio1a1Segundo({ nombre, enlace1a1 }) {
  return (
    `${nombre}, las plazas de las sesiones de Arkaitz van volando.\n\n` +
    `Si quieres resolver tus dudas con él, apúntate hoy:\n` +
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
    `Tómatelo con calma, son 25 min. Cuando termines se te abre la sesión de dudas en grupo con Arkaitz.`
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
    `Te mandaré un recordatorio justo antes para que no se te pase. Y al terminar, se te abre la sesión de dudas con Arkaitz.`
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
    `Ya tienes una idea bastante completa del proyecto. Si te ves dentro y quieres dar el paso, te toca la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}.\n\n` +
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

// ─── G. Presentación EN DIRECTO (FLUJO_TRAS_CUALIFICAR=presentacion) ─
// Reunión 01-10: en vez de la landing con vídeos, el lead cualificado recibe
// la invitación a la presentación en directo (formato 30 + preguntas), una al
// día alternando mañana/tarde. Tras asistir se le manda el 1-a-1 (mensajeCierre).
function mensajeInvitacionPresentacion({ nombre, enlaceGrupal }) {
  return (
    `¡Genial ${nombre}!\n\n` +
    `El siguiente paso es la presentación del proyecto EN DIRECTO por Zoom: unos 30 minutos y al final puedes preguntar lo que quieras. Hacemos una al día.\n\n` +
    `Reserva el hueco que mejor te encaje aquí:\n` +
    `${enlaceGrupal}\n\n` +
    `Al terminar la presentación se te abre la sesión de dudas en grupo con ${config.agent.directorNombre}, ${config.agent.directorRol}.`
  );
}

// Respuesta a los botones "Pásame el enlace" / "Sí, pásame el enlace" de los
// recordatorios: el enlace de la sesión de dudas, directo, sin más pasos.
function mensajeEnlaceSesion({ nombre, enlaceSesion }) {
  return (
    `¡Perfecto ${nombre}! 🙌

` +
    `Aquí eliges día para la sesión de dudas en grupo con ${config.agent.directorNombre} por Zoom (30 min, preguntas en directo):
` +
    `${enlaceSesion}

` +
    `Si te viene mejor otro momento, dímelo por aquí.`
  );
}

// ─── H. Sesión de dudas RESERVADA (18-10) ───────────────────────────
// Reservar primero, prepararse después: tras la reserva se le pide ver la
// presentación (y su opinión), el mismo día se confirma asistencia y 1 h
// antes se le manda el Zoom. `cuando` = "el jueves 23 de octubre a las 19:00".
function mensajeSesionReservada({ nombre, cuando, enlaceLanding, perfil }) {
  return (
    `¡Reservado, ${nombre}! ✅ Tu sesión de dudas con ${config.agent.directorNombre} es ${cuando} (hora de España), por Zoom.\n\n` +
    `Para que la sesión te sirva de verdad, antes hay que ver la presentación (${minutosPresentacion(perfil)} min):\n${enlaceLanding}\n\n` +
    `En cuanto la termines se desbloquea tu acceso al Zoom. Cuéntame qué te ha parecido y lo tendrá ${config.agent.directorNombre} delante 🙌`
  );
}

// La presentación es la LLAVE del Zoom (21-10): sin verla no se entra. Este
// es el aviso de una hora antes para quien aún no la ha visto.
function mensajeSesionLlave({ nombre, hora, enlaceLanding, perfil }) {
  return (
    `${nombre}, tu sesión con ${config.agent.directorNombre} es a las ${hora} y aún no me consta que hayas visto la presentación 👀\n\n` +
    `Es la llave para entrar: son ${minutosPresentacion(perfil)} minutos y así en la sesión vas directo a tus dudas.\n${enlaceLanding}\n\n` +
    `En cuanto la termines, o me cuentes en una frase qué te ha parecido, te llega el enlace del Zoom al momento.`
  );
}

// Derivación directa (21-10): a quien se pierde se le da el WhatsApp de
// Arkaitz con el mensaje ya escrito. Nada de "te escribirá": escribe él.
function mensajeDerivacionArkaitz({ nombre, enlace }) {
  return (
    `${nombre}, para no marearte más: habla directamente con ${config.agent.directorNombre}, ${config.agent.directorRol}. ` +
    `Él te atiende en persona y te resuelve cualquier duda.\n\n` +
    `Pulsa aquí y le llega tu mensaje ya escrito 👇\n${enlace}`
  );
}

function mensajeSesionPreparacion({ nombre, enlaceLanding }) {
  return (
    `${nombre}, ¿has podido ver la presentación? 👀 Así en la sesión con ${config.agent.directorNombre} vais directos a tus dudas.\n\n` +
    `${enlaceLanding}\n\n` +
    `Cuando la termines, cuéntame en una frase qué te ha parecido o qué quieres preguntarle: se lo dejo apuntado y queda desbloqueado tu acceso al Zoom.`
  );
}

function mensajeSesionHoy({ nombre, cuando }) {
  return (
    `¡Hola ${nombre}! Te recuerdo que ${cuando} tienes la sesión de dudas con ${config.agent.directorNombre} por Zoom (30 min).\n\n` +
    `¿Cuento contigo? El enlace del Zoom te llega una hora antes (si ya has visto la presentación). Si te ha surgido algo, dime y te paso otro día.`
  );
}

function mensajeSesionUnaHora({ nombre, hora, joinUrl }) {
  return (
    `${nombre}, ¡en una hora empezamos! (${hora}) 🎯\n\n` +
    (joinUrl ? `Este es el enlace del Zoom:\n${joinUrl}\n\n` : `El enlace del Zoom lo tienes en el email de confirmación de Calendly.\n\n`) +
    `Entra un par de minutos antes. ¡Nos vemos!`
  );
}

// Política de 3 oportunidades (reunión 30-10): al reservar por tercera vez
// tras faltar dos, un mensaje cordial pero claro. Lo manda el agente, no Arkaitz.
function mensajeTerceraOportunidad({ nombre, cuando }) {
  return (
    `${nombre}, te confirmo tu sesión ${cuando} ✅\n\n` +
    `Te escribo con cariño pero claro: es la tercera vez que la reservamos. Entendemos que a todos nos surgen cosas, pero detrás hay un equipo que te reserva su tiempo. ` +
    `Si esta vez tampoco puedes, avísanos antes; si no, no podremos volver a darte plaza. ¡Te esperamos! 🙌`
  );
}

function mensajeSesionConfirmada({ nombre }) {
  return `¡Perfecto ${nombre}! 🙌 Te escribo una hora antes con el enlace del Zoom.`;
}

function mensajeSesionCambiarDia({ nombre, enlace }) {
  return `Sin problema ${nombre} 🙂 Elige aquí el día que mejor te venga:\n${enlace}`;
}

function mensajeSesionCancelada({ nombre, enlace }) {
  return `${nombre}, he visto que se ha cancelado tu sesión. Cuando quieras, eliges otro día aquí:\n${enlace}`;
}

function mensajeSesionNoAsistio({ nombre, enlace }) {
  return (
    `${nombre}, hoy no te vimos en la sesión 😕 ¿Te surgió algo?\n\n` +
    `Hay sesiones varios días a la semana, elige la que mejor te venga:\n${enlace}`
  );
}

function mensajeSesionPideFeedback({ nombre }) {
  return `¡Genial ${nombre}! 🙌 ¿Qué te ha parecido? Si hay algo que quieras que ${config.agent.directorNombre} te aclare en la sesión, cuéntamelo y se lo dejo apuntado.`;
}

function mensajeSesionFeedbackApuntado({ nombre }) {
  return `¡Apuntado, ${nombre}! ${config.agent.directorNombre} lo tendrá delante en la sesión ✍️`;
}

function mensajeReservaPresentacionConfirmada({ nombre }) {
  return (
    `¡Listo ${nombre}! Tu plaza en la presentación está reservada ✅\n\n` +
    `El enlace de Zoom te llega por email con la confirmación. Te mando un recordatorio antes.\n\n` +
    `Nos vemos allí 🙌`
  );
}

module.exports = {
  PLANTILLAS_META,
  OPCIONES_TEXTO,
  mensajeReactivacion,
  mensajeReintentarCualificacion,
  recordatorioCualificacion,
  mensajeInvitacionPresentacion,
  mensajeReservaPresentacionConfirmada,
  mensajeEnlaceSesion,
  mensajeSesionReservada,
  mensajeSesionPreparacion,
  mensajeSesionHoy,
  mensajeSesionUnaHora,
  mensajeSesionConfirmada,
  mensajeSesionCambiarDia,
  mensajeSesionCancelada,
  mensajeSesionNoAsistio,
  mensajeSesionPideFeedback,
  mensajeSesionFeedbackApuntado,
  mensajeSesionLlave,
  mensajeTerceraOportunidad,
  minutosPresentacion,
  mensajeDerivacionArkaitz,
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
