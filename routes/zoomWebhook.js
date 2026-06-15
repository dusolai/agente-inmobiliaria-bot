const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const config = require('../config/config');
const leadManager = require('../services/leadManager');
const activityLog = require('../services/activityLog');
const messaging = require('../services/messaging');
const conversationFlow = require('../services/conversationFlow');
const messages = require('../templates/messages');

/**
 * Webhook de Zoom en tiempo real.
 *
 * Suscribir en la app Server-to-Server OAuth de Zoom estos eventos:
 *   - endpoint.url_validation              (handshake inicial obligatorio)
 *   - meeting.participant_joined           (alguien entra a la reunión)
 *   - meeting.participant_left             (alguien sale de la reunión)
 *   - meeting.ended                        (la reunión termina)
 *
 * Como matchea cada participante con un lead:
 *   1. Intenta por email (si el participante entró logueado).
 *   2. Si no, intenta por nombre (case-insensitive, contiene/contiene).
 *
 * Cuando detectamos que un lead JOIN-ed, registramos `meeting_joined`.
 * Cuando LEAVE-d, calculamos los minutos que estuvo. Si supera el umbral
 * (config.zoom.minutosAsistenciaValida), disparamos el envío del cierre
 * 1-a-1 automáticamente, sin necesidad de pulsar nada en el panel.
 */

