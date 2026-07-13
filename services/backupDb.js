/**
 * Caja fuerte en Postgres (opcional) — se activa con DATABASE_URL.
 *
 * Problema: en Seenode el disco del contenedor es efímero. Un redeploy borra
 * data/ (leads, actividad, cola de activación) y auth_info/ (la sesión de
 * WhatsApp → toca escanear el QR otra vez).
 *
 * Solución: cada BACKUP_INTERVAL_MINUTES (5 por defecto) se vuelca una foto
 * de esos ficheros a una tabla de Postgres. Al arrancar, si los ficheros
 * locales no existen (deploy recién hecho), se restauran desde la última
 * foto — incluido auth_info, así el número de WhatsApp NO se desvincula.
 *
 * Cómo activarlo en Seenode: crear una base de datos Postgres gestionada en
 * el panel, copiar su cadena de conexión y ponerla como DATABASE_URL en las
 * variables de entorno de la app. Nada más. Sin DATABASE_URL este módulo no
 * hace nada y todo funciona como antes.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || path.join(process.cwd(), 'auth_info');
const INTERVALO_MIN = Math.max(1, parseInt(process.env.BACKUP_INTERVAL_MINUTES, 10) || 5);

let pool = null;

// ─── Qué se respalda ──────────────────────────────────────────────
// Ficheros sueltos de data/ + el directorio completo de la sesión de WhatsApp
const FICHEROS = [
  { kind: 'leads', ruta: () => path.join(DATA_DIR, 'leads.json') },
  { kind: 'activity', ruta: () => path.join(DATA_DIR, 'activity.json') },
  { kind: 'activation', ruta: () => path.join(DATA_DIR, 'activation.json') },
];

function _leerDirComoObjeto(dir) {
  // Serializa un directorio plano de ficheros (auth de Baileys) a { nombre: contenido }
  const out = {};
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = fs.readFileSync(p, 'utf-8');
  }
  return Object.keys(out).length ? out : null;
}

function _escribirObjetoComoDir(dir, obj) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [nombre, contenido] of Object.entries(obj)) {
    // Solo nombres de fichero planos (defensa ante datos corruptos)
    if (nombre.includes('/') || nombre.includes('\\') || nombre.includes('..')) continue;
    fs.writeFileSync(path.join(dir, nombre), contenido, 'utf-8');
  }
}

// ¿El contenido es un JSON "vacío"? ([] , {} o ilegible). Un fichero así
// jamás debe machacar una copia con datos, ni impedir una restauración.
function _esJsonVacio(contenido) {
  try {
    const v = JSON.parse(contenido);
    if (Array.isArray(v)) return v.length === 0;
    if (v && typeof v === 'object') return Object.keys(v).length === 0;
    return true;
  } catch (e) {
    return true;
  }
}

// ─── Guardar (fichero → BD) ───────────────────────────────────────
async function guardar() {
  if (!pool) return;
  try {
    for (const f of FICHEROS) {
      const ruta = f.ruta();
      if (!fs.existsSync(ruta)) continue;
      const data = fs.readFileSync(ruta, 'utf-8');
      // CANDADO ANTI-DESASTRE (incidente 13-07): si el fichero local está
      // vacío ([] recién creado tras un redeploy) y la BD tiene una copia con
      // datos, NO la machacamos. Solo se sube vacío si la BD también lo está.
      if ((f.kind === 'leads' || f.kind === 'activity') && _esJsonVacio(data)) {
        const prev = await pool.query('SELECT data FROM bot_backup WHERE kind = $1', [f.kind]);
        const copiaConDatos = prev.rows.length &&
          !_esJsonVacio(typeof prev.rows[0].data === 'string' ? prev.rows[0].data : JSON.stringify(prev.rows[0].data));
        if (copiaConDatos) {
          console.warn(`🛑 [BackupDB] ${f.kind} local está VACÍO pero la copia en BD tiene datos — NO se sobreescribe`);
          continue;
        }
      }
      await pool.query(
        `INSERT INTO bot_backup (kind, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (kind) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [f.kind, data]
      );
      // Historial versionado (incidente 13-07): además de la foto "viva" (que
      // se sobreescribe), guardamos una copia por hora que NUNCA se pisa. Si
      // algo corrompe la foto viva, siempre queda la de hace una hora, ayer,
      // etc. Se conservan 14 días. Restaurar una: copiar su data de
      // bot_backup_hist a bot_backup y reiniciar la app.
      if (!_esJsonVacio(data)) {
        await pool.query(
          `INSERT INTO bot_backup_hist (kind, data)
           SELECT $1, $2::jsonb
           WHERE NOT EXISTS (
             SELECT 1 FROM bot_backup_hist
             WHERE kind = $1 AND created_at > now() - interval '55 minutes'
           )`,
          [f.kind, data]
        );
      }
    }
    const auth = _leerDirComoObjeto(WA_AUTH_DIR);
    if (auth) {
      await pool.query(
        `INSERT INTO bot_backup (kind, data, updated_at) VALUES ('wa_auth', $1::jsonb, now())
         ON CONFLICT (kind) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify(auth)]
      );
    }
  } catch (err) {
    console.error('⚠️  [BackupDB] Error guardando copia:', err.message);
  }
}

// ─── Restaurar (BD → fichero, solo si el fichero local NO existe) ─
async function _restaurar() {
  const res = await pool.query('SELECT kind, data, updated_at FROM bot_backup');
  const porKind = new Map(res.rows.map((r) => [r.kind, r]));

  let restaurados = 0;
  for (const f of FICHEROS) {
    const ruta = f.ruta();
    const row = porKind.get(f.kind);
    if (!row) continue;
    // El fichero local manda… salvo que esté VACÍO. Un [] recién creado por
    // una petición que llegó antes de la restauración no es "datos locales":
    // es el disco efímero recién limpiado. La copia de la BD gana en ese caso.
    if (fs.existsSync(ruta)) {
      let contenidoLocal = '';
      try { contenidoLocal = fs.readFileSync(ruta, 'utf-8'); } catch (e) {}
      if (!_esJsonVacio(contenidoLocal)) continue;
    }
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const contenido = typeof row.data === 'string' ? row.data : JSON.stringify(row.data, null, 2);
    fs.writeFileSync(ruta, contenido, 'utf-8');
    restaurados++;
    console.log(`♻️  [BackupDB] ${f.kind} restaurado desde la copia del ${new Date(row.updated_at).toLocaleString()}`);
  }

  const authRow = porKind.get('wa_auth');
  if (authRow && !fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json'))) {
    const obj = typeof authRow.data === 'string' ? JSON.parse(authRow.data) : authRow.data;
    _escribirObjetoComoDir(WA_AUTH_DIR, obj);
    restaurados++;
    console.log('♻️  [BackupDB] Sesión de WhatsApp restaurada — no hará falta escanear el QR');
  }
  return restaurados;
}

// ─── Guardado "pronto" (debounce) ────────────────────────────────
// Se llama tras crear/cambiar un lead: agenda una copia en unos segundos.
// Debounce: muchos cambios seguidos = una sola copia. Así un lead de prueba
// queda guardado a los pocos segundos, no hay que esperar a la copia de 5 min.
let _debounce = null;
function guardarPronto() {
  if (!pool) return;
  clearTimeout(_debounce);
  _debounce = setTimeout(() => guardar(), 8000);
}

// Copia final al apagarse (Seenode manda SIGTERM antes de redesplegar). Así
// el estado más reciente se guarda justo antes de reiniciar el contenedor.
let _cerrando = false;
async function _flushYSalir(sig) {
  if (_cerrando) return;
  _cerrando = true;
  try {
    if (pool) {
      console.log(`💾 [BackupDB] ${sig}: guardando copia final antes de cerrar...`);
      await guardar();
    }
  } catch (e) { /* best effort */ }
  process.exit(0);
}

