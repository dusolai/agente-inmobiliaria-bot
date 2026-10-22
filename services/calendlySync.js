const axios = require('axios');
const config = require('../config/config');
const leadManager = require('./leadManager');
const activityLog = require('./activityLog');
const messaging = require('./messaging');
const messages = require('../templates/messages');

/**
 * Reservas de la "Sesión de dudas" leídas de la API de Calendly (18-10).
 *
 * Hasta ahora el sistema no sabía quién reservaba: el webhook de Calendly
 * nunca se suscribió y el redirect tras reservar no está configurado. Con el
 * token personal (CALENDLY_TOKEN) se consultan cada ciclo del scheduler los
 * eventos de los próximos días y sus invitados, y se guarda en el lead:
 *
 *   lead.sesion = { inviteeUri, eventoUri, inicio, fin, joinUrl, rescheduleUrl,
 *                   estado: 'reservada'|'cancelada', reservadaAt, confirmada,
 *                   avisos: { preparacion, ultimaPreparacion, hoy, unaHora, noAsistio } }
 *
 * Cómo se reconoce al lead: utm_content=lead_<id> (viene en todos nuestros
 * enlaces), si no por email y si no por el teléfono de las preguntas de Calendly.
 */

const API = 'https://api.calendly.com';
let _usuarioUri = null;
let _ultimoError = null;
let _ultimaSync = null;

function activo() {
  return Boolean(config.calendly.token);
}

function _get(url, params) {
  return axios.get(url.startsWith('http') ? url : `${API}${url}`, {
    params,
    headers: { Authorization: `Bearer ${config.calendly.token}`, 'User-Agent': 'Mozilla/5.0 (three-inmo-crm)' },
    timeout: 15000,
  });
}

async function _usuario() {
  if (_usuarioUri) return _usuarioUri;
  const { data } = await _get('/users/me');
  _usuarioUri = data.resource.uri;
  return _usuarioUri;
}

async function _paginar(url, params) {
  const out = [];
  let siguiente = url;
  let p = params;
  for (let i = 0; i < 10 && siguiente; i++) {
    const { data } = await _get(siguiente, p);
    out.push(...(data.collection || []));
    siguiente = data.pagination && data.pagination.next_page;
    p = undefined; // next_page ya trae los parámetros
  }
  return out;
}

