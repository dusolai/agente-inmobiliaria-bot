const axios = require('axios');
const config = require('../config/config');

/**
 * Servicio de Zoom API.
 * Verifica asistencia a reuniones grupales.
 */

let accessToken = null;
let tokenExpiry = 0;

const isConfigured = () =>
  config.zoom.accountId && config.zoom.clientId && config.zoom.clientSecret &&
  config.zoom.accountId !== 'tu_zoom_account_id';

/**
 * Obtiene un token de acceso OAuth de Zoom (Server-to-Server).
 */
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  if (!isConfigured()) {
    console.log('⚠️  [Zoom] Credenciales no configuradas — modo offline');
    return null;
  }

  try {
    const credentials = Buffer.from(
      `${config.zoom.clientId}:${config.zoom.clientSecret}`
    ).toString('base64');

    const res = await axios.post(
      'https://zoom.us/oauth/token',
      `grant_type=account_credentials&account_id=${config.zoom.accountId}`,
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return accessToken;
  } catch (err) {
    console.error('❌ [Zoom] Error obteniendo token:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Obtiene los participantes de una reunión pasada.
 * @param {string} meetingId – ID de la reunión de Zoom
 * @returns {Array} Lista de participantes con email y nombre
 */
async function getMeetingParticipants(meetingId) {
  const token = await getAccessToken();
  if (!token) {
    console.log(`📹 [Zoom DEV] getMeetingParticipants(${meetingId}) — modo offline`);
    return [];
  }

  try {
    const res = await axios.get(
      `https://api.zoom.us/v2/past_meetings/${meetingId}/participants`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 300 },
      }
    );

    return (res.data.participants || []).map((p) => ({
      nombre: p.name,
      email: p.user_email,
      duracion: p.duration,
      joinTime: p.join_time,
      leaveTime: p.leave_time,
    }));
  } catch (err) {
    console.error('❌ [Zoom] Error obteniendo participantes:', err.response?.data || err.message);
    return [];
  }
}

/**
 * Verifica si un email específico estuvo en la reunión.
 */
async function checkAttendance(meetingId, email) {
  const participants = await getMeetingParticipants(meetingId);
  const found = participants.find(
    (p) => p.email && p.email.toLowerCase() === email.toLowerCase()
  );
  return { attended: !!found, participant: found || null };
}

// ─── Asistencia automática a la sesión de dudas (28-10) ─────────────
// El id de la reunión sale del enlace de Calendly (us06web.zoom.us/j/<id>).
function meetingIdDe(joinUrl) {
  const m = String(joinUrl || '').match(/zoom\.us\/j\/(\d+)/);
  return m ? m[1] : null;
}

const _norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();

/**
 * ¿Entró este lead a la sala? Por email (si Zoom lo da) o por nombre: el
 * nombre que pone en Zoom contiene su nombre de pila y, si lo hay, algún
 * apellido. Devuelve { ok, asistio, minutos, participante } u { ok:false, error }.
 */
async function asistenciaDe(joinUrl, { email, nombres = [] }) {
  const id = meetingIdDe(joinUrl);
  if (!id) return { ok: false, error: 'sin id de reunión en el enlace' };
  if (!isConfigured()) return { ok: false, error: 'Zoom sin credenciales' };
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'Zoom no da token' };
  let lista;
  try {
    const res = await axios.get(`https://api.zoom.us/v2/past_meetings/${id}/participants`, {
      headers: { Authorization: `Bearer ${token}` }, params: { page_size: 300 }, timeout: 15000,
    });
    lista = res.data.participants || [];
  } catch (err) {
    const d = err.response && err.response.data;
    // 3001 = la reunión no existe / aún no ha terminado / no es de esta cuenta
    return { ok: false, error: (d && (d.message || d.code)) || err.message, codigo: d && d.code };
  }
  const em = String(email || '').toLowerCase();
  const tokens = nombres.map(_norm).filter(Boolean).map((n) => n.split(/\s+/));
  const p = lista.find((x) => {
    if (em && String(x.user_email || '').toLowerCase() === em) return true;
    const zn = _norm(x.name).split(/\s+/);
    return tokens.some((t) => t.length && zn.includes(t[0]) && (t.length === 1 || zn.length === 1 || t.slice(1).some((ap) => zn.includes(ap))));
  });
  const minutos = p ? Math.round(lista.filter((x) => x.name === p.name).reduce((m, x) => m + (x.duration || 0), 0) / 60) : 0;
  return { ok: true, asistio: Boolean(p), minutos, participante: p ? p.name : null, total: lista.length };
}

module.exports = { getMeetingParticipants, checkAttendance, isConfigured, asistenciaDe, meetingIdDe };
