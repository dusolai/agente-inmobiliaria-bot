const { google } = require('googleapis');
const config = require('../config/config');

/**
 * Servicio de Google Sheets.
 * Lee y escribe datos de leads en una hoja de cálculo de Google.
 */

let sheetsClient = null;

function getAuth() {
  if (!config.google.serviceAccountEmail || !config.google.privateKey ||
      config.google.serviceAccountEmail === 'tu_service_account@proyecto.iam.gserviceaccount.com') {
    return null;
  }

  return new google.auth.JWT(
    config.google.serviceAccountEmail,
    null,
    config.google.privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const auth = getAuth();
  if (!auth) {
    console.log('⚠️  [Sheets] Credenciales no configuradas — modo offline');
    return null;
  }

  await auth.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/**
 * Lee todas las filas de la hoja principal.
 * Retorna un array de objetos con los headers como keys.
 */
async function readAllRows(sheetName = 'Leads') {
  const client = await getSheetsClient();
  if (!client) return [];

  try {
    const res = await client.spreadsheets.values.get({
      spreadsheetId: config.google.sheetsId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0];
    return rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h.toLowerCase().trim()] = row[i] || '';
      });
      return obj;
    });
  } catch (err) {
    console.error('❌ [Sheets] Error leyendo filas:', err.message);
    return [];
  }
}

/**
 * Añade una nueva fila a la hoja.
 */
async function appendRow(values, sheetName = 'Leads') {
  const client = await getSheetsClient();
  if (!client) {
    console.log(`📊 [Sheets DEV] Append row:`, values);
    return { success: true, mode: 'development' };
  }

  try {
    await client.spreadsheets.values.append({
      spreadsheetId: config.google.sheetsId,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] },
    });

    console.log('✅ [Sheets] Fila añadida correctamente');
    return { success: true, mode: 'production' };
  } catch (err) {
    console.error('❌ [Sheets] Error añadiendo fila:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Actualiza una celda específica.
 */
async function updateCell(cellRange, value, sheetName = 'Leads') {
  const client = await getSheetsClient();
  if (!client) {
    console.log(`📊 [Sheets DEV] Update ${sheetName}!${cellRange} = ${value}`);
    return { success: true, mode: 'development' };
  }

  try {
    await client.spreadsheets.values.update({
      spreadsheetId: config.google.sheetsId,
      range: `${sheetName}!${cellRange}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[value]] },
    });

    return { success: true };
  } catch (err) {
    console.error('❌ [Sheets] Error actualizando celda:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { readAllRows, appendRow, updateCell };
