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
const DIAS_ATRAS = 14;
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
  };
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
    ses.asistentes.push(_asistente(lead));
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

  return { ahora: new Date(ahora).toISOString(), sesiones, resumen };
}

module.exports = { listar, DIAS_ATRAS, DIAS_ADELANTE };