// ─── Verificación de firma (HMAC-SHA256) ─────────────────────────
function verifySignature(req) {
  const secret = config.zoom.webhookSecretToken;
  if (!secret) return true; // si no hay secret, no verificamos (modo dev)
  const ts = req.headers['x-zm-request-timestamp'];
  const sigHeader = req.headers['x-zm-signature']; // formato "v0=<hash>"
  if (!ts || !sigHeader) return false;
  const message = `v0:${ts}:${JSON.stringify(req.body)}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
}

// ─── Cache temporal para juntar JOIN+LEAVE en un único "asistio" ─
// Estructura: { meetingId: { participantKey: { leadId, joinAt, leaveAt } } }
const sesiones = new Map();
function _claveSesion(meetingId, participantId) {
  return `${meetingId}::${participantId}`;
}

// ─── Match de participante con lead ─────────────────────────────
function _findLeadFromParticipant(p) {
  const email = (p.email || p.user_email || '').toLowerCase();
  const nombre = (p.user_name || p.name || '').toLowerCase().trim();
  if (!email && !nombre) return null;
  const todos = leadManager.getAllLeads();
  if (email) {
    const m = todos.find((l) => l.email && l.email.toLowerCase() === email);
    if (m) return m;
  }
  if (nombre) {
    // Match laxo por nombre: cualquier lead cuyo nombre esté contenido en el del participante o viceversa
    const m = todos.find((l) => {
      const ln = (l.nombre || '').toLowerCase().trim();
      if (!ln || ln === 'sin nombre') return false;
      return ln === nombre || nombre.includes(ln) || ln.includes(nombre);
    });
    if (m) return m;
  }
  return null;
}

// ─── Endpoint ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { event, payload } = req.body || {};

    // 1) Handshake inicial cuando configuras la URL en el marketplace
    if (event === 'endpoint.url_validation') {
      const plainToken = payload && payload.plainToken;
      if (!config.zoom.webhookSecretToken) {
        return res.status(500).json({ error: 'ZOOM_WEBHOOK_SECRET_TOKEN no configurado' });
      }
      const encrypted = crypto
        .createHmac('sha256', config.zoom.webhookSecretToken)
        .update(plainToken)
        .digest('hex');
      return res.json({ plainToken, encryptedToken: encrypted });
    }

    // 2) Verificar firma
    if (!verifySignature(req)) {
      console.warn('⚠️  [ZoomWebhook] Firma inválida');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const meeting = (payload && payload.object) || {};
    const meetingId = meeting.id || meeting.uuid;
    const participant = meeting.participant || {};

    if (event === 'meeting.participant_joined') {
      const lead = _findLeadFromParticipant(participant);
      const partKey = participant.participant_user_id || participant.user_id || participant.id || participant.user_name;
      const clave = _claveSesion(meetingId, partKey);
      const joinAt = participant.join_time ? new Date(participant.join_time) : new Date();

      if (lead) {
        sesiones.set(clave, { leadId: lead.id, joinAt: joinAt.toISOString() });
        activityLog.appendActivity(lead.id, 'meeting_joined', {
          meetingId,
          nombre: participant.user_name,
          ts: joinAt.toISOString(),
        });
        console.log(`🎥 [ZoomWebhook] ${lead.nombre} entró a reunión ${meetingId}`);
      } else {
        sesiones.set(clave, { leadId: null, joinAt: joinAt.toISOString() });
        console.log(`🎥 [ZoomWebhook] Participante sin lead asociado: ${participant.user_name}`);
      }
      return res.json({ ok: true });
    }

    if (event === 'meeting.participant_left') {
      const partKey = participant.participant_user_id || participant.user_id || participant.id || participant.user_name;
      const clave = _claveSesion(meetingId, partKey);
      const sesion = sesiones.get(clave);
      sesiones.delete(clave);

      const leaveAt = participant.leave_time ? new Date(participant.leave_time) : new Date();
      const joinAt = sesion ? new Date(sesion.joinAt) : null;
      const minutos = joinAt ? Math.round((leaveAt - joinAt) / 60000) : null;

      if (sesion && sesion.leadId) {
        const lead = leadManager.getLeadById(sesion.leadId);
        activityLog.appendActivity(lead.id, 'meeting_left', { meetingId, minutos });
        console.log(`🚪 [ZoomWebhook] ${lead.nombre} salió tras ${minutos} min`);

        // Si superó el umbral, marcamos asistio + disparamos el cierre 1-a-1
        const umbral = config.zoom.minutosAsistenciaValida;
        if (minutos !== null && minutos >= umbral) {
          const ok = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
          if (!ok.error) {
            const enlace = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
            const texto = messages.mensajeCierre({ nombre: lead.nombre, enlaceCalendly: enlace });
            await messaging.sendTextMessage(lead.telefono, texto);
            console.log(`🤝 [ZoomWebhook] Cierre 1-a-1 enviado a ${lead.nombre} (asistió ${minutos} min)`);
          }
        } else {
          // Salió pronto: lo dejamos avisado para que el equipo pueda recuperar
          console.log(`⏰ [ZoomWebhook] ${lead.nombre} solo estuvo ${minutos} min (umbral ${umbral})`);
        }
      }
      return res.json({ ok: true });
    }

    if (event === 'meeting.ended') {
      // Cualquier participante que siguiese en `sesiones` para este meeting:
      // asumimos que se quedó hasta el final → calculamos su asistencia.
      const endAt = (payload && payload.object && payload.object.end_time)
        ? new Date(payload.object.end_time)
        : new Date();
      for (const [clave, sesion] of sesiones.entries()) {
        if (!clave.startsWith(`${meetingId}::`)) continue;
        const minutos = Math.round((endAt - new Date(sesion.joinAt)) / 60000);
        if (sesion.leadId) {
          const lead = leadManager.getLeadById(sesion.leadId);
          if (lead) {
            activityLog.appendActivity(lead.id, 'meeting_left', { meetingId, minutos, reason: 'meeting_ended' });
            if (minutos >= config.zoom.minutosAsistenciaValida) {
              const ok = leadManager.transitionState(lead.id, leadManager.LEAD_STATES.REUNION_ASISTIO);
              if (!ok.error) {
                const enlace = conversationFlow.enlaceRedirectorCalendly(lead, 'individual');
                const texto = messages.mensajeCierre({ nombre: lead.nombre, enlaceCalendly: enlace });
                await messaging.sendTextMessage(lead.telefono, texto);
              }
            }
          }
        }
        sesiones.delete(clave);
      }
      return res.json({ ok: true });
    }

    // Evento desconocido: lo ignoramos pero confirmamos recepción
    return res.json({ ok: true, ignored: event });
  } catch (err) {
    console.error('❌ [ZoomWebhook] Error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
