const leadManager = require('./leadManager');
const activityLog = require('./activityLog');
const campanas = require('./campanas');
const metaLeads = require('./metaLeads');

/**
 * Alta en lote de leads (import del CRM, bulk-import, lector de la hoja).
 *
 * Destino (opts.campana):
 *   - id de campaña  → todos a esa campaña
 *   - 'auto'         → cada lead a la campaña viva de SU segmento (viejos /
 *                      verano / septiembre / directo); si no existe se crea
 *                      activa (nombre por defecto + opts.sufijo)
 *   - sin indicar    → como 'auto' pero sin crear (cae en la campaña por defecto)
 *
 * Segmento del lead (decide su primer mensaje):
 *   - si la campaña destino tiene segmento → el de la campaña
 *   - si no → el de la fila, o por fecha del formulario, o opts.segmentoPorDefecto
 *
 * Reglas:
 *  - teléfono ya presente en una campaña VIVA (activa/pausada) → duplicado:
 *    no se le escribe dos veces a la vez desde dos campañas
 *  - teléfono que pidió la BAJA o no tiene WhatsApp (en cualquier campaña)
 *    → excluido
 *  - teléfono solo presente en campañas ARCHIVADAS → se crea, marcado
 *    (`contactadoAntesEn`)
 *
 * opts: { campana, sufijo, fuente, segmentoPorDefecto, creados: [] }
 */
function importar(filas, opts = {}) {
  const r = {
    total: Array.isArray(filas) ? filas.length : 0,
    creados: 0,
    duplicados: 0,
    excluidosBaja: 0,
    repetidosDeOtraCampana: 0,
    errores: 0,
    porSegmento: {},
    porCampana: {},
  };
  if (!Array.isArray(filas) || !filas.length) return r;

  const destinoFijo = opts.campana && opts.campana !== 'auto' ? campanas.get(opts.campana) : null;
  if (opts.campana && opts.campana !== 'auto' && !destinoFijo) {
    r.errores = r.total;
    r.error = `campaña no encontrada: ${opts.campana}`;
    return r;
  }

  // Índice por teléfono de TODOS los leads, una sola vez.
  const porTel = new Map();
  for (const l of leadManager.getAllLeads({ campana: 'todas' })) {
    const t = leadManager.normalizarTelefono(l.telefono);
    if (!porTel.has(t)) porTel.set(t, []);
    porTel.get(t).push(l);
  }
  const bajas = activityLog.getLeadsConBaja();
  const vivas = new Set(campanas.vivas());
  const cacheSeg = {};

  for (const fila of filas) {
    try {
      const nombre = fila && String(fila.nombre || '').trim();
      const tel = leadManager.normalizarTelefono(fila && fila.telefono);
      if (!nombre || !metaLeads.esTelefonoPlausible(tel)) { r.errores++; continue; }

      const segFila = metaLeads.SEGMENTOS.includes(fila.segmento)
        ? fila.segmento
        : (metaLeads.segmentoPorFecha(fila.fechaLead) || opts.segmentoPorDefecto || 'viejos');

      let campana;
      if (destinoFijo) {
        campana = destinoFijo;
      } else {
        if (!(segFila in cacheSeg)) {
          cacheSeg[segFila] = campanas.paraSegmento(segFila, { crear: opts.campana === 'auto' || segFila === 'directo', sufijo: opts.sufijo || '' });
        }
        campana = cacheSeg[segFila] || campanas.get(campanas.porDefecto(segFila));
      }
      vivas.add(campana.id);
      const segmento = campana.segmento || segFila;

      const existentes = porTel.get(tel) || [];
      if (existentes.some((e) => vivas.has(leadManager.campanaDe(e)))) { r.duplicados++; continue; }
      if (existentes.some((e) => bajas.has(e.id))) { r.excluidosBaja++; continue; }
      const anterior = existentes
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;

      const lead = leadManager.createLead({
        nombre,
        email: (fila.email || '').trim(),
        telefono: tel,
        fuente: opts.fuente || 'excel_import',
        campana: campana.id,
        segmento,
        fechaLead: fila.fechaLead || null,
        metaLeadId: fila.metaLeadId || null,
        respuestas: fila.respuestas || null,
        contactadoAntesEn: anterior ? leadManager.campanaDe(anterior) : null,
      });
      if (anterior) r.repetidosDeOtraCampana++;
      porTel.set(tel, existentes.concat(lead));
      r.creados++;
      r.porSegmento[segmento] = (r.porSegmento[segmento] || 0) + 1;
      r.porCampana[campana.id] = (r.porCampana[campana.id] || 0) + 1;
      if (Array.isArray(opts.creados)) opts.creados.push(lead);
    } catch (e) {
      console.error('❌ [Importador] Error en fila:', e.message);
      r.errores++;
    }
  }
  return r;
}

module.exports = { importar };