function _soloDigitos(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

function _leadDeInvitado(inv, leads) {
  const utm = inv.tracking && inv.tracking.utm_content;
  const m = utm && String(utm).match(/^lead_(.+)$/);
  if (m) {
    const l = leadManager.getLeadById(m[1]);
    if (l) return l;
  }
  const email = String(inv.email || '').trim().toLowerCase();
  if (email) {
    const l = leads.find((x) => x.email && String(x.email).trim().toLowerCase() === email);
    if (l) return l;
  }
  const tel = [inv.text_reminder_number, ...((inv.questions_and_answers || []).map((q) => q.answer))]
    .map(_soloDigitos).find((d) => d.length >= 9);
  if (tel) {
    const fin = tel.slice(-9);
    const l = leads.find((x) => _soloDigitos(x.telefono).endsWith(fin));
    if (l) return l;
  }
  return null;
}

/** "el jueves 23 de octubre a las 19:00" (hora de España). */
function describirCuando(iso, { relativo = false } = {}) {
  const d = new Date(iso);
  const tz = 'Europe/Madrid';
  const hora = d.toLocaleTimeString('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  if (relativo) {
    const dia = (x) => x.toLocaleDateString('es-ES', { timeZone: tz });
    const hoy = new Date(Date.now());
    const manana = new Date(Date.now() + 24 * 3600 * 1000);
    if (dia(d) === dia(hoy)) return `hoy a las ${hora}`;
    if (dia(d) === dia(manana)) return `mañana a las ${hora}`;
  }
  const fecha = d.toLocaleDateString('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  return `el ${fecha} a las ${hora}`;
}

function horaDe(iso) {
  return new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

function _enlaceLanding(lead) {
  const base = lead.perfil === 'profesional' ? config.landing.landingProfesionalUrl : config.landing.landingEmprendedorUrl;
  return `${base}?lead=${lead.id}`;
}

function _enlaceReservar(lead) {
  return `${config.backendPublicUrl.replace(/\/$/, '')}/r/grupal?l=${encodeURIComponent(lead.id)}`;
}

/** Fija el estado "reservó la sesión" (reunion_registrado) sin pasar por la
 *  máquina de transiciones, que no permite saltar desde video_enviado. */
function _marcarReservado(lead) {
  const S = leadManager.LEAD_STATES;
  if ([S.REUNION_REGISTRADO, S.REUNION_ASISTIO, S.AGENDA_1A1].includes(lead.estado)) return;
  const now = new Date(Date.now()).toISOString();
  leadManager.updateLead(lead.id, {
    estado: S.REUNION_REGISTRADO,
    reunionRegistradoAt: now,
    historial: [...(lead.historial || []), { estado: S.REUNION_REGISTRADO, fecha: now, motivo: 'reserva_calendly' }],
  });
  activityLog.appendActivity(lead.id, 'state_changed', { from: lead.estado, to: S.REUNION_REGISTRADO, motivo: 'reserva_calendly' });
}

/**
 * Registra una reserva (invitado activo de Calendly). Idempotente: si ya
 * estaba registrada (mismo invitado) solo actualiza hora/enlace.
 * Devuelve true si es una reserva NUEVA.
 */
async function registrarReserva(lead, { inviteeUri, eventoUri, inicio, fin, joinUrl, rescheduleUrl, via = 'api' }) {
  const prev = lead.sesion || null;
  if (prev && prev.inviteeUri === inviteeUri && prev.estado === 'reservada') {
    if (prev.inicio !== inicio || prev.joinUrl !== joinUrl) {
      leadManager.updateLead(lead.id, { sesion: { ...prev, inicio, fin, joinUrl, rescheduleUrl } });
    }
    return false;
  }
  const sesion = {
    inviteeUri, eventoUri, inicio, fin, joinUrl: joinUrl || null, rescheduleUrl: rescheduleUrl || null,
    estado: 'reservada', reservadaAt: new Date(Date.now()).toISOString(), confirmada: false,
    avisos: { preparacion: 0, ultimaPreparacion: null, hoy: null, unaHora: null, noAsistio: null },
  };
  leadManager.updateLead(lead.id, { sesion });
  _marcarReservado(lead);
  activityLog.appendActivity(lead.id, 'sesion_reservada', { inicio, via, reprogramada: Boolean(prev && prev.inviteeUri !== inviteeUri) });
  console.log(`📅 [Calendly] ${lead.nombre} reservó la sesión: ${describirCuando(inicio)}`);
  // Confirmación por WhatsApp solo con la ventana abierta (Calendly ya manda
  // su email de confirmación; fuera de ventana no se gasta plantilla).
  if (messaging.dentroDeVentana(lead.telefono)) {
    await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionReservada({
      nombre: lead.nombre, cuando: describirCuando(inicio), enlaceLanding: _enlaceLanding(lead), perfil: lead.perfil,
    }));
  }
  return true;
}

async function registrarCancelacion(lead, inviteeUri) {
  const s = lead.sesion;
  if (!s || s.inviteeUri !== inviteeUri || s.estado !== 'reservada') return false;
  leadManager.updateLead(lead.id, { sesion: { ...s, estado: 'cancelada', canceladaAt: new Date(Date.now()).toISOString() } });
  const S = leadManager.LEAD_STATES;
  if (lead.estado === S.REUNION_REGISTRADO) {
    leadManager.updateLead(lead.id, { estado: S.VIDEO_VISTO });
    activityLog.appendActivity(lead.id, 'state_changed', { from: S.REUNION_REGISTRADO, to: S.VIDEO_VISTO, motivo: 'cancelo_calendly' });
  }
  activityLog.appendActivity(lead.id, 'sesion_cancelada', { inicio: s.inicio });
  console.log(`📅 [Calendly] ${lead.nombre} canceló la sesión del ${describirCuando(s.inicio)}`);
  if (messaging.dentroDeVentana(lead.telefono)) {
    await messaging.sendTextMessage(lead.telefono, messages.mensajeSesionCancelada({ nombre: lead.nombre, enlace: _enlaceReservar(lead) }));
  }
  return true;
}

/**
 * Lee de Calendly las sesiones de las últimas 24 h y los próximos 30 días y
 * actualiza los leads. Se llama en cada ciclo del scheduler.
 */
async function sincronizar() {
  if (!activo()) return { ok: false, motivo: 'sin CALENDLY_TOKEN' };
  try {
    const user = await _usuario();
    const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const hasta = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const eventos = await _paginar('/scheduled_events', {
      user, min_start_time: desde, max_start_time: hasta, count: 100, sort: 'start_time:asc',
    });
    const leads = leadManager.getAllLeads({});
    const activos = [];
    const cancelados = [];
    for (const ev of eventos) {
      const invitados = await _paginar(`${ev.uri}/invitees`, { count: 100 });
      for (const inv of invitados) {
        const item = { ev, inv };
        if (inv.status === 'active' && ev.status === 'active') activos.push(item);
        else cancelados.push(item);
      }
    }
    let nuevas = 0;
    let canceladas = 0;
    // Primero las activas: una reprogramación en Calendly cancela el invitado
    // viejo y crea uno nuevo; así el nuevo manda y la cancelación del viejo
    // ya no coincide con lead.sesion.inviteeUri.
    for (const { ev, inv } of activos) {
      const lead = _leadDeInvitado(inv, leads);
      if (!lead) continue;
      const ok = await registrarReserva(leadManager.getLeadById(lead.id), {
        inviteeUri: inv.uri, eventoUri: ev.uri, inicio: ev.start_time, fin: ev.end_time,
        joinUrl: ev.location && (ev.location.join_url || ev.location.location) || null,
        rescheduleUrl: inv.reschedule_url || null,
      });
      if (ok) nuevas++;
    }
    for (const { inv } of cancelados) {
      const lead = _leadDeInvitado(inv, leads);
      if (!lead) continue;
      if (await registrarCancelacion(leadManager.getLeadById(lead.id), inv.uri)) canceladas++;
    }
    _ultimaSync = { ts: new Date(Date.now()).toISOString(), eventos: eventos.length, nuevas, canceladas };
    _ultimoError = null;
    if (nuevas || canceladas) console.log(`📅 [Calendly] Sync: ${nuevas} reservas nuevas, ${canceladas} canceladas`);
    return { ok: true, ..._ultimaSync };
  } catch (err) {
    const d = err.response && err.response.data;
    _ultimoError = (d && (d.message || d.title)) || err.message;
    console.error('❌ [Calendly] Error sincronizando:', _ultimoError);
    return { ok: false, error: _ultimoError };
  }
}

/**
 * Huecos libres de la sesión en los próximos días, leídos de la página
 * PÚBLICA de reservas (no necesita token): "el lunes 19 a las 17:00, el
 * martes 20 a las 16:30 o el miércoles 21 a las 19:00". Caché 30 min.
 */
let _huecosCache = null;
async function huecosTexto({ dias = 7, max = 3 } = {}) {
  if (_huecosCache && Date.now() - _huecosCache.ts < 30 * 60 * 1000) return _huecosCache.texto;
  try {
    const m = String(config.landing.calendlyGrupalUrl || '').match(/calendly\.com\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    const ua = { 'User-Agent': 'Mozilla/5.0' };
    const { data: tipo } = await axios.get('https://calendly.com/api/booking/event_types/lookup', {
      params: { profile_slug: m[1], event_type_slug: m[2] }, headers: ua, timeout: 15000,
    });
    const hoy = new Date(Date.now());
    const fin = new Date(Date.now() + dias * 24 * 3600 * 1000);
    const f = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const { data } = await axios.get(`https://calendly.com/api/booking/event_types/${tipo.uuid}/calendar/range`, {
      params: { timezone: 'Europe/Madrid', diagnostics: false, range_start: f(hoy), range_end: f(fin) }, headers: ua, timeout: 15000,
    });
    // Un hueco por día (el primero), y que falten al menos 3 h
    const huecos = [];
    for (const dia of data.days || []) {
      const spot = (dia.spots || []).find((s) => new Date(s.start_time).getTime() - Date.now() > 3 * 3600 * 1000);
      if (spot) huecos.push(spot.start_time);
      if (huecos.length >= max) break;
    }
    if (!huecos.length) return null;
    const partes = huecos.map((iso) => {
      const d = new Date(iso);
      const dia = d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric' });
      return `el ${dia} a las ${horaDe(iso)}`;
    });
    const texto = partes.length > 1 ? `${partes.slice(0, -1).join(', ')} o ${partes[partes.length - 1]}` : partes[0];
    _huecosCache = { ts: Date.now(), texto };
    return texto;
  } catch (err) {
    console.error('❌ [Calendly] No se pudieron leer los huecos:', err.message);
    return null;
  }
}

function estado() {
  return { activo: activo(), ultimaSync: _ultimaSync, error: _ultimoError };
}

module.exports = { huecosTexto, sincronizar, registrarReserva, registrarCancelacion, describirCuando, horaDe, estado, activo, _leadDeInvitado };
