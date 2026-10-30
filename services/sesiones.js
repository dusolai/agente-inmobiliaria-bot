/**
 * Panel "Sesiones de dudas" del CRM (23-10): lo que ve Arkaitz de las
 * reservas del Zoom. Cálculo PURO sobre los leads (sin tocar disco ni red)
 * para poder probarlo con leads falsos: agrupa por hora de inicio (misma
 * hora = misma sesión), ordena y resume quién viene y cómo llega.
 *
 * Fuente: lead.sesion tal y como lo guarda calendlySync (inicio, fin,
 * joinUrl, estado reservada|cancelada|celebrada, confirmada, formado,
 * avisos…) más lo que marca el CRM (asistio / asistioAt / noAsistioMarcadoAt).
 */

const calendlySync = require('./calendlySync');

const DIA = 24 * 3600 * 1000;
// Ventana del panel: sesiones de los últimos 14 días (para marcar asistencia)
// y de los próximos 45 (lo que hay reservado).
// 45 días atrás: los «no presentados» se siguen llamando semanas después (reunión 30-10)
const DIAS_ATRAS = 45;
const DIAS_ADELANTE = 45;

/** true / false si consta; null si nadie lo ha marcado todavía. */
function _asistio(lead) {
  const s = lead.sesion || {};
  if (s.asistio === true) return true;
  if (s.asistio === false) return false;
  if (lead.estado === 'reunion_asistio') return true;
  return null;
}

function _asistente(lead) {
  const s = lead.sesion;
  const av = s.avisos || {};
  return {
    leadId: lead.id,
    nombre: lead.nombre || 'Sin nombre',
    telefono: lead.telefono || '',
    perfil: lead.perfil || null,
    estadoSesion: s.estado || 'reservada',
    reservadaAt: s.reservadaAt || null,
    confirmada: Boolean(s.confirmada),
    formado: Boolean(s.formado || s.presentacionConfirmada),
    zoomEnviado: av.zoomEnviado || null,
    asistio: _asistio(lead),
    derivado: Boolean(lead.derivadoArkaitzAt || lead.pideHumanoAt),
    // Lo que escribió para Arkaitz ("¿qué te ha parecido?"): se lee antes de la sesión
    dudas: (lead.feedbackSesion || []).map((f) => f && f.texto).filter(Boolean),
    avisos: { preparacion: av.preparacion || 0, hoy: av.hoy || null, unaHora: av.unaHora || null, noAsistio: av.noAsistio || null },
    // Seguimiento manual del equipo (reunión 30-10): llamadas y descarte a mano
    llamadas: (lead.seguimientoSesion && lead.seguimientoSesion.llamadas) || [],
    descartadoManual: (lead.seguimientoSesion && lead.seguimientoSesion.descartado) || null,
    oportunidad: (lead.historialSesiones || []).length + 1,
    noPresentadoVeces: (lead.historialSesiones || []).filter((h) => h.asistio !== true && h.estado !== 'cancelada').length,
  };
}

/**
 * Pestaña del panel (reunión 30-10, a petición de Arkaitz):
 *   agendados     → cita por venir
 *   nopresentados → la cita pasó (o la canceló) y no vino: hay que llamarle
 *   descartados   → el equipo habló con él y lo descartó A MANO
 *   vinieron      → asistió
 * Nada pasa a «descartados» solo: lo decide una persona.
 */
function pestanaDe(a, pasada) {
  if (a.descartadoManual) return 'descartados';
  if (a.asistio === true) return 'vinieron';
  if (!pasada && a.estadoSesion === 'reservada') return 'agendados';
  return 'nopresentados';
}

/**
 * listar(leads, ahora) → { ahora, sesiones: [...], resumen: {...} }
 *   sesiones: ascendente por inicio; dentro, asistentes por nombre.
 *   pasada: la sesión ya terminó (fin de Calendly o inicio + 30 min).
 */
