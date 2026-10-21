import { toRupeesString } from './money.js';

/**
 * Validates whether a given string is a syntactically valid UPI Virtual Payment Address (VPA).
 * Format: username@bank
 * @param {string} vpa
 * @returns {boolean}
 */
export function isValidVpa(vpa) {
  if (!vpa || typeof vpa !== 'string') return false;
  const clean = vpa.trim();
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/.test(clean);
}

/**
 * Builds a canonical upi://pay URI dynamically from server-validated parameters.
 * Amount is derived exclusively from server-side integer paise.
 * @param {{
 *   payeeVpa: string,
 *   payeeName: string,
 *   amountPaise: bigint,
 *   transactionRef: string,
 *   transactionNote?: string,
 *   currency?: string
 * }} options
 * @returns {string}
 */
export function buildUpiUri(options) {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const amountStr = toRupeesString(options.amountPaise);
  const currency = options.currency || 'INR';
  if (currency !== 'INR') {
    throw new Error('UPI payments require INR currency');
  }
  if (BigInt(options.amountPaise) <= 0n) {
    throw new Error('UPI payment amount must be greater than zero');
  }

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());
  params.set('am', amountStr);
  params.set('cu', currency);
  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  // UPI is a URI, not an HTML form. Use percent-encoded spaces as in the
  // documented app links; some app URI parsers do not decode form-style '+'.
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * Builds an Android intent URI for launching a specific UPI application.
 * Format: intent://pay?<UPI_PARAMS>#Intent;scheme=upi;package=<PACKAGE>;end
 * @param {{
 *   payeeVpa: string,
 *   payeeName: string,
 *   amountPaise: bigint,
 *   transactionRef?: string,
 *   transactionNote?: string,
 *   currency?: string,
 *   packageName: string
 * }} options
 * @returns {string}
 */
export function buildUpiIntentUri(options) {
  if (!options.packageName || !options.packageName.trim()) {
    throw new Error('Package name is required for Android UPI intent URI');
  }
  const upiUri = buildUpiUri(options);
  const query = upiUri.split('?')[1] || '';
  const cleanPackage = options.packageName.trim();
  return `intent://pay?${query}#Intent;scheme=upi;package=${cleanPackage};end`;
}