// ─── Arranque ─────────────────────────────────────────────────────
async function iniciar() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('ℹ️  [BackupDB] Sin DATABASE_URL: copia de seguridad en Postgres desactivada');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 8000,
      ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS bot_backup (
      kind TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Historial versionado: una copia por hora y por tipo, nunca se pisa.
    await pool.query(`CREATE TABLE IF NOT EXISTS bot_backup_hist (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Purga de copias antiguas (conservamos 14 días)
    await pool.query(`DELETE FROM bot_backup_hist WHERE created_at < now() - interval '14 days'`);

    const restaurados = await _restaurar();
    console.log(`💾 [BackupDB] Activo — copia cada ${INTERVALO_MIN} min${restaurados ? ` (${restaurados} elementos restaurados)` : ''}`);

    setInterval(() => guardar(), INTERVALO_MIN * 60 * 1000);
    setTimeout(() => guardar(), 45 * 1000); // primera foto al poco de arrancar

    // Copia final al recibir la señal de apagado (redeploy de Seenode).
    process.on('SIGTERM', () => _flushYSalir('SIGTERM'));
    process.on('SIGINT', () => _flushYSalir('SIGINT'));
  } catch (err) {
    console.error('⚠️  [BackupDB] No se pudo conectar a Postgres (la app sigue sin copia):', err.message);
    pool = null;
  }
}

module.exports = { iniciar, guardar, guardarPronto };
