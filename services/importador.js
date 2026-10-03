const leadManager = require('./leadManager');
const activityLog = require('./activityLog');
const campanas = require('./campanas');
const metaLeads = require('./metaLeads');

/**
 * Alta en lote de leads en la campaña ACTIVA (import del CRM, bulk-import,
 * lector de la hoja de Google).
 *
 * Reglas:
 *  - mismo teléfono ya en la MISMA campaña          → duplicado, se salta
 *  - teléfono que pidió la BAJA o no tiene WhatsApp
 *    (en cualquier campaña)                         → excluido (no se le vuelve
 *    a escribir: una denuncia de spam hunde la calidad del número)
 *  - teléfono contactado en una campaña ANTERIOR    → se crea igualmente, pero
 *    queda marcado (`contactadoAntesEn`) para verlo en el CRM
 *
 * Cada fila: { nombre, telefono, email?, segmento?, fechaLead?, metaLeadId?,
 * respuestas? }. Si no trae segmento se deduce de fechaLead (o se usa
 * opts.segmentoPorDefecto, o 'viejos').
 *
 * opts: { campana, fuente, segmentoPorDefecto, creados: [] (se rellena) }
 */
function importar(filas, opts = {}) {
  const campana = opts.campana || campanas.getActiva();
  const r = {
    total: Array.isArray(filas) ? filas.length : 0,
    creados: 0,
    duplicados: 0,
    excluidosBaja: 0,
    repetidosDeOtraCampana: 0,
    errores: 0,
    porSegmento: {},
    campana,
  };
  if (!Array.isArray(filas) || !filas.length) return r;

  // Índice por teléfono de TODOS los leads (todas las campañas), una sola vez.
  const porTel = new Map();
  for (const l of leadManager.getAllLeads({ campana: 'todas' })) {
    const t = leadManager.normalizarTelefono(l.telefono);
    if (!porTel.has(t)) porTel.set(t, []);
    porTel.get(t).push(l);
  }
  const bajas = activityLog.getLeadsConBaja();

  for (const fila of filas) {
    try {
      const nombre = fila && String(fila.nombre || '').trim();
      const tel = leadManager.normalizarTelefono(fila && fila.telefono);
      if (!nombre || !metaLeads.esTelefonoPlausible(tel)) { r.errores++; continue; }

      const existentes = porTel.get(tel) || [];
      if (existentes.some((e) => (e.campana || campanas.CAMPANA_LEGADO) === campana)) { r.duplicados++; continue; }
      if (existentes.some((e) => bajas.has(e.id))) { r.excluidosBaja++; continue; }
      const anterior = existentes
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;

      const segmento = metaLeads.SEGMENTOS.includes(fila.segmento)
        ? fila.segmento
        : (metaLeads.segmentoPorFecha(fila.fechaLead) || opts.segmentoPorDefecto || 'viejos');

      const lead = leadManager.createLead({
        nombre,
        email: (fila.email || '').trim(),
        telefono: tel,
        fuente: opts.fuente || 'excel_import',
        campana,
        segmento,
        fechaLead: fila.fechaLead || null,
        metaLeadId: fila.metaLeadId || null,
        respuestas: fila.respuestas || null,
        contactadoAntesEn: anterior ? (anterior.campana || campanas.CAMPANA_LEGADO) : null,
      });
      if (anterior) r.repetidosDeOtraCampana++;
      porTel.set(tel, existentes.concat(lead));
      r.creados++;
      r.porSegmento[segmento] = (r.porSegmento[segmento] || 0) + 1;
      if (Array.isArray(opts.creados)) opts.creados.push(lead);
    } catch (e) {
      console.error('❌ [Importador] Error en fila:', e.message);
      r.errores++;
    }
  }
  return r;
}

module.exports = { importar };
