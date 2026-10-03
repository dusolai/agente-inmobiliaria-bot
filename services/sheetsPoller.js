const fs = require('fs');
const path = require('path');
const config = require('../config/config');

/**
 * Lector automático de la hoja de Google de la campaña de Karen
 * ("NUEVA: Captación agentes inmobiliarios", pestaña DIC25).
 *
 * Meta vuelca en esa hoja cada lead del formulario. Cada SHEETS_POLL_MINUTES
 * (10 por defecto) leemos la hoja, detectamos filas nuevas (por el id del
 * lead de Meta) con fecha ≥ SHEETS_DESDE y las damos de alta en la campaña
 * activa como segmento "directo"; si estamos en horario, se les escribe AL
 * MOMENTO con la plantilla de "nuevos en directo" (reunión 24-09: "los que
 * entren en directo se contactan nada más entrar"). Fuera de horario quedan
 * en cola y el activador diario los suelta los primeros a primera hora.
 *
 * Requisitos (variables en Seenode):
 *   GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 *   GOOGLE_SHEETS_TAB (def. DIC25), SHEETS_DESDE (YYYY-MM-DD; si falta, se
 *   fija el día del primer arranque y lo anterior se considera ya importado)
 *   SHEETS_POLL_ENABLED=0 para apagarlo.
 * Y la hoja debe estar COMPARTIDA con el email de la cuenta de servicio.
 *
 * Estado en data/sheets_state.json: { desde, vistos: [ids], ultimaLectura }.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'sheets_state.json');

let _timer = null;
let _ultimo = { ts: null, ok: null, error: null, filas: 0, nuevos: 0, activados: 0 };
let _enCurso = false;

function _leerEstado() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch (e) { return { desde: null, vistos: [] }; }
}
function _guardarEstado(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf-8');
  try { require('./backupDb').guardarPronto(); } catch (e) { /* sin copia */ }
}

function estaActivo() {
  const g = config.google;
  return Boolean(
    g.pollEnabled && g.sheetsId && g.serviceAccountEmail && g.privateKey &&
    g.serviceAccountEmail !== 'tu_service_account@proyecto.iam.gserviceaccount.com' &&
    g.sheetsId !== 'tu_spreadsheet_id'
  );
}

function _desde() {
  return config.google.desde || _leerEstado().desde || null;
}

/**
 * Contacto inmediato a un lead nuevo en directo. Solo en horario
 * (DIRECTO_HORA_INICIO–FIN, def. 9–22); fuera, se queda en cola.
 * Devuelve true si el mensaje salió de verdad.
 */
async function activarYa(lead) {
  const leadManager = require('./leadManager');
  const messaging = require('./messaging');
  const messages = require('../templates/messages');
  const activityLog = require('./activityLog');

  const hora = new Date().getHours();
  const ini = parseInt(process.env.DIRECTO_HORA_INICIO, 10) || 9;
  const fin = parseInt(process.env.DIRECTO_HORA_FIN, 10) || 22;
  if (hora < ini || hora >= fin) {
    console.log(`🌙 [Sheets] ${lead.nombre} llegó fuera de horario (${hora}h): queda en cola para primera hora`);
    return false;
  }
  if (!messaging.plantillaParaSegmento('directo')) {
    console.warn('⚠️  [Sheets] Sin plantilla para "directo" (WHATSAPP_TEMPLATE_DIRECTO): el lead queda en cola');
    return false;
  }
  const texto = messages.mensajeReactivacion({ nombre: lead.nombre, segmento: 'directo' });
  const envio = await messaging.sendPrimerContacto(lead, texto, { delaySeconds: 0 });
  if (!envio || envio.success === false || envio.mode === 'development') return false;

  leadManager.transitionState(lead.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
  leadManager.updateLead(lead.id, {
    recordatorios: { ...lead.recordatorios, fase1: { enviados: 0, ultimoEnvio: new Date().toISOString() } },
  });
  activityLog.appendActivity(lead.id, 'lead_activated', { motivo: 'nuevo en directo (hoja de Google)' });
  return true;
}

/**
 * Lee la hoja y da de alta los leads nuevos. `activar: false` solo los crea
 * (quedan en cola).
 */
async function sincronizar({ activar = true } = {}) {
  if (!estaActivo()) return { ok: false, error: 'lector de la hoja desactivado o sin credenciales de Google' };
  if (_enCurso) return { ok: false, error: 'ya hay una lectura en curso' };
  _enCurso = true;
  try {
    const sheets = require('./sheets');
    const metaLeads = require('./metaLeads');
    const importador = require('./importador');

    const filas = await sheets.readAllRows(config.google.sheetsTab);
    const st = _leerEstado();
    const vistos = new Set(st.vistos || []);
    if (!st.desde && !config.google.desde) {
      // Primer arranque sin SHEETS_DESDE: lo anterior a hoy ya está importado
      // del CSV; solo nos interesan los que entren a partir de ahora.
      st.desde = new Date().toISOString().slice(0, 10);
    }
    const desde = config.google.desde || st.desde;

    const candidatas = [];
    for (const fila of filas) {
      const l = metaLeads.filaALead(fila);
      const clave = l.metaLeadId || `${l.telefono}|${(l.fechaLead || '').slice(0, 10)}`;
      if (vistos.has(clave)) continue;
      if (l.esTest || !l.telefono) { vistos.add(clave); continue; }
      if (!l.fechaLead || l.fechaLead.slice(0, 10) < desde) { vistos.add(clave); continue; }
      candidatas.push({ ...l, clave, segmento: 'directo' });
    }

    const creados = [];
    const resultado = importador.importar(candidatas, { fuente: 'meta_sheet', segmentoPorDefecto: 'directo', creados });
    for (const l of candidatas) vistos.add(l.clave);
    st.vistos = Array.from(vistos).slice(-5000);
    st.ultimaLectura = new Date().toISOString();
    _guardarEstado(st);

    let activados = 0;
    if (activar) {
      for (const lead of creados) {
        try { if (await activarYa(lead)) activados++; } catch (e) { console.error('❌ [Sheets] activando', lead.nombre, e.message); }
      }
    }
    _ultimo = { ts: st.ultimaLectura, ok: true, error: null, filas: filas.length, nuevos: creados.length, activados, resultado };
    if (creados.length) console.log(`📄 [Sheets] ${filas.length} filas · ${creados.length} leads nuevos en directo · ${activados} contactados ya`);
    return _ultimo;
  } catch (err) {
    _ultimo = { ts: new Date().toISOString(), ok: false, error: err.message, filas: 0, nuevos: 0, activados: 0 };
    console.error('❌ [Sheets] Error leyendo la hoja:', err.message);
    return _ultimo;
  } finally {
    _enCurso = false;
  }
}

function iniciar() {
  if (!estaActivo()) {
    console.log('ℹ️  [Sheets] Lector automático de la hoja desactivado (faltan GOOGLE_SHEETS_ID / credenciales, o SHEETS_POLL_ENABLED=0)');
    return;
  }
  const min = config.google.pollMinutes;
  console.log(`📄 [Sheets] Lector de la hoja "${config.google.sheetsTab}" cada ${min} min (leads desde ${_desde() || 'hoy'})`);
  setTimeout(() => sincronizar().catch(() => {}), 20000);
  _timer = setInterval(() => sincronizar().catch(() => {}), min * 60 * 1000);
}

function estado() {
  return {
    activo: estaActivo(),
    tab: config.google.sheetsTab,
    cadaMinutos: config.google.pollMinutes,
    desde: _desde(),
    ultimo: _ultimo,
  };
}

module.exports = { iniciar, sincronizar, estado, estaActivo, activarYa };
