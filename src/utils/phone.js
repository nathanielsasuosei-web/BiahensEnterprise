'use strict';

/** Accept local or international Ghana numbers, with common display spacing. */
function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s().-]/g, '');
}

function isGhanaPhone(value) {
  return /^(?:0|\+233)[235]\d{8}$/.test(normalizePhone(value));
}

/** WhatsApp Cloud API expects a country code and digits, without a plus sign. */
function whatsappNumber(value) {
  const phone = normalizePhone(value);
  const international = /^0[235]\d{8}$/.test(phone) ? `233${phone.slice(1)}` : phone.replace(/^\+/, '');
  return /^[1-9]\d{7,14}$/.test(international) ? international : '';
}

module.exports = { normalizePhone, isGhanaPhone, whatsappNumber };