function listar(leads, ahora = Date.now()) {
  const desde = ahora - DIAS_ATRAS * DIA;
  const hasta = ahora + DIAS_ADELANTE * DIA;
  const porInicio = new Map();

  for (const lead of leads || []) {
    const s = lead && lead.sesion;
    if (!s || !s.inicio) continue;
    const t = new Date(s.inicio).getTime();
    if (isNaN(t) || t < desde || t > hasta) continue;
    const clave = new Date(t).toISOString();
    if (!porInicio.has(clave)) {
      const fin = s.fin && !isNaN(new Date(s.fin).getTime()) ? new Date(s.fin).toISOString() : null;
      porInicio.set(clave, {
        inicio: clave,
        fin,
        joinUrl: null,
        cuando: calendlySync.describirCuando(clave),
        pasada: ahora > (fin ? new Date(fin).getTime() : t + 30 * 60 * 1000),
        asistentes: [],
      });
    }
    const ses = porInicio.get(clave);
    // El enlace del Zoom es el mismo para todos; vale el primero que lo tenga
    if (!ses.joinUrl && s.joinUrl) ses.joinUrl = s.joinUrl;
    if (!ses.fin && s.fin) ses.fin = s.fin;
    const asis = _asistente(lead);
    asis.pestana = pestanaDe(asis, ses.pasada);
    ses.asistentes.push(asis);
  }

  const sesiones = [...porInicio.values()].sort((a, b) => a.inicio.localeCompare(b.inicio));
  for (const s of sesiones) s.asistentes.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  const resumen = { proximas: 0, reservados: 0, confirmados: 0, formados: 0, asistieronUltimos14d: 0, noAsistieronUltimos14d: 0 };
  for (const s of sesiones) {
    const vivos = s.asistentes.filter((a) => a.estadoSesion !== 'cancelada');
    if (s.pasada) {
      resumen.asistieronUltimos14d += vivos.filter((a) => a.asistio === true).length;
      resumen.noAsistieronUltimos14d += vivos.filter((a) => a.asistio === false).length;
      continue;
    }
    if (!vivos.length) continue; // todos cancelaron: no cuenta como próxima
    resumen.proximas++;
    const reservados = vivos.filter((a) => a.estadoSesion === 'reservada');
    resumen.reservados += reservados.length;
    resumen.confirmados += reservados.filter((a) => a.confirmada).length;
    resumen.formados += reservados.filter((a) => a.formado).length;
  }

  const todos = sesiones.flatMap((s) => s.asistentes);
  resumen.pestanas = {
    agendados: todos.filter((a) => a.pestana === 'agendados').length,
    nopresentados: todos.filter((a) => a.pestana === 'nopresentados').length,
    descartados: todos.filter((a) => a.pestana === 'descartados').length,
    vinieron: todos.filter((a) => a.pestana === 'vinieron').length,
    porLlamar: todos.filter((a) => a.pestana === 'agendados' && !a.llamadas.length).length,
  };
  return { ahora: new Date(ahora).toISOString(), sesiones, resumen };
}

// ─── Seguimiento exhaustivo y riesgo de no venir (27-10) ─────────────
// Pura: recibe el lead y SUS eventos. Reconstruye cada paso (con fecha y si
// llegó / lo leyó) y la conversación completa desde que reservó.

const ETIQUETA_SALIDA = {
  '[plantilla sesion_preparacion_three]': 'Preparación: «¿has visto la presentación?»',
  '[plantilla sesion_hoy_three]': 'Aviso «¿cuento contigo?»',
  '[plantilla sesion_zoom_three]': 'Enlace del Zoom (botón)',
  '[plantilla sesion_huecos_three]': 'Repesca con los huecos de la semana',
  '[plantilla recordatorio_sesion_three]': 'Recordatorio: apúntate a la sesión',
  '[plantilla recordatorio_presentacion_three]': 'Recordatorio: termina la presentación',
};

// Estado de entrega de cada mensaje enviado: el mejor estado que llega
// después de él y antes del siguiente envío.
function _conEntrega(evs) {
  const out = [];
  let ultimo = null;
  for (const e of evs) {
    const m = e.meta || {};
    if (e.type === 'message_sent') {
      ultimo = { ts: e.ts, de: m.manual ? 'crm' : 'sistema', texto: ETIQUETA_SALIDA[m.preview] || m.preview || '', entrega: m.ok === false ? 'fallido' : 'enviado' };
      out.push(ultimo);
    } else if (e.type === 'message_status' && ultimo) {
      const rango = { enviado: 0, entregado: 1, leido: 2, fallido: 3 };
      const nuevo = m.status === 'read' ? 'leido' : m.status === 'delivered' ? 'entregado' : m.status === 'failed' ? 'fallido' : null;
      if (nuevo && rango[nuevo] > rango[ultimo.entrega]) ultimo.entrega = nuevo;
    } else if (e.type === 'message_received') {
      out.push({ ts: e.ts, de: 'lead', texto: m.texto || '', entrega: null });
      ultimo = null;
    }
  }
  return out;
}

