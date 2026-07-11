/**
 * Selector del canal WhatsApp.
 *
 * Elige la implementación según config.whatsapp.provider:
 *   - 'cloud'   → whatsappCloud.js  (API oficial de Meta — recomendado)
 *   - 'baileys' → whatsappBaileys.js (no oficial por QR — respaldo)
 *
 * El resto del código sigue haciendo require('./whatsapp') sin enterarse de
 * cuál está activo. La interfaz común es: initialize, sendTextMessage,
 * sendTypingAction, isConfigured, getLatestQr (+ sendTemplate en cloud).
 */

const config = require('../config/config');

const provider = config.whatsapp.provider === 'cloud' ? 'cloud' : 'baileys';
const impl = provider === 'cloud'
  ? require('./whatsappCloud')
  : require('./whatsappBaileys');

console.log(`📡 [WhatsApp] Proveedor activo: ${provider === 'cloud' ? 'API OFICIAL (Meta Cloud API)' : 'Baileys (no oficial)'}`);

module.exports = Object.assign({}, impl, { provider });
