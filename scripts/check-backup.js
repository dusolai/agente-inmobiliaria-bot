/**
 * Diagnóstico de la copia de seguridad en Postgres — SOLO LECTURA.
 * No modifica nada: mira qué hay en bot_backup (y bot_backup_hist si existe)
 * y te dice si los leads y el historial siguen ahí o no.
 *
 * Uso (PowerShell, desde la carpeta del bot):
 *   $env:DATABASE_URL = "<la cadena de conexión de Seenode>"
 *   node scripts/check-backup.js
 *
 * La cadena se construye con los parámetros del panel de la BD en Seenode:
 *   postgresql://USUARIO:CONTRASEÑA@HOST:PUERTO/BASE_DE_DATOS
 * (o copia el valor de DATABASE_URL de las variables de entorno de la app)
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('❌ Falta DATABASE_URL. Ejecuta antes:  $env:DATABASE_URL = "postgresql://usuario:contraseña@host:puerto/bd"');
  process.exit(1);
}

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error('❌ Falta el paquete pg. Ejecuta:  npm install  (en la carpeta del bot)');
  process.exit(1);
}

function resumen(kind, data) {
  const v = typeof data === 'string' ? JSON.parse(data) : data;
  if (Array.isArray(v)) {
    if (kind === 'leads') {
      const nombres = v.slice(0, 5).map((l) => `${l.nombre} [${l.estado}]`).join(' · ');
      return `${v.length} leads ${v.length ? '→ ' + nombres + (v.length > 5 ? ' …' : '') : ''}`;
    }
    return `${v.length} eventos`;
  }
  if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 120);
  return String(v).slice(0, 120);
}

(async () => {
  // Primero sin SSL; si el servidor lo exige, reintentamos con SSL.
  for (const ssl of [undefined, { rejectUnauthorized: false }]) {
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000, ssl });
    try {
      const res = await pool.query('SELECT kind, updated_at, data FROM bot_backup ORDER BY kind');
      console.log('\n══════ FOTO VIVA (bot_backup) ══════');
      if (res.rows.length === 0) console.log('(vacía — no hay ninguna fila)');
      for (const r of res.rows) {
        console.log(`\n▸ ${r.kind}  (última copia: ${new Date(r.updated_at).toLocaleString()})`);
        console.log(`  ${resumen(r.kind, r.data)}`);
      }

      // Historial versionado (solo existe si ya corrió el código nuevo)
      try {
        const hist = await pool.query(
          `SELECT kind, created_at,
                  CASE WHEN jsonb_typeof(data)='array' THEN jsonb_array_length(data) ELSE NULL END AS n
           FROM bot_backup_hist ORDER BY created_at DESC LIMIT 30`
        );
        console.log('\n══════ HISTORIAL (bot_backup_hist) ══════');
        if (hist.rows.length === 0) console.log('(sin copias todavía)');
        for (const r of hist.rows) {
          console.log(`▸ ${r.kind}  ${new Date(r.created_at).toLocaleString()}  ${r.n !== null ? r.n + ' elementos' : ''}`);
        }
      } catch (e) {
        console.log('\n(bot_backup_hist aún no existe — normal si el código nuevo no ha arrancado)');
      }

      console.log('\n══════ VEREDICTO ══════');
      const leads = res.rows.find((r) => r.kind === 'leads');
      const nLeads = leads ? (Array.isArray(leads.data) ? leads.data.length : JSON.parse(leads.data).length) : 0;
      if (nLeads > 0) {
        console.log(`✅ HAY ${nLeads} LEADS EN LA COPIA. Recuperación: despliega el último commit de la app y reiníciala — al arrancar lo restaura todo.`);
      } else {
        console.log('❌ La copia de leads está vacía (se sobreescribió). La recuperación pasa por reimportar el CSV y reconstruir estados con "Fijar estado a mano".');
      }
      await pool.end();
      process.exit(0);
    } catch (err) {
      await pool.end().catch(() => {});
      if (ssl) {
        console.error('❌ No se pudo consultar la BD:', err.message);
        process.exit(1);
      }
      // reintenta con SSL
    }
  }
})();