function seguimiento(lead, eventos, ahora = Date.now()) {
  const s = lead.sesion || {};
  // 60 días antes de reservar: quien vio la presentación antes (María) cuenta
  const desde = s.reservadaAt ? new Date(s.reservadaAt).getTime() - 60 * DIA : 0;
  const evs = (eventos || []).filter((e) => new Date(e.ts).getTime() >= desde).sort((a, b) => a.ts.localeCompare(b.ts));
  const primero = (pred) => evs.find(pred) || null;
  const desdeReserva = (e) => !s.reservadaAt || e.ts >= s.reservadaAt;
  const conversacion = _conEntrega(evs);
  const msgTras = (ts) => conversacion.filter((c) => c.de !== 'lead' && c.ts >= ts);
  const inicio = new Date(s.inicio).getTime();

  const vio = primero((e) => /^(video_complete|calendly_button_revealed)$/.test(e.type) || e.type === 'video_progress_90');
  const empezo = primero((e) => e.type === 'video_play');
  const progreso = evs.filter((e) => /^video_progress_\d+$/.test(e.type)).map((e) => Number(e.type.split('_').pop())).reduce((m, n) => Math.max(m, n), 0);
  const cambio = [...evs].reverse().find((e) => e.type === 'sesion_cambiar_dia' && desdeReserva(e)) || null;
  const zoom = primero((e) => e.type === 'sesion_zoom_enviado');
  const conf = primero((e) => e.type === 'sesion_confirmada');
  const prep = msgTras(s.reservadaAt || '').filter((c) => /Preparación|has podido ver la presentación/.test(c.texto));
  const hoy = msgTras(s.reservadaAt || '').filter((c) => /cuento contigo/i.test(c.texto));

  const paso = (clave, titulo, hecho, ts, detalle, fallo) => ({ clave, titulo, estado: hecho ? 'hecho' : fallo ? 'fallo' : 'pendiente', ts: ts || null, detalle: detalle || '' });
  const entregaTxt = (arr) => (arr.length ? `${arr.length} enviado(s) · último ${arr[arr.length - 1].entrega}` : '');
  const pasos = [
    paso('reserva', 'Reservó en Calendly', Boolean(s.reservadaAt), s.reservadaAt),
    paso('preparacion', 'Le pedimos ver la presentación', prep.length > 0, prep[0] && prep[0].ts, entregaTxt(prep)),
    paso('presentacion', 'Vio la presentación', Boolean(s.formado || vio), (vio && vio.ts) || s.formadoAt,
      vio ? 'terminó el vídeo en la web' : s.formado ? 'lo dijo por WhatsApp' : empezo ? `empezó el vídeo (llegó al ${progreso}%)` : 'no ha abierto el vídeo'),
    paso('aviso', 'Aviso del día «¿cuento contigo?»', hoy.length > 0, hoy[0] && hoy[0].ts, entregaTxt(hoy)),
    paso('confirma', 'Confirmó que viene', Boolean(s.confirmada), (conf && conf.ts) || s.confirmadaAt, cambio ? `ojo: pidió cambiar de día (${cambio.ts.slice(0, 10)})` : ''),
    paso('zoom', 'Recibió el enlace del Zoom', Boolean(zoom || (s.avisos && s.avisos.zoomEnviado)), (zoom && zoom.ts) || (s.avisos && s.avisos.zoomEnviado)),
    paso('asistencia', 'Entró a la sesión', s.asistio === true || lead.estado === 'reunion_asistio', s.asistioAt, s.asistio === false ? 'no se presentó' : '', s.asistio === false),
  ];

  // Riesgo de que no venga (solo sesiones futuras)
  const motivos = [];
  if (s.estado === 'reservada' && inicio > ahora) {
    if (cambio) motivos.push('pidió cambiar de día y no ha cambiado la reserva');
    const enviadosTras = msgTras(s.reservadaAt || '');
    // Si contestó, lo leyó (hay quien tiene desactivado el doble check azul)
    const contesto = conversacion.some((c) => c.de === 'lead' && c.ts >= (s.reservadaAt || ''));
    if (enviadosTras.length && !contesto && !enviadosTras.some((c) => c.entrega === 'leido')) motivos.push('no ha leído ningún mensaje desde que reservó');
    if (!s.formado && !vio) motivos.push(empezo ? `no terminó la presentación (${progreso}%)` : 'no ha visto la presentación');
    if (!s.confirmada && inicio - ahora < 14 * 3600 * 1000) motivos.push('no ha confirmado');
    if (!conversacion.some((c) => c.de === 'lead' && c.ts >= (s.reservadaAt || ''))) motivos.push('no ha escrito nada desde que reservó');
  }
  const graves = motivos.filter((m) => /cambiar de día|no ha leído/.test(m)).length;
  const riesgo = !motivos.length ? 'bajo' : graves || motivos.length >= 3 ? 'alto' : 'medio';

  return { pasos, conversacion, riesgo, motivos, pidioCambio: Boolean(cambio) };
}

module.exports = { listar, seguimiento, pestanaDe, DIAS_ATRAS, DIAS_ADELANTE };
