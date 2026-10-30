/**
 * Prueba funcional del lanzamiento de octubre 2026 — SIN enviar nada.
 *
 * Arranca los módulos con un DATA_DIR temporal, simula el canal de WhatsApp
 * (nada sale de verdad) y comprueba de punta a punta:
 *   1. campañas: legado → nueva campaña activa, la anterior archivada
 *   2. importador: segmentos por fecha, duplicados, bajas, repetidos
 *   3. activación diaria por turnos entre segmentos + pausa + sin plantilla
 *   4. alta automática de un número desconocido que escribe al agente
 *   5. modo presentación en directo: invitación → reserva → asistencia → 1-a-1
 *   6. los leads de una campaña archivada no reciben recordatorios
 *
 * Uso (desde la carpeta del bot):  node scripts/test-lanzamiento.js
 * Opcional: CSV_LEADS=ruta/al/export_de_meta.csv para probar con la lista real.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// ─── Entorno aislado ANTES de cargar nada ─────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-inmo-test-'));
process.env.DATA_DIR = tmp;
process.env.WHATSAPP_PROVIDER = 'cloud';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test';
process.env.WHATSAPP_ACCESS_TOKEN = 'test';
process.env.WHATSAPP_TEMPLATE_NAME = 'reactivacion_leads';
process.env.WHATSAPP_TEMPLATE_VERANO = 'reactivacion_verano';
process.env.WHATSAPP_TEMPLATE_SEPTIEMBRE = 'reactivacion_septiembre';
process.env.WHATSAPP_TEMPLATE_DIRECTO = 'bienvenida_directo';
process.env.ACTIVACION_HORA_INICIO = '0';
process.env.ACTIVACION_HORA_FIN = '24';
process.env.DIRECTO_HORA_INICIO = '0';
process.env.DIRECTO_HORA_FIN = '24';
process.env.TYPING_DELAY_SECONDS = '0';
process.env.LEADS_POR_DIA = '25';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.DATABASE_URL;

const config = require('../config/config');
const whatsapp = require('../services/whatsapp');
const leadManager = require('../services/leadManager');
const activityLog = require('../services/activityLog');
const campanas = require('../services/campanas');
const metaLeads = require('../services/metaLeads');
const importador = require('../services/importador');
const messaging = require('../services/messaging');
const scheduler = require('../services/scheduler');
const conversationFlow = require('../services/conversationFlow');

// ─── Canal simulado: registramos lo que "saldría" ──────────────────
const enviados = [];
whatsapp.sendTemplate = async (to, params, opts = {}) => {
  enviados.push({ to: String(to), tipo: 'plantilla', plantilla: opts.name || config.whatsapp.templateName, params });
  return { success: true, mode: 'production', id: 'wamid.test' };
};
whatsapp.sendTextMessage = async (to, body) => {
  enviados.push({ to: String(to), tipo: 'texto', body: String(body) });
  return { success: true, mode: 'production', id: 'wamid.test' };
};
whatsapp.renderTemplate = async () => null;
whatsapp.getTemplateBotones = async () => [];
whatsapp.getTemplateVars = async () => ['nombre'];
whatsapp.sendTypingAction = async () => {};
whatsapp.isConfigured = () => true;
const paraTel = (tel) => enviados.filter((e) => e.to === tel);

let paso = 0;
function ok(msg) { paso++; console.log(`  ✅ ${paso}. ${msg}`); }

// Borra la última activación de cada campaña: así el siguiente ciclo no
// espera el intervalo (en la vida real, ~30 min entre envíos de una campaña).
function activationReset() {
  const f = path.join(tmp, 'activation.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) {}
  for (const c of Object.values(st.porCampana || {})) c.ultimaActivacion = null;
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
}

(async () => {
  console.log(`\n🧪 Prueba del lanzamiento (datos en ${tmp})\n`);

  // ── 1. Campañas ───────────────────────────────────────────────
  assert.deepStrictEqual(campanas.activas(), [campanas.CAMPANA_LEGADO]);
  const ana = leadManager.createLead({ nombre: 'Ana Legado', telefono: '34600000001', fuente: 'excel_import' });
  leadManager.transitionState(ana.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
  leadManager.updateLead(ana.id, { recordatorios: { ...ana.recordatorios, fase1: { enviados: 1, ultimoEnvio: '2026-09-20T10:00:00.000Z' } } });
  const luis = leadManager.createLead({ nombre: 'Luis Baja', telefono: '34600000002', fuente: 'excel_import' });
  activityLog.appendActivity(luis.id, 'opt_out', { texto: 'no me interesa' });
  leadManager.updateLead(luis.id, { estado: 'descartado' });
  assert.strictEqual(leadManager.getLeadById(ana.id).campana, campanas.CAMPANA_LEGADO);
  ok('leads antiguos quedan en la campaña legado "prueba_sep26"');

  campanas.setEstado(campanas.CAMPANA_LEGADO, 'archivada');
  const vacia = campanas.crearCampana({ nombre: 'Lanzamiento octubre 26' });
  const otra = campanas.crearCampana({ nombre: 'Otra prueba', leadsPorDia: 5 });
  assert.deepStrictEqual(campanas.activas().sort(), [vacia.id, otra.id].sort(), 'crear una campaña NO archiva las demás');
  assert.strictEqual(vacia.leadsPorDia, 20, 'cupo por defecto 20/día');
  assert.ok(campanas.eliminar(vacia.id) && campanas.eliminar(otra.id));
  ok('varias campañas activas a la vez; crear una no toca las demás; las vacías se borran');

  // ── 2. Importador ─────────────────────────────────────────────
  let filas;
  const csvReal = process.env.CSV_LEADS;
  if (csvReal && fs.existsSync(csvReal)) {
    filas = metaLeads.parseCSV(fs.readFileSync(csvReal, 'utf-8'));
    console.log(`  (usando el CSV real: ${filas.length} filas)`);
  } else {
    const fila = (id, fecha, nombre, tel, email) => ({
      id, created_time: fecha, full_name: nombre, phone_number: tel, email,
      '¿tienes_experiencia_en_el_sector_inmobiliario?': 'no,_pero_quiero_empezar_en_el_sector.',
    });
    filas = [
      fila('l:0', '2025-12-16T06:34:10-05:00', '<test lead: dummy data for full_name>', 'p:<test lead: dummy data for phone_number>', 'test@fb.com'),
      fila('l:1', '2025-12-13T09:37:58-05:00', 'Viejo Uno', 'p:+34611000001', 'v1@x.com'),
      fila('l:2', '2026-03-02T09:37:58-05:00', 'Viejo Dos', 'p:+34611000002', 'v2@x.com'),
      fila('l:3', '2026-06-30T10:00:00-05:00', 'Viejo Tres', 'p:611000003', 'v3@x.com'),
      fila('l:4', '2026-07-05T10:00:00-05:00', 'Verano Uno', 'p:+34611000004', 'ver1@x.com'),
      fila('l:5', '2026-08-20T10:00:00-05:00', 'Verano Dos', 'p:+34611000005', 'ver2@x.com'),
      fila('l:6', '2026-09-10T10:00:00-05:00', 'Sept Uno', 'p:+34611000006', 's1@x.com'),
      fila('l:7', '2026-10-02T04:50:22-05:00', 'Sept Dos', 'p:+34611000007', 's2@x.com'),
      fila('l:8', '2026-02-01T10:00:00-05:00', 'Repetido Antiguo', 'p:+34611000004', 'ver1@x.com'), // mismo tel que Verano Uno, más antiguo
      fila('l:9', '2026-05-01T10:00:00-05:00', 'Extranjera', 'p:+33769700635', 'fr@x.com'),
      fila('l:10', '2026-04-01T10:00:00-05:00', 'Ana Legado', 'p:+34600000001', 'ana@x.com'), // ya contactada en la campaña archivada
      fila('l:11', '2026-04-02T10:00:00-05:00', 'Luis Baja', 'p:+34600000002', 'luis@x.com'), // pidió la baja
    ];
  }
  const proc = metaLeads.procesarFilas(filas);
  console.log(`  filas ${proc.stats.total} · válidos ${proc.stats.validos} · a revisar ${proc.stats.revisar} · excluidos ${proc.stats.excluidos} · por segmento ${JSON.stringify(proc.porSegmento)}`);
  if (!csvReal) {
    assert.deepStrictEqual(proc.porSegmento, { viejos: 5, verano: 2, septiembre: 2 });
    assert.strictEqual(proc.stats.revisar, 1, 'la extranjera queda a revisar');
    assert.ok(proc.excluidos.some((e) => e.nombre === 'Repetido Antiguo'), 'el duplicado más antiguo se excluye');
    assert.ok(proc.excluidos.some((e) => /prueba/.test(e.motivo)), 'la fila de prueba se excluye');
    assert.strictEqual(proc.validos.find((l) => l.nombre === 'Viejo Tres').telefono, '34611000003', 'móvil de 9 cifras recibe el 34');
  }
  ok('metaLeads: limpieza, dedupe (se conserva la entrada más reciente), segmento por fecha');

  const r1 = importador.importar(proc.validos, { fuente: 'excel_import', campana: 'auto', sufijo: 'oct26' });
  console.log(`  import → ${JSON.stringify(r1)}`);
  const cViejos = campanas.paraSegmento('viejos');
  const cVerano = campanas.paraSegmento('verano');
  const cSept = campanas.paraSegmento('septiembre');
  assert.ok(cViejos && cVerano && cSept, 'se crean las tres campañas');
  assert.strictEqual(cVerano.nombre, 'Verano (jul-ago) · oct26');
  assert.deepStrictEqual(campanas.activas().sort(), [cViejos.id, cVerano.id, cSept.id].sort(), 'las tres activas a la vez');
  assert.ok([cViejos, cVerano, cSept].every((c) => c.leadsPorDia === 20), '20/día cada una');
  if (!csvReal) {
    assert.strictEqual(r1.creados, 8);
    assert.deepStrictEqual(r1.porCampana, { [cViejos.id]: 4, [cVerano.id]: 2, [cSept.id]: 2 });
    assert.strictEqual(r1.excluidosBaja, 1, 'Luis Baja no se vuelve a crear');
    assert.strictEqual(r1.repetidosDeOtraCampana, 1, 'Ana Legado se crea marcada');
    const ana2 = leadManager.getLeadByPhone('34600000001');
    assert.strictEqual(ana2.campana, cViejos.id, 'getLeadByPhone prefiere el lead de una campaña viva');
    assert.strictEqual(ana2.contactadoAntesEn, campanas.CAMPANA_LEGADO);
    assert.strictEqual(leadManager.getLeadByPhone('34611000007').campana, cSept.id);
    assert.strictEqual(leadManager.getLeadByPhone('34611000007').fechaLead.slice(0, 10), '2026-10-02');
  }
  const r2 = importador.importar(proc.validos, { fuente: 'excel_import', campana: 'auto', sufijo: 'oct26' });
  assert.strictEqual(r2.creados, 0);
  assert.strictEqual(r2.duplicados, r1.creados, 'reimportar no duplica (ni en otra campaña viva)');
  assert.strictEqual(campanas.listar().length, 4, 'reimportar no crea campañas nuevas');
  ok('importador: una campaña por segmento (activas, 20/día), excluye bajas, marca repetidos, no duplica');

  assert.strictEqual(leadManager.getStats({ campana: 'activas' }).total, r1.creados);
  assert.strictEqual(leadManager.getStats({ campana: cVerano.id }).total, r1.porCampana[cVerano.id] || 0);
  assert.strictEqual(leadManager.getStats({ campana: 'todas' }).total, r1.creados + 2);
  ok('stats filtran por campaña (todas las activas / una / todas)');

  // ── 3. Activación por campaña ─────────────────────────────────
  if (!csvReal) {
    const antes = enviados.length;
    const porCamp = {};
    for (let i = 0; i < 6; i++) {
      activationReset();
      await scheduler.procesarActivacionDiaria();
      const ultimo = enviados[enviados.length - 1];
      const lead = leadManager.getLeadByPhone(ultimo.to);
      const k = `${lead.campana}:${ultimo.plantilla}`;
      porCamp[k] = (porCamp[k] || 0) + 1;
    }
    console.log(`  envíos por campaña → ${JSON.stringify(porCamp)}`);
    assert.strictEqual(enviados.length - antes, 6, 'un envío por ciclo, nunca ráfagas');
    assert.ok(porCamp[`${cViejos.id}:reactivacion_leads`] && porCamp[`${cVerano.id}:reactivacion_verano`] && porCamp[`${cSept.id}:reactivacion_septiembre`],
      'las tres campañas avanzan a la vez, cada una con su plantilla');
    assert.strictEqual(scheduler.activadosHoy(cViejos.id) + scheduler.activadosHoy(cVerano.id) + scheduler.activadosHoy(cSept.id), 6);
    ok('activación: las tres campañas a la vez, cada una con su plantilla y su contador');

    campanas.setCupo(cViejos.id, scheduler.activadosHoy(cViejos.id)); // cupo agotado hoy
    campanas.setEstado(cVerano.id, 'pausada');
    const nAntes = enviados.length;
    for (let i = 0; i < 3; i++) { activationReset(); await scheduler.procesarActivacionDiaria(); }
    const nuevos = enviados.slice(nAntes).map((e) => leadManager.getLeadByPhone(e.to).campana);
    assert.ok(nuevos.every((id) => id === cSept.id), 'con viejos en su cupo y verano en pausa, solo sale septiembre');
    campanas.setEstado(cVerano.id, 'activa');
    campanas.setCupo(cViejos.id, 20);
    ok('cupo propio por campaña y pausa de una campaña sin tocar las demás');

    // Lead "directo": se crea solo su campaña; sin plantilla espera
    config.whatsapp.templatesPorSegmento.directo = '';
    const dir = leadManager.createLead({ nombre: 'Directa Nocturna', telefono: '34611000099', fuente: 'meta_sheet', segmento: 'directo' });
    const cDir = campanas.paraSegmento('directo');
    assert.ok(cDir && dir.campana === cDir.id && cDir.nombre === 'Nuevos en directo', 'se crea la campaña "Nuevos en directo"');
    activationReset();
    await scheduler.procesarActivacionDiaria();
    assert.notStrictEqual(enviados[enviados.length - 1].to, '34611000099', 'sin plantilla, el directo no sale');
    config.whatsapp.templatesPorSegmento.directo = 'bienvenida_directo';
    activationReset();
    await scheduler.procesarActivacionDiaria();
    assert.strictEqual(enviados[enviados.length - 1].to, '34611000099', 'con plantilla, el directo va el primero');
    assert.strictEqual(enviados[enviados.length - 1].plantilla, 'bienvenida_directo');
    assert.strictEqual(leadManager.getLeadById(dir.id).estado, 'esperando_cualificacion');
    ok('los leads "directo" van a su propia campaña, esperan si falta plantilla y salen los primeros');
  }

  // ── 4. Alta automática por WhatsApp ───────────────────────────
  await conversationFlow.handleIncoming('34611222333', 'Hola, vi vuestro anuncio', { nombre: 'Pepe Perfil', canal: 'whatsapp' });
  const pepe = leadManager.getLeadByPhone('34611222333');
  assert.ok(pepe, 'se crea el lead');
  assert.strictEqual(pepe.segmento, 'directo');
  assert.strictEqual(pepe.fuente, 'whatsapp_entrante');
  assert.strictEqual(pepe.campana, campanas.paraSegmento('directo').id);
  assert.strictEqual(pepe.estado, 'esperando_cualificacion');
  const msgPepe = paraTel('34611222333');
  assert.strictEqual(msgPepe.length, 1);
  assert.ok(/acabas de mostrar interés/.test(msgPepe[0].body) && /1️⃣/.test(msgPepe[0].body), 'recibe la pregunta de filtrado de "directo" como texto');
  await conversationFlow.handleIncoming('34611222333', 'Soy agente inmobiliario');
  assert.strictEqual(leadManager.getLeadById(pepe.id).perfil, 'profesional');
  assert.strictEqual(leadManager.getLeadById(pepe.id).estado, 'video_enviado');
  assert.ok(/pages\.dev/.test(paraTel('34611222333')[1].body), 'modo landing: recibe la landing');
  ok('un desconocido que escribe al WhatsApp se da de alta como "directo" y entra en el embudo');

  // ── 5. Modo presentación en directo ───────────────────────────
  config.flujo.trasCualificar = 'presentacion';
  await conversationFlow.handleIncoming('34611444555', 'Busco ingresos extra', { nombre: 'Lola' });
  const lola = leadManager.getLeadByPhone('34611444555');
  assert.strictEqual(lola.perfil, 'emprendedor');
  assert.strictEqual(lola.estado, 'video_enviado');
  assert.ok(/\/r\/grupal\?l=/.test(paraTel('34611444555')[0].body), 'recibe la invitación a la presentación (Calendly grupal)');
  await conversationFlow.procesarReservaGrupal(lola, { via: 'webhook', inicio: '2026-10-07T10:00:00Z' });
  let lola2 = leadManager.getLeadById(lola.id);
  assert.strictEqual(lola2.estado, 'video_visto');
  assert.strictEqual(lola2.presentacionAt, '2026-10-07T10:00:00Z');
  assert.ok(/plaza en la presentación está reservada/.test(paraTel('34611444555')[1].body));
  const asis = await conversationFlow.procesarAsistenciaReunion(lola2, { minutos: 32, via: 'zoom' });
  assert.ok(asis.cierreEnviado);
  lola2 = leadManager.getLeadById(lola.id);
  assert.strictEqual(lola2.estado, 'reunion_registrado');
  assert.ok(/\/r\/individual\?l=/.test(paraTel('34611444555')[2].body), 'tras asistir recibe el 1-a-1');
  ok('modo presentación: invitación → reserva confirmada → asistió al Zoom → 1-a-1 enviado');

  const noa = leadManager.createLead({ nombre: 'Noa', telefono: '34611666777', segmento: 'septiembre' });
  leadManager.updateLead(noa.id, { estado: 'video_visto', perfil: 'profesional', presentacionAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
  activityLog.appendActivity(noa.id, 'message_received', { texto: 'Soy agente' }); // ventana de 24 h abierta
  await scheduler.ejecutarCiclo();
  const noa2 = leadManager.getLeadById(noa.id);
  assert.strictEqual(noa2.recordatorios.fase2c.enviados, 1, 'no asistió → recordatorio con el enlace de la presentación');
  assert.ok(/\/r\/grupal\?l=/.test(paraTel('34611666777')[0].body));
  config.flujo.trasCualificar = 'landing';
  ok('modo presentación: quien reserva y no entra al Zoom recibe otra invitación');

  // ── 6. Campaña archivada congelada ────────────────────────────
  const nAna = paraTel('34600000001').length;
  await scheduler.ejecutarCiclo();
  const anaLegado = leadManager.getLeadById(ana.id);
  assert.strictEqual(anaLegado.recordatorios.fase1.enviados, 1, 'el lead de la campaña archivada no recibe recordatorios');
  assert.strictEqual(paraTel('34600000001').length, nAna, 'ni un mensaje más a la campaña archivada');
  ok('los leads de la campaña archivada no reciben automatismos');

  // ── 6b. Anti-bloqueo (revisión de la campaña de prueba) ────────
  {
    const vivas = campanas.paraSegmento('viejos');
    const hace = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    // a) "Sí, envíamelo" con respuestas del formulario → landing profesional sin repreguntar
    const sara = leadManager.createLead({ nombre: 'Sara', telefono: '34622000001', campana: vivas.id, segmento: 'viejos', respuestas: { 'experiencia': 'no, pero quiero empezar' } });
    leadManager.transitionState(sara.id, 'esperando_cualificacion');
    await conversationFlow.handleIncoming('34622000001', 'Sí, envíamelo');
    assert.strictEqual(leadManager.getLeadById(sara.id).perfil, 'profesional');
    assert.strictEqual(leadManager.getLeadById(sara.id).estado, 'video_enviado');
    // b) respuesta automática de empresa → no se contesta
    const n0 = enviados.length;
    const bot = leadManager.createLead({ nombre: 'Empresa SL', telefono: '34622000002', campana: vivas.id, segmento: 'viejos' });
    leadManager.transitionState(bot.id, 'esperando_cualificacion');
    await conversationFlow.handleIncoming('34622000002', 'Gracias por comunicarte con nosotros. En este momento no podemos atenderte');
    assert.strictEqual(enviados.length, n0, 'no se contesta a un contestador automático');
    // c) "No me interesa" (botón) → baja
    await conversationFlow.handleIncoming('34622000002', 'No me interesa');
    assert.strictEqual(leadManager.getLeadById(bot.id).estado, 'descartado');
    ok('"Sí, envíamelo" usa el formulario, no se contesta a contestadores, "No me interesa" da de baja');

    // d) Fase 1: nunca se repite la pregunta; sin plantilla de recordatorio → descarte silencioso
    const t1 = leadManager.createLead({ nombre: 'Tomas', telefono: '34622000003', campana: vivas.id, segmento: 'viejos' });
    leadManager.transitionState(t1.id, 'esperando_cualificacion');
    leadManager.updateLead(t1.id, { recordatorios: { ...t1.recordatorios, fase1: { enviados: 0, ultimoEnvio: hace(60) } } });
    const t2 = leadManager.createLead({ nombre: 'Teresa', telefono: '34622000004', campana: vivas.id, segmento: 'viejos' });
    leadManager.transitionState(t2.id, 'esperando_cualificacion');
    leadManager.updateLead(t2.id, { recordatorios: { ...t2.recordatorios, fase1: { enviados: 0, ultimoEnvio: hace(80) } } });
    config.whatsapp.templateRecordatorioCualificacion = '';
    await scheduler.ejecutarCiclo();
    assert.strictEqual(paraTel('34622000003').length, 0, 'sin plantilla de recordatorio, no se reenvía la pregunta');
    assert.strictEqual(leadManager.getLeadById(t1.id).estado, 'esperando_cualificacion', 'a las 60 h aún espera');
    assert.strictEqual(leadManager.getLeadById(t2.id).estado, 'descartado', 'a las 72 h se descarta');
    assert.strictEqual(paraTel('34622000004').length, 0, 'descarte en silencio: sin despedida fuera de la ventana');
    // con plantilla: UN recordatorio distinto, y nunca un segundo
    config.whatsapp.templateRecordatorioCualificacion = 'recordatorio_cualificacion';
    await scheduler.ejecutarCiclo();
    assert.deepStrictEqual(paraTel('34622000003').map((e) => e.plantilla), ['recordatorio_cualificacion']);
    leadManager.updateLead(t1.id, { recordatorios: { ...leadManager.getLeadById(t1.id).recordatorios, fase1: { enviados: 1, ultimoEnvio: hace(50) } } });
    await scheduler.ejecutarCiclo();
    assert.strictEqual(paraTel('34622000003').length, 1, 'un solo recordatorio, nunca dos');
    ok('pregunta inicial una sola vez; como mucho un recordatorio distinto; descarte silencioso');

    // d2) Fase 2B sin plantilla de recordatorio: el lead que contestó NO se descarta
    config.whatsapp.templateRecordatorioPresentacion = '';
    const v = leadManager.createLead({ nombre: 'Vera', telefono: '34622000009', campana: vivas.id, segmento: 'viejos' });
    leadManager.updateLead(v.id, { estado: 'video_enviado', perfil: 'emprendedor', updatedAt: hace(100), recordatorios: { ...v.recordatorios, fase2b: { enviados: 0, ultimoEnvio: hace(100) } } });
    for (let i = 0; i < 4; i++) await scheduler.ejecutarCiclo();
    assert.strictEqual(leadManager.getLeadById(v.id).estado, 'video_enviado', 'sin plantilla no se descarta a quien contestó');
    assert.strictEqual(((leadManager.getLeadById(v.id).recordatorios || {}).fase2b || {}).enviados || 0, 0, 'ni se cuenta un recordatorio que no salió');
    assert.strictEqual(paraTel('34622000009').length, 0, 'y no se le manda nada fuera de la ventana');
    ok('sin plantilla de recordatorio, quien contestó espera (no se descarta sin haber recibido nada)');

    // d3) Botón "Sí, pásame el enlace" del recordatorio → enlace de la sesión (Calendly)
    await conversationFlow.handleIncoming('34622000009', 'Sí, pásame el enlace');
    const r3 = paraTel('34622000009');
    assert.strictEqual(r3.length, 1, 'una sola respuesta');
    assert.ok(/\/r\/grupal\?l=/.test(r3[0].body) && /sesión de dudas/.test(r3[0].body), 'recibe el enlace de la sesión de dudas');
    ok('"Pásame el enlace" (botón del recordatorio) manda directo el enlace de Calendly');

    // d4) Con plantillas: quien vio el vídeo recibe la de la sesión; tras el
    //     último recordatorio NO se descarta en el ciclo siguiente.
    config.whatsapp.templateRecordatorioPresentacion = 'recordatorio_presentacion_three';
    config.whatsapp.templateRecordatorioSesion = 'recordatorio_sesion_three';
    const w = leadManager.createLead({ nombre: 'Wanda', telefono: '34622000010', campana: vivas.id, segmento: 'viejos' });
    leadManager.updateLead(w.id, { estado: 'video_visto', perfil: 'profesional', videoVistoAt: hace(100), updatedAt: hace(100), recordatorios: { ...w.recordatorios, fase2b: { enviados: 1, ultimoEnvio: hace(100) } } });
    await scheduler.ejecutarCiclo();
    assert.strictEqual(paraTel('34622000010').length, 1, 'sale el último recordatorio');
    assert.strictEqual(paraTel('34622000010')[0].plantilla, 'recordatorio_sesion_three', 'vio el vídeo → plantilla de la sesión');
    await scheduler.ejecutarCiclo();
    assert.strictEqual(leadManager.getLeadById(w.id).estado, 'video_visto', 'no se descarta justo después del último recordatorio');
    assert.strictEqual(paraTel('34622000010').length, 1, 'ni se le manda despedida');
    ok('recordatorio con la plantilla según la etapa; tras el último, tiempo para contestar antes de descartar');

    // d5) Ráfaga de mensajes (llegan a la vez por el webhook) → UNA respuesta
    process.env.AGRUPAR_MENSAJES_SEGUNDOS = '0';
    const nV = paraTel('34622000009').length;
    conversationFlow.recibir('34622000009', 'Ok');
    conversationFlow.recibir('34622000009', 'Gracias');
    await conversationFlow.recibir('34622000009', 'Y esto cuánto cuesta?');
    assert.strictEqual(paraTel('34622000009').length - nV, 1, 'tres mensajes seguidos → una sola respuesta');
    const ros = leadManager.createLead({ nombre: 'Rosa B', telefono: '34622000011', campana: vivas.id, segmento: 'viejos' });
    leadManager.updateLead(ros.id, { estado: 'esperando_cualificacion' });
    conversationFlow.recibir('34622000011', 'Soy agente inmobiliario');
    await conversationFlow.recibir('34622000011', 'pero ando de aquí para allá');
    assert.strictEqual(paraTel('34622000011').filter((m) => /pages\.dev/.test(m.body)).length, 1, 'la landing sale una sola vez');
    ok('mensajes en ráfaga: se agrupan y se responde una vez (antes: landing doble, respuestas repetidas)');

    // d6) Reservar primero → preparación → aviso del día → Zoom 1 h antes
    const calendlySync = require('../services/calendlySync');
    const nowReal = Date.now;
    // Siempre en el futuro (5 días desde hoy, 10:00 UTC): si fuera una fecha fija,
    // al pasar el día real la ventana de 24 h se abriría sola y la prueba cambiaría.
    const _hoy = new Date(); const MEDIODIA = Date.UTC(_hoy.getUTCFullYear(), _hoy.getUTCMonth(), _hoy.getUTCDate() + 5, 10, 0, 0);
    Date.now = () => MEDIODIA;
    try {
      // La reserva llega de Calendly (utm_content=lead_<id>) → reunion_registrado
      const p = leadManager.createLead({ nombre: 'Paula', telefono: '34622000012', email: 'paula@x.com', campana: vivas.id, segmento: 'viejos' });
      leadManager.updateLead(p.id, { estado: 'video_enviado', perfil: 'emprendedor' });
      const inv = { uri: 'inv-1', email: 'otra@x.com', tracking: { utm_content: `lead_${p.id}` } };
      assert.strictEqual(calendlySync._leadDeInvitado(inv, leadManager.getAllLeads({})).id, p.id, 'se reconoce por utm');
      assert.strictEqual(calendlySync._leadDeInvitado({ email: 'PAULA@x.com' }, leadManager.getAllLeads({})).id, p.id, 'o por email');
      const inicio = new Date(MEDIODIA + 54 * 3600 * 1000).toISOString(); // dos días después, por la tarde
      const horaSesion = calendlySync.horaDe(inicio);
      await calendlySync.registrarReserva(leadManager.getLeadById(p.id), { inviteeUri: 'inv-1', eventoUri: 'ev-1', inicio, joinUrl: 'https://zoom.us/j/123' });
      let pl = leadManager.getLeadById(p.id);
      assert.strictEqual(pl.estado, 'reunion_registrado', 'reservar = reunion_registrado (no "asistió")');
      assert.strictEqual(paraTel('34622000012').length, 0, 'fuera de ventana no se manda texto (Calendly ya manda su email)');

      // Al día siguiente: preparación con plantilla (no ha visto el webinar)
      config.whatsapp.templateSesionPreparacion = 'sesion_preparacion_three';
      config.whatsapp.templateSesionHoy = 'sesion_hoy_three';
      Date.now = () => MEDIODIA + 24 * 3600 * 1000;
      await scheduler.procesarSesiones();
      assert.strictEqual(paraTel('34622000012').slice(-1)[0].plantilla, 'sesion_preparacion_three', 'aviso de preparación');
      await scheduler.procesarSesiones();
      assert.strictEqual(paraTel('34622000012').length, 1, 'no se repite en el mismo ciclo/día');

      // Contesta con el botón → se le pide opinión y se guarda
      await conversationFlow.handleIncoming('34622000012', 'Ya la he visto');
      assert.ok(/qué te ha parecido/i.test(paraTel('34622000012').slice(-1)[0].body));
      await conversationFlow.handleIncoming('34622000012', 'Me gustaría saber cómo se cobran las comisiones');
      pl = leadManager.getLeadById(p.id);
      assert.ok(pl.feedbackSesion && /comisiones/.test(pl.feedbackSesion[0].texto), 'feedback guardado para Arkaitz');

      // El día de la sesión (≤ 14 h antes): aviso "¿cuento contigo?" (ventana abierta → texto)
      Date.now = () => new Date(inicio).getTime() - 6 * 3600 * 1000;
      const n6 = paraTel('34622000012').length;
      await scheduler.procesarSesiones();
      const avisoHoy = paraTel('34622000012').slice(n6);
      assert.ok(avisoHoy.length === 1 && avisoHoy[0].plantilla === 'sesion_hoy_three' && avisoHoy[0].params[1] === `hoy a las ${horaSesion}`, 'aviso del mismo día (plantilla, ventana cerrada) con la hora');
      await conversationFlow.handleIncoming('34622000012', 'Allí estaré');
      assert.ok(leadManager.getLeadById(p.id).sesion.confirmada, 'asistencia confirmada');

      // Una hora antes: el Zoom (acaba de contestar "Allí estaré" → ventana abierta)
      const messaging = require('../services/messaging');
      const ventanaReal = messaging.dentroDeVentana;
      messaging.dentroDeVentana = () => true;
      Date.now = () => new Date(inicio).getTime() - 60 * 60 * 1000;
      await scheduler.procesarSesiones();
      assert.ok(/zoom\.us\/j\/123/.test(paraTel('34622000012').slice(-1)[0].body), 'enlace del Zoom 1 h antes');
      messaging.dentroDeVentana = ventanaReal;

      // Cambiar de día → enlace para reprogramar; la Fase 3 no le dice "no has reservado"
      await conversationFlow.handleIncoming('34622000012', 'Cambiar de día');
      assert.ok(/\/r\/grupal\?l=/.test(paraTel('34622000012').slice(-1)[0].body));
    } finally {
      Date.now = nowReal;
    }
    ok('sesión reservada: preparación + feedback, aviso del día para confirmar, Zoom 1 h antes, cambiar de día');

    // d7) Repesca: solo a quien dijo su perfil y contestó; una plantilla con los huecos
    const cs = require('../services/calendlySync');
    const huecosReal = cs.huecosTexto;
    cs.huecosTexto = async () => 'el lunes 19 a las 17:00 o el martes 20 a las 16:30';
    try {
      config.whatsapp.templateSesionHuecos = 'sesion_huecos_three';
      const r1 = leadManager.createLead({ nombre: 'Remo', telefono: '34622000013', campana: vivas.id, segmento: 'viejos' });
      leadManager.updateLead(r1.id, { estado: 'descartado', perfil: 'profesional' });
      activityLog.appendActivity(r1.id, 'message_received', { texto: 'Soy agente inmobiliario' });
      const r2 = leadManager.createLead({ nombre: 'Baja', telefono: '34622000014', campana: vivas.id, segmento: 'viejos' });
      leadManager.updateLead(r2.id, { estado: 'descartado', perfil: 'profesional' });
      activityLog.appendActivity(r2.id, 'message_received', { texto: 'No me interesa' });
      activityLog.appendActivity(r2.id, 'opt_out', {});
      const cand = scheduler.candidatosRepesca().map((l) => l.nombre);
      assert.ok(cand.includes('Remo') && !cand.includes('Baja'), 'quien se dio de baja no se repesca');
      for (const l of scheduler.candidatosRepesca()) leadManager.updateLead(l.id, { repesca: { estado: l.id === r1.id ? 'pendiente' : 'omitida' } });
      await scheduler.procesarRepesca();
      const m = paraTel('34622000013');
      assert.ok(m.length === 1 && m[0].plantilla === 'sesion_huecos_three' && /lunes 19/.test(m[0].params[1]), 'plantilla con los huecos reales');
      assert.strictEqual(leadManager.getLeadById(r1.id).estado, 'video_enviado', 'vuelve al embudo');
      await scheduler.procesarRepesca();
      assert.strictEqual(paraTel('34622000013').length, 1, 'una sola vez');
    } finally {
      cs.huecosTexto = huecosReal;
    }
    ok('repesca: huecos reales de la semana, solo a quien contestó y no se dio de baja, una vez');

    // d8) Derivación directa a Arkaitz: nunca en el primer intercambio; sí cuando da vueltas
    {
      const t0 = Date.now;
      const base = Date.now();
      try {
        const d = leadManager.createLead({ nombre: 'Dora', telefono: '34622000015', campana: vivas.id, segmento: 'viejos' });
        leadManager.updateLead(d.id, { estado: 'esperando_cualificacion' });
        await conversationFlow.handleIncoming('34622000015', 'quiero hablar con una persona');
        assert.ok(!/wa\.me/.test(paraTel('34622000015').slice(-1)[0].body), 'primer mensaje: aún no se le deriva');
        assert.ok(!leadManager.getLeadById(d.id).derivadoArkaitzAt);
        await conversationFlow.handleIncoming('34622000015', 'Busco ingresos extra');
        assert.ok(/\/r\/grupal\?l=/.test(paraTel('34622000015').slice(-1)[0].body), 'cualifica → sesión primero');
        Date.now = () => base + 7 * 3600 * 1000;
        await conversationFlow.handleIncoming('34622000015', 'y esto de qué va exactamente?');
        Date.now = () => base + 14 * 3600 * 1000;
        await conversationFlow.handleIncoming('34622000015', 'sigo sin entenderlo');
        assert.ok(!leadManager.getLeadById(d.id).derivadoArkaitzAt, 'dos respuestas automáticas: todavía no');
        Date.now = () => base + 21 * 3600 * 1000;
        await conversationFlow.handleIncoming('34622000015', 'pero cómo funciona esto?');
        const ult = paraTel('34622000015').slice(-1)[0].body;
        assert.ok(/wa\.me\/34696272778/.test(ult) && /Hola%20Arkaitz/.test(ult) && /Dora/.test(decodeURIComponent(ult)), 'da vueltas sin abrir la presentación → WhatsApp directo de Arkaitz con su nombre');
        assert.ok(leadManager.getLeadById(d.id).derivadoArkaitzAt, 'derivada');
        Date.now = () => base + 28 * 3600 * 1000;
        const n = paraTel('34622000015').length;
        await conversationFlow.handleIncoming('34622000015', 'hola?');
        assert.ok(!/wa\.me/.test((paraTel('34622000015').slice(-1)[0] || {}).body || '') || paraTel('34622000015').length === n, 'no se deriva dos veces');
      } finally {
        Date.now = t0;
      }
      ok('derivación a Arkaitz: no en el primer mensaje; sí tras dar vueltas sin abrir la presentación; una sola vez');
    }

    // d8b) Seguimiento: "no la he visto" no cuenta; riesgo y pasos
    {
      const S = require('../services/sesiones');
      const f = leadManager.createLead({ nombre: 'Fran', telefono: '34622000018', campana: vivas.id, segmento: 'viejos' });
      const ini = new Date(Date.now() + 30 * 3600 * 1000).toISOString();
      leadManager.updateLead(f.id, { estado: 'reunion_registrado', perfil: 'emprendedor', esperandoFeedback: true,
        sesion: { inviteeUri: 'inv-f', inicio: ini, estado: 'reservada', reservadaAt: new Date(Date.now() - 3600 * 1000).toISOString(), avisos: {} } });
      await conversationFlow.handleIncoming('34622000018', 'Que no he visto nada');
      assert.ok(!leadManager.getLeadById(f.id).sesion.formado, '«no he visto nada» no la marca como vista');
      assert.ok(/presentación/.test(paraTel('34622000018').slice(-1)[0].body), 'se le reenvía la presentación');
      activityLog.appendActivity(f.id, 'sesion_cambiar_dia', { texto: 'Cambiar de día' });
      const sg = S.seguimiento(leadManager.getLeadById(f.id), activityLog.getActivityByLead(f.id), Date.now());
      assert.strictEqual(sg.riesgo, 'alto', 'pidió cambiar de día y no cambió → riesgo alto');
      assert.ok(sg.motivos.some((m) => /cambiar de día/.test(m)) && sg.motivos.some((m) => /presentación/.test(m)));
      assert.ok(sg.pasos.find((p) => p.clave === 'presentacion').estado === 'pendiente');
      assert.ok(sg.conversacion.some((c) => c.de === 'lead' && /no he visto/.test(c.texto)));
      ok('seguimiento: «no la he visto» no desbloquea; riesgo alto si pidió cambiar de día; pasos y conversación');
      // Doble reserva del mismo hueco: no alterna ni reinicia avisos
      const cs2 = require('../services/calendlySync');
      await cs2.registrarReserva(leadManager.getLeadById(f.id), { inviteeUri: 'inv-f2', eventoUri: 'ev', inicio: ini, joinUrl: 'https://zoom.us/j/1' });
      const tras = leadManager.getLeadById(f.id).sesion;
      assert.strictEqual(tras.inviteeUri, 'inv-f', 'el segundo invitado del mismo hueco no sustituye al primero');
      ok('doble reserva del mismo hueco: se ignora (sin alternar ni reiniciar avisos)');
      // Sesión ya celebrada: la sync no la vuelve a registrar (Ricardo, 28-10)
      const g = leadManager.createLead({ nombre: 'Gus', telefono: '34622000019', campana: vivas.id, segmento: 'viejos' });
      const pasado = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
      leadManager.updateLead(g.id, { estado: 'reunion_registrado', sesion: { inviteeUri: 'inv-g', inicio: pasado, estado: 'celebrada', avisos: {} } });
      const nueva = await cs2.registrarReserva(leadManager.getLeadById(g.id), { inviteeUri: 'inv-g', eventoUri: 'ev', inicio: pasado });
      assert.strictEqual(nueva, false); assert.strictEqual(leadManager.getLeadById(g.id).sesion.estado, 'celebrada', 'sigue celebrada');
      ok('una sesión ya celebrada no se vuelve a registrar como reserva nueva');
      // Aviso a Arkaitz por cada reserva nueva (plantilla de utilidad)
      config.whatsapp.templateAvisoReserva = 'aviso_reserva_three';
      const t = leadManager.createLead({ nombre: 'Txelo', telefono: '34622000020', campana: vivas.id, segmento: 'viejos' });
      await cs2.registrarReserva(leadManager.getLeadById(t.id), { inviteeUri: 'inv-t', eventoUri: 'ev', inicio: new Date(Date.now() + 26 * 3600 * 1000).toISOString() });
      const av = paraTel('34696272778').slice(-1)[0];
      assert.ok(av && av.plantilla === 'aviso_reserva_three' && av.params[0] === 'Txelo' && av.params[2] === '+34622000020', 'Arkaitz recibe el aviso con nombre y teléfono');
      ok('aviso a Arkaitz por cada reserva nueva');
    }

    // d9) La presentación es la llave del Zoom
    {
      const t0 = Date.now;
      const messaging = require('../services/messaging');
      const ventanaReal = messaging.dentroDeVentana;
      try {
        const z = leadManager.createLead({ nombre: 'Zoe', telefono: '34622000016', campana: vivas.id, segmento: 'viejos' });
        const inicio = new Date(Date.now() + 60 * 60 * 1000);
        // la sesión cae en horario (08–22 Madrid): si no, la movemos al mediodía siguiente
        const hMad = parseInt(inicio.toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }), 10);
        if (hMad < 9 || hMad >= 21) inicio.setUTCDate(inicio.getUTCDate() + 1), inicio.setUTCHours(10, 0, 0, 0);
        const ahora = inicio.getTime() - 60 * 60 * 1000;
        Date.now = () => ahora;
        leadManager.updateLead(z.id, { estado: 'reunion_registrado', perfil: 'emprendedor', sesion: { inviteeUri: 'inv-z', inicio: inicio.toISOString(), joinUrl: 'https://us06web.zoom.us/j/999?pwd=abc', estado: 'reservada', reservadaAt: new Date(ahora - 48 * 3600 * 1000).toISOString(), confirmada: true, avisos: { preparacion: 2, hoy: 'x' } } });
        messaging.dentroDeVentana = () => true;
        await scheduler.procesarSesiones();
        const m1 = paraTel('34622000016').slice(-1)[0];
        assert.ok(m1 && /llave/.test(m1.body) && !/zoom\.us/.test(m1.body), 'una hora antes SIN ver la presentación: la llave, no el Zoom');
        assert.ok(!leadManager.getLeadById(z.id).sesion.avisos.zoomEnviado);
        // Termina el vídeo en la landing → el Zoom sale al momento
        activityLog.appendActivity(z.id, 'video_complete', { videoId: 'videoVsl' });
        await conversationFlow.presentacionCompletada(leadManager.getLeadById(z.id), 'landing');
        const m2 = paraTel('34622000016').slice(-1)[0];
        assert.ok(/zoom\.us\/j\/999/.test(m2.body), 'al terminar la presentación → Zoom');
        assert.ok(leadManager.getLeadById(z.id).sesion.formado && leadManager.getLeadById(z.id).sesion.avisos.zoomEnviado);
        // Fuera de ventana, el Zoom va con la plantilla de botón (sufijo del enlace)
        const z2 = leadManager.createLead({ nombre: 'Zac', telefono: '34622000017', campana: vivas.id, segmento: 'viejos' });
        leadManager.updateLead(z2.id, { estado: 'reunion_registrado', perfil: 'emprendedor', sesion: { inviteeUri: 'inv-z2', inicio: inicio.toISOString(), joinUrl: 'https://us06web.zoom.us/j/777?pwd=k', estado: 'reservada', reservadaAt: new Date(ahora - 48 * 3600 * 1000).toISOString(), avisos: {} } });
        messaging.dentroDeVentana = () => false;
        config.whatsapp.templateSesionZoom = 'sesion_zoom_three';
        await conversationFlow.enviarZoom(leadManager.getLeadById(z2.id), 'test');
        const m3 = paraTel('34622000017').slice(-1)[0];
        assert.ok(m3.plantilla === 'sesion_zoom_three', 'fuera de ventana: plantilla con botón de enlace');
      } finally {
        Date.now = t0;
        messaging.dentroDeVentana = ventanaReal;
      }
      ok('la presentación es la llave: sin verla no hay Zoom; al terminarla llega al momento; fuera de ventana, plantilla con botón');
    }

    // e) Freno de emergencia: error de cuenta de Meta → nada sale hasta reanudar
    scheduler.bloquearEnvios(131042, 'Business eligibility payment issue');
    const n1 = enviados.length;
    activationReset();
    await scheduler.ejecutarCiclo();
    assert.strictEqual(enviados.length, n1, 'con el freno puesto no sale nada');
    assert.ok(scheduler.getBloqueo() && /pago/.test(scheduler.getBloqueo().motivo));
    scheduler.desbloquearEnvios();
    assert.strictEqual(scheduler.getBloqueo(), null);
    ok('freno de emergencia: un error de pago/bloqueo de Meta para todos los envíos hasta reanudar');
  }

  // ── 7. Textos ─────────────────────────────────────────────────
  const messages = require('../templates/messages');
  const tVer = messages.mensajeReactivacion({ nombre: 'MAVI', segmento: 'verano' });
  assert.ok(tVer.startsWith('¡Hola, MAVI! 👋 Soy del equipo de Three Inmobiliaria.') && /julio y agosto/.test(tVer));
  const tSin = messages.mensajeReactivacion({ nombre: 'Sin nombre', segmento: 'directo' });
  assert.ok(tSin.startsWith('¡Hola! 👋'), 'sin nombre no sale "¡Hola, Sin nombre!"');
  for (const seg of ['verano', 'septiembre', 'directo']) {
    assert.ok(messages.PLANTILLAS_META[seg].cuerpo.includes('{{nombre}}'));
  }
  for (const b of messages.PLANTILLAS_META.botones) assert.ok(b.length <= 25, `botón "${b}" supera 25 caracteres`);
  assert.strictEqual(conversationFlow.interpretarRespuesta('Soy agente inmobiliario'), 'profesional');
  assert.strictEqual(conversationFlow.interpretarRespuesta('Busco ingresos extra'), 'emprendedor');
  ok('textos por segmento y botones de plantilla (≤25 caracteres) reconocidos por el flujo');

  // ── 8. Router de decisión (sin IA: reglas) ────────────────────
  {
    const tel = '34633000001';
    const de = () => paraTel(tel).length;
    await conversationFlow.handleIncoming(tel, 'ei', { nombre: 'Router', canal: 'whatsapp' });
    assert.strictEqual(de(), 1, '"ei" de un desconocido → bienvenida');
    await conversationFlow.handleIncoming(tel, 'hola');
    assert.strictEqual(de(), 1, '"hola" que se cruza con la bienvenida → nada (antes: "Perdona, igual no me he explicado bien")');
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000; // 10 min después
    await conversationFlow.handleIncoming(tel, 'hola');
    assert.strictEqual(de(), 1, 'un saludo con la pregunta 1/2 en pantalla no se contesta');
    await conversationFlow.handleIncoming(tel, 'y esto de qué va');
    assert.strictEqual(de(), 2, 'una duda → se re-pregunta 1/2');
    assert.ok(/1 → si trabajas/.test(paraTel(tel)[1].body));
    Date.now = realNow;
    await conversationFlow.handleIncoming(tel, '1');
    assert.strictEqual(de(), 3, '"1" → landing');
    await conversationFlow.handleIncoming(tel, 'dale bro');
    assert.strictEqual(de(), 4, '"dale bro" tras la landing → respuesta (antes: "escribiendo…" y nada)');
    assert.ok(/\/r\/grupal\?l=/.test(paraTel(tel)[3].body) && /sesión de dudas/.test(paraTel(tel)[3].body), 'le invita a reservar la sesión con el enlace de Calendly');
    await conversationFlow.handleIncoming(tel, 'ok');
    assert.strictEqual(de(), 4, 'no se repite la respuesta automática una y otra vez');
    await conversationFlow.handleIncoming(tel, 'prefiero hablar con alguien, llámame');
    assert.strictEqual(de(), 5, 'pide una persona → aviso');
    assert.ok(/wa\.me\/34696272778\?text=/.test(paraTel(tel)[4].body) && !/te escribe/.test(paraTel(tel)[4].body), 'pide persona → WhatsApp directo de Arkaitz con el mensaje escrito');
    assert.ok(leadManager.getLeadByPhone(tel).derivadoArkaitzAt && leadManager.getLeadByPhone(tel).pideHumanoAt, 'queda marcado como derivado');
    ok('router: no contesta saludos cruzados, responde "dale" tras la landing, no repite, pide persona → WhatsApp de Arkaitz');
  }

  // ── 9. Incidencias para la zona de desarrollador (cálculo puro) ──
  {
    const incidencias = require('../services/incidencias');
    const base = Date.parse('2026-10-17T10:00:00Z');
    const ts = (min) => new Date(base + min * 60000).toISOString();
    const L = [{ id: 'i1', nombre: 'Inc', telefono: '34600000001', estado: 'video_enviado' },
      { id: 'i2', nombre: 'Desc', telefono: '34600000002', estado: 'descartado' }];
    const ev = [
      { ts: ts(0), leadId: 'i1', type: 'message_sent', meta: { preview: '¡Genial! Aquí tienes la presentación: https://x.pages.dev/?l=1', ok: true } },
      { ts: ts(2), leadId: 'i1', type: 'message_sent', meta: { preview: '¡¡Genial!! Aquí tienes la presentación 👉 https://x.pages.dev/?l=1', ok: true } },
      { ts: ts(5), leadId: 'i1', type: 'message_sent', meta: { preview: 'Hola', ok: false, code: 131047, error: 'Re-engagement message' } },
      { ts: ts(10), leadId: 'i1', type: 'pide_humano', meta: { texto: 'quiero hablar con una persona' } },
      { ts: ts(20), leadId: 'i1', type: 'message_received', meta: { texto: '¿y cuánto cuesta?' } },
      { ts: ts(0), leadId: 'i2', type: 'message_sent', meta: { preview: '[plantilla recordatorio_presentacion_three]', ok: true } },
      { ts: ts(5), leadId: 'i2', type: 'state_changed', meta: { from: 'video_enviado', to: 'descartado' } },
    ];
    const r = incidencias.calcular(ev, L, { desde: base - 3600000, ahora: base + 120 * 60000 });
    const tipos = r.map((i) => i.tipo).sort();
    assert.deepStrictEqual(tipos, ['descarte_tras_recordatorio', 'duplicado', 'error_envio', 'landing_doble', 'pide_humano', 'sin_respuesta']);
    assert.ok(new Date(r[0].ts) >= new Date(r[r.length - 1].ts), 'más recientes primero');
    assert.ok(!incidencias.casiIguales('Hola, ¿qué tal?', 'Te paso el enlace de la sesión de dudas'));
    const clave = r.find((i) => i.tipo === 'duplicado').clave;
    incidencias.marcarResuelta(clave);
    assert.ok(incidencias.leerResueltas()[clave], 'la incidencia queda marcada como resuelta');
    ok('incidencias: duplicado, landing doble, descarte tras recordatorio, pide persona, error de envío y sin respuesta');
  }

  // ── 10. Panel "Sesiones de dudas" del CRM (cálculo puro) ──
  {
    const sesiones = require('../services/sesiones');
    const ahora = Date.parse('2026-10-23T12:00:00Z');
    const h = (n) => new Date(ahora + n * 3600000).toISOString();
    const L = [
      { id: 's1', nombre: 'Zoe', telefono: '34600000011', perfil: 'emprendedor', estado: 'reunion_registrado', derivadoArkaitzAt: h(-5),
        feedbackSesion: [{ texto: '¿Cómo se cobran las comisiones?', ts: h(-20) }],
        sesion: { inicio: h(48), fin: h(48.5), joinUrl: 'https://zoom.us/j/1', estado: 'reservada', confirmada: true, formado: true, avisos: { preparacion: 1, hoy: h(-1), zoomEnviado: null } } },
      { id: 's2', nombre: 'Ana', telefono: '34600000012', perfil: 'profesional', estado: 'reunion_registrado', sesion: { inicio: h(48), estado: 'reservada', confirmada: false, avisos: {} } },
      { id: 's7', nombre: 'Carla', estado: 'video_visto', sesion: { inicio: h(48), estado: 'cancelada', avisos: {} } },
      { id: 's3', nombre: 'Luis', estado: 'reunion_asistio', sesion: { inicio: h(-30), estado: 'celebrada', avisos: {} } },
      { id: 's4', nombre: 'Marta', estado: 'reunion_registrado', sesion: { inicio: h(-30), estado: 'celebrada', asistio: false, noAsistioMarcadoAt: h(-28), avisos: {} } },
      { id: 's5', nombre: 'Viejo', estado: 'reunion_registrado', sesion: { inicio: h(-50 * 24), estado: 'celebrada', avisos: {} } },
      { id: 's6', nombre: 'Sin sesión', estado: 'video_enviado' },
    ];
    const r = sesiones.listar(L, ahora);
    assert.strictEqual(r.sesiones.length, 2, 'misma hora = misma sesión; fuera de −45/+45 días no entra');
    assert.ok(r.sesiones[0].pasada && !r.sesiones[1].pasada, 'ascendente por hora: la pasada primero');
    const prox = r.sesiones[1];
    assert.deepStrictEqual(prox.asistentes.map((a) => a.nombre), ['Ana', 'Carla', 'Zoe'], 'asistentes por nombre');
    assert.strictEqual(prox.joinUrl, 'https://zoom.us/j/1');
    assert.ok(/octubre a las/.test(prox.cuando), 'cuándo en palabras');
    const zoe = prox.asistentes.find((a) => a.nombre === 'Zoe');
    assert.ok(zoe.confirmada && zoe.formado && zoe.derivado && zoe.asistio === null && zoe.avisos.hoy === h(-1));
    assert.deepStrictEqual(zoe.dudas, ['¿Cómo se cobran las comisiones?'], 'las dudas para Arkaitz van en la fila');
    assert.strictEqual(prox.asistentes.find((a) => a.nombre === 'Carla').estadoSesion, 'cancelada');
    const pas = r.sesiones[0];
    assert.strictEqual(pas.asistentes.find((a) => a.nombre === 'Luis').asistio, true, 'reunion_asistio cuenta como asistió');
    assert.strictEqual(pas.asistentes.find((a) => a.nombre === 'Marta').asistio, false, 'lo marcado desde el CRM manda');
    // Pestañas (reunión 30-10): Carla canceló y Marta faltó → no presentados; Luis vino
    assert.deepStrictEqual(r.resumen, { proximas: 1, reservados: 2, confirmados: 1, formados: 1, asistieronUltimos14d: 1, noAsistieronUltimos14d: 1,
      pestanas: { agendados: 2, nopresentados: 2, descartados: 0, vinieron: 1, porLlamar: 2 } });
    ok('panel de sesiones: agrupa por hora, ordena, lee confirmación/presentación/dudas y resume la asistencia');

    // Descarte SOLO a mano: un no presentado descartado por el equipo pasa a «descartados»
    const conDescarte = L.map((l) => (l.id === 's4' ? { ...l, seguimientoSesion: { descartado: { ts: h(-1), motivo: 'no le interesa' } } } : l));
    const r2 = sesiones.listar(conDescarte, ahora);
    assert.strictEqual(r2.resumen.pestanas.descartados, 1); assert.strictEqual(r2.resumen.pestanas.nopresentados, 1);
    ok('pestañas: agendados / no presentados / descartados (solo a mano) / vinieron');
  }

  console.log(`\n🎉 Todo correcto (${paso} comprobaciones, ${enviados.length} mensajes simulados, 0 reales).\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ FALLO:', err && err.stack ? err.stack : err);
  process.exit(1);
});
