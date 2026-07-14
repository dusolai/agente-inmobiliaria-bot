/**
 * Diagnóstico del número de WhatsApp en Meta — SOLO LECTURA.
 * Pregunta a la Graph API por la calidad y el estado del número. Sirve para
 * saber si Meta está PENALIZANDO el número (por eso "acepta" pero no entrega).
 *
 * Uso (PowerShell, desde la carpeta del bot):
 *   $env:WHATSAPP_PHONE_NUMBER_ID = "<tu Phone number ID>"
 *   $env:WHATSAPP_ACCESS_TOKEN    = "<tu token permanente>"
 *   node scripts/check-whatsapp.js
 *
 * (Son los mismos valores que tienes en las variables de Seenode.)
 */

const axios = require('axios');

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VER = process.env.WHATSAPP_API_VERSION || 'v21.0';

if (!PHONE_ID || !TOKEN) {
  console.error('❌ Faltan variables. Ejecuta antes:');
  console.error('   $env:WHATSAPP_PHONE_NUMBER_ID = "..."');
  console.error('   $env:WHATSAPP_ACCESS_TOKEN = "..."');
  process.exit(1);
}

const CALIDAD = {
  GREEN: '🟢 VERDE (buena) — entrega normal',
  YELLOW: '🟡 AMARILLA (media) — Meta empieza a vigilar; baja el ritmo',
  RED: '🔴 ROJA (mala) — Meta ESTÁ LIMITANDO la entrega; hay que parar y dejar descansar el número',
  UNKNOWN: '⚪ desconocida (aún sin datos suficientes)',
};

(async () => {
  try {
    const fields = 'verified_name,display_phone_number,quality_rating,messaging_limit_tier,throughput,code_verification_status,name_status,status,platform_type';
    const url = `https://graph.facebook.com/${VER}/${PHONE_ID}?fields=${fields}&access_token=${encodeURIComponent(TOKEN)}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    console.log('\n══════ NÚMERO DE WHATSAPP ══════');
    console.log('Número:        ', data.display_phone_number || '?', '·', data.verified_name || '(sin nombre verificado)');
    console.log('Estado (status):', data.status || '?');
    console.log('Nombre:        ', data.name_status || '?');
    console.log('Verificación:  ', data.code_verification_status || '?');
    console.log('Plataforma:    ', data.platform_type || '?');

    console.log('\n══════ CALIDAD Y LÍMITES ══════');
    console.log('CALIDAD:       ', CALIDAD[data.quality_rating] || data.quality_rating || '?');
    console.log('Límite mensajería:', data.messaging_limit_tier || '?',
      '(TIER_250 = 250/24h sin verificar negocio · TIER_1K = 1.000 · TIER_10K = 10.000)');
    if (data.throughput) console.log('Rendimiento:   ', JSON.stringify(data.throughput));

    // ─── Estadísticas de entrega (enviados vs entregados) ────────────
    // Responde a "de los YA enviados, ¿cuántos entregó Meta de verdad?".
    // Necesita el WABA ID (WhatsApp Business Account) — el mismo del panel de Meta.
    const WABA = process.env.WHATSAPP_WABA_ID;
    if (WABA) {
      try {
        const fin = Math.floor(Date.now() / 1000);
        const ini = fin - 3 * 24 * 3600; // últimos 3 días
        const aUrl = `https://graph.facebook.com/${VER}/${WABA}?fields=analytics.start(${ini}).end(${fin}).granularity(DAY)&access_token=${encodeURIComponent(TOKEN)}`;
        const { data: a } = await axios.get(aUrl, { timeout: 15000 });
        const puntos = (a.analytics && a.analytics.data_points) || [];
        console.log('\n══════ ENTREGA REAL (últimos 3 días, dato de Meta) ══════');
        if (!puntos.length) console.log('(Meta aún no ha calculado estadísticas para este periodo)');
        let tSent = 0, tDel = 0;
        for (const p of puntos) {
          const dia = new Date(p.start * 1000).toISOString().slice(0, 10);
          const pct = p.sent ? Math.round((p.delivered / p.sent) * 100) : 0;
          console.log(`  ${dia}:  enviados ${p.sent}  →  entregados ${p.delivered}  (${pct}%)`);
          tSent += p.sent; tDel += p.delivered;
        }
        if (tSent) {
          const pctT = Math.round((tDel / tSent) * 100);
          console.log(`  ─────`);
          console.log(`  TOTAL: ${tDel}/${tSent} entregados (${pctT}%)`);
          if (pctT < 80) console.log(`  ⚠️  Entrega BAJA (${pctT}%) — Meta está reteniendo mensajes. Señal de número tocado.`);
          else console.log(`  ✅ Entrega buena (${pctT}%) — los mensajes SÍ llegan.`);
        }
      } catch (e) {
        const me = e.response && e.response.data && e.response.data.error;
        console.log('\n(No pude leer estadísticas de entrega:', me ? me.message : e.message, ')');
      }
    } else {
      console.log('\n(ℹ️  Para ver "enviados vs entregados" añade también:  $env:WHATSAPP_WABA_ID = "2032370564048199")');
    }

    console.log('\n══════ VEREDICTO ══════');
    if (data.quality_rating === 'RED') {
      console.log('🔴 El número está PENALIZADO. Meta acepta los mensajes pero NO los entrega bien.');
      console.log('   → PARA los envíos (ritmo 0 en el CRM), deja el número descansar 24-48h, y');
      console.log('     cuando vuelva a VERDE reanuda MUY despacio (5/día). Manda solo a quien');
      console.log('     probablemente responda; los "no entregados" hunden más la calidad.');
    } else if (data.quality_rating === 'YELLOW') {
      console.log('🟡 Calidad en amarillo: Meta te vigila. Baja el ritmo (5/día) y vigila las respuestas.');
    } else if (data.quality_rating === 'GREEN') {
      console.log('🟢 Calidad buena. Si aun así no llega, el problema es otro (ventana 24h / número del destinatario).');
      console.log('   Revisa en el CRM el acuse real de cada mensaje (entregado / NO llegó).');
    } else {
      console.log('⚪ Sin calificación aún. Manda pocos y vigila.');
    }
    console.log('');
  } catch (err) {
    const meta = err.response && err.response.data && err.response.data.error;
    if (meta) {
      console.error('\n❌ Meta devolvió error:', meta.code, meta.message);
      if (meta.code === 190) console.error('   → El TOKEN no es válido o ha caducado. Genera uno permanente nuevo en Meta.');
      if (meta.code === 100) console.error('   → El Phone number ID puede ser incorrecto.');
    } else {
      console.error('\n❌ No se pudo consultar:', err.message);
    }
    process.exit(1);
  }
})();
