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

module.exports = { getMeetingParticipants, checkAttendance, isConfigured };
