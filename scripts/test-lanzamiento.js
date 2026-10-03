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

function activationReset() {
  const f = path.join(tmp, 'activation.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) {}
  st.ultimaActivacion = null;
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
}

(async () => {
  console.log(`\n🧪 Prueba del lanzamiento (datos en ${tmp})\n`);

  // ── 1. Campañas ───────────────────────────────────────────────
  assert.strictEqual(campanas.getActiva(), campanas.CAMPANA_LEGADO);
  const ana = leadManager.createLead({ nombre: 'Ana Legado', telefono: '34600000001', fuente: 'excel_import' });
  leadManager.transitionState(ana.id, leadManager.LEAD_STATES.ESPERANDO_CUALIFICACION);
  leadManager.updateLead(ana.id, { recordatorios: { ...ana.recordatorios, fase1: { enviados: 1, ultimoEnvio: '2026-09-20T10:00:00.000Z' } } });
  const luis = leadManager.createLead({ nombre: 'Luis Baja', telefono: '34600000002', fuente: 'excel_import' });
  activityLog.appendActivity(luis.id, 'opt_out', { texto: 'no me interesa' });
  leadManager.updateLead(luis.id, { estado: 'descartado' });
  assert.strictEqual(leadManager.getLeadById(ana.id).campana, campanas.CAMPANA_LEGADO);
  ok('leads antiguos quedan en la campaña legado "prueba_sep26"');

  const nueva = campanas.crear({ nombre: 'Lanzamiento octubre 2026' });
  assert.strictEqual(campanas.getActiva(), nueva.id);
  assert.strictEqual(nueva.id, 'lanzamiento_octubre_2026');
  const legado = campanas.get(campanas.CAMPANA_LEGADO);
  assert.ok(legado.archivadaEn, 'la campaña anterior debe quedar archivada');
  ok(`nueva campaña "${nueva.nombre}" (${nueva.id}) activa; la anterior archivada`);

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
      fila('l:10', '2026-04-01T10:00:00-05:00', 'Ana Legado', 'p:+34600000001', 'ana@x.com'), // ya contactada en la campaña anterior
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

  const r1 = importador.importar(proc.validos, { fuente: 'excel_import' });
  console.log(`  import → ${JSON.stringify(r1)}`);
  if (!csvReal) {
    assert.strictEqual(r1.creados, 8);
    assert.strictEqual(r1.excluidosBaja, 1, 'Luis Baja no se vuelve a crear');
    assert.strictEqual(r1.repetidosDeOtraCampana, 1, 'Ana Legado se crea marcada');
    const ana2 = leadManager.getLeadByPhone('34600000001');
    assert.strictEqual(ana2.campana, nueva.id, 'getLeadByPhone prefiere el lead de la campaña activa');
    assert.strictEqual(ana2.contactadoAntesEn, campanas.CAMPANA_LEGADO);
    assert.strictEqual(leadManager.getLeadByPhone('34611000007').segmento, 'septiembre');
    assert.strictEqual(leadManager.getLeadByPhone('34611000007').fechaLead.slice(0, 10), '2026-10-02');
  }
  const r2 = importador.importar(proc.validos, { fuente: 'excel_import' });
  assert.strictEqual(r2.creados, 0);
  assert.strictEqual(r2.duplicados, r1.creados, 'reimportar no duplica');
  ok('importador: crea en la campaña activa, excluye bajas, marca repetidos, no duplica');

  assert.strictEqual(leadManager.getStats({ campana: 'activa' }).total, r1.creados);
  assert.strictEqual(leadManager.getStats({ campana: 'todas' }).total, r1.creados + 2);
  ok('stats filtran por campaña (activa vs todas)');

  // ── 3. Activación por turnos ──────────────────────────────────
  if (!csvReal) {
    const antes = enviados.length;
    const orden = [];
    for (let i = 0; i < 6; i++) {
      activationReset();
      await scheduler.procesarActivacionDiaria();
      const ultimo = enviados[enviados.length - 1];
      const lead = leadManager.getLeadByPhone(ultimo.to);
      orden.push(`${lead.segmento}:${ultimo.plantilla}`);
    }
    console.log(`  orden de activación → ${orden.join(' · ')}`);
    assert.strictEqual(enviados.length - antes, 6);
    assert.deepStrictEqual(orden.slice(0, 3).map((s) => s.split(':')[0]).sort(), ['septiembre', 'verano', 'viejos'], 'las tres listas avanzan a la vez');
    assert.ok(orden.includes('verano:reactivacion_verano') && orden.includes('septiembre:reactivacion_septiembre') && orden.includes('viejos:reactivacion_leads'), 'cada segmento usa su plantilla');
    assert.ok(orden.every((o) => o.split(':')[0] !== 'directo'));
    ok('activación por turnos viejos → verano → septiembre, cada uno con su plantilla');

    scheduler.setSegmentoPausado('viejos', true);
    activationReset();
    await scheduler.procesarActivacionDiaria();
    const l = leadManager.getLeadByPhone(enviados[enviados.length - 1].to);
    assert.notStrictEqual(l.segmento, 'viejos', 'un segmento en pausa no se activa');
    scheduler.setSegmentoPausado('viejos', false);
    ok('pausar un segmento desde el CRM lo deja en cola');

    // Sin plantilla para "directo": el lead espera en cola
    config.whatsapp.templatesPorSegmento.directo = '';
    const dir = leadManager.createLead({ nombre: 'Directa Nocturna', telefono: '34611000099', fuente: 'meta_sheet', segmento: 'directo' });
    const n0 = enviados.length;
    activationReset();
    await scheduler.procesarActivacionDiaria();
    assert.notStrictEqual(enviados[enviados.length - 1].to, '34611000099', 'sin plantilla, el directo no sale');
    config.whatsapp.templatesPorSegmento.directo = 'bienvenida_directo';
    activationReset();
    await scheduler.procesarActivacionDiaria();
    assert.strictEqual(enviados[enviados.length - 1].to, '34611000099', 'con plantilla, el directo va el primero');
    assert.strictEqual(enviados[enviados.length - 1].plantilla, 'bienvenida_directo');
    assert.strictEqual(leadManager.getLeadById(dir.id).estado, 'esperando_cualificacion');
    assert.ok(enviados.length - n0 === 2);
    ok('un lead "directo" espera si falta su plantilla y sale el primero en cuanto la tiene');
  }

  // ── 4. Alta automática por WhatsApp ───────────────────────────
  await conversationFlow.handleIncoming('34611222333', 'Hola, vi vuestro anuncio', { nombre: 'Pepe Perfil', canal: 'whatsapp' });
  const pepe = leadManager.getLeadByPhone('34611222333');
  assert.ok(pepe, 'se crea el lead');
  assert.strictEqual(pepe.segmento, 'directo');
  assert.strictEqual(pepe.fuente, 'whatsapp_entrante');
  assert.strictEqual(pepe.campana, nueva.id);
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

  console.log(`\n🎉 Todo correcto (${paso} comprobaciones, ${enviados.length} mensajes simulados, 0 reales).\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ FALLO:', err && err.stack ? err.stack : err);
  process.exit(1);
});
