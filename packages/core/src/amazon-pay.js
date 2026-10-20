import { ObservationNormalizer } from './normalizer.js';
import { getAmazonPayConfig } from '@youpi/common';
import crypto from 'node:crypto';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const VPA = /^[a-z0-9._-]{2,100}@[a-z0-9._-]{2,64}$/i;

/** Amazon's English receipt exposes minute precision, in India Standard Time. */
export function parseAmazonPayDate(text) {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/.exec(text);
  if (!m) throw new Error('Unsupported Amazon Pay receipt date');
  const [, day, month, year, hour, minute, period] = m;
  const mo = MONTHS.indexOf(month);
  if (mo < 0 || +hour < 1 || +hour > 12 || +minute > 59) throw new Error('Invalid receipt date');
  const h = (+hour % 12) + (period === 'PM' ? 12 : 0);
  const local = new Date(Date.UTC(+year, mo, +day, h, +minute));
  if (local.getUTCDate() !== +day || local.getUTCMonth() !== mo) throw new Error('Invalid receipt date');
  return new Date(local.getTime() - 330 * 60_000);
}

/** Strict label-based parser. Input is the receipt component, never the entire page. */
export function parseAmazonPayReceipt(text) {
  if (typeof text !== 'string' || text.length > 16_384) throw new Error('Invalid receipt text');
  const lines = text.replace(/\u00a0/g, ' ').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const labels = ['Transaction Details', 'Received from', 'Credited to', 'UPI transaction ID', 'Amazon reference ID', 'Date and time'];
  const positions = labels.map(label => {
    if (lines.filter(x => x === label).length !== 1) throw new Error(`Missing or repeated receipt field: ${label}`);
    return lines.indexOf(label);
  });
  if (positions.some((p, i) => i && p <= positions[i - 1]) || lines[0] !== 'Transaction Details' || lines[1] !== 'Received') {
    throw new Error('Receipt is not a completed incoming payment');
  }
  const amount = /^₹\s*((?:\d+|\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?)$/.exec(lines[2]);
  if (!amount) throw new Error('Invalid receipt amount');
  const [rupees, fraction = ''] = amount[1].replace(/,/g, '').split('.');
  const amountPaise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amountPaise <= 0n || amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid receipt amount');
  function oneVpa(start, end) {
    const values = lines.slice(start + 1, end).filter(x => VPA.test(x));
    if (values.length !== 1) throw new Error('Missing or ambiguous receipt UPI ID');
    return values[0].toLowerCase();
  }
  const bankReferenceNumber = lines[positions[3] + 1];
  const amazonReferenceId = lines[positions[4] + 1];
  if (!/^\d{12}$/.test(bankReferenceNumber)) throw new Error('Receipt requires a 12-digit UPI transaction ID');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(amazonReferenceId)) throw new Error('Invalid Amazon reference ID');
  if (!lines.slice(positions[2] + 1, positions[3]).includes('Amazon Pay UPI')) throw new Error('Receipt is not Amazon Pay UPI');
  return {
    amountPaise, bankReferenceNumber, amazonReferenceId,
    senderVpa: oneVpa(positions[1], positions[2]),
    receiverVpa: oneVpa(positions[2], positions[3]),
    observedAt: parseAmazonPayDate(lines[positions[5] + 1]),
    timestampPrecisionMs: 60_000
  };
}

export function normalizeAmazonPayReceipt(text, account) {
  const receipt = parseAmazonPayReceipt(text);
  if (!account?.isActive || receipt.receiverVpa !== account.upiId.toLowerCase().trim()) {
    throw new Error('Receipt recipient does not match the configured active receiving account');
  }
  return ObservationNormalizer.normalize({
    source: 'AMAZON_PAY', receivingAccountId: account.id,
    amountPaise: receipt.amountPaise, observedAt: receipt.observedAt,
    bankReferenceNumber: receipt.bankReferenceNumber, senderVpa: receipt.senderVpa,
    // Keep only the reconciliation fields; omit names, account digits and the full page.
    rawPayload: { receiverVpa: receipt.receiverVpa, amazonReferenceId: receipt.amazonReferenceId, timestampPrecisionMs: 60_000,
      observationOnly: !getAmazonPayConfig().canSettle }
  });
}

/** Slot matching is an explicit heuristic opt-in; observe mode cannot settle. */
export function reconcileAmazonPay(engine, observation) {
  const { sessionRepo, obsRepo } = engine;
  const db = sessionRepo.db;
  const config = getAmazonPayConfig();
  if (!config.enabled) throw new Error('Amazon Pay observation source is disabled');
  const result = db.transaction(() => {
    const account = db.queryOne('SELECT upi_id, is_active FROM payment_receiving_accounts WHERE id = ?', [observation.receivingAccountId]);
    if (!account?.is_active || account.upi_id.toLowerCase().trim() !== observation.rawPayload?.receiverVpa ||
        !/^\d{12}$/.test(observation.bankReferenceNumber) || !(observation.observedAt instanceof Date) ||
        !Number.isFinite(observation.observedAt.getTime()) || observation.observedAt.getTime() > Date.now() ||
        observation.amountPaise <= 0n ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(observation.rawPayload?.amazonReferenceId || '')) throw new Error('Invalid Amazon Pay observation');

    // UTR is the identity: changing amount or replaying through another channel cannot reuse it.
    const previous = db.query(`SELECT * FROM payment_observations
      WHERE receiving_account_id = ? AND bank_reference_number = ? ORDER BY created_at`,
    [observation.receivingAccountId, observation.bankReferenceNumber]);
    const used = previous.find(row => row.attributed_payment_id);
    if (used) return { accepted: true, duplicate: true, attributed: false, observationId: used.id, outcomeStatus: 'DUPLICATE_IGNORED' };
    const sameSource = previous.find(row => row.source === 'AMAZON_PAY');
    if (sameSource && (BigInt(sameSource.amount_paise) !== observation.amountPaise || sameSource.observed_at !== observation.observedAt.toISOString())) {
      throw new Error('Conflicting receipt for an existing UPI transaction ID');
    }
    const saved = sameSource ? obsRepo.findById(sameSource.id) : obsRepo.create(observation);
    const receipt = db.queryOne('SELECT * FROM amazon_payment_receipts WHERE receiving_account_id = ? AND utr = ?',
      [saved.receivingAccountId, saved.bankReferenceNumber]);
    if (receipt && receipt.amazon_reference_id !== observation.rawPayload.amazonReferenceId) throw new Error('Conflicting Amazon reference');
    if (!receipt) db.execute(`INSERT INTO amazon_payment_receipts
      (receiving_account_id, utr, amazon_reference_id, observation_id) VALUES (?, ?, ?, ?)`,
      [saved.receivingAccountId, saved.bankReferenceNumber, observation.rawPayload.amazonReferenceId, saved.id]);
    if (!config.canSettle || saved.rawPayload.observationOnly) return { accepted: true, attributed: false, observationId: saved.id, outcomeStatus: 'OBSERVED_ONLY' };
    const sessionRows = db.query(`SELECT * FROM payment_sessions WHERE receiving_account_id = ?
      AND status IN ('ACTIVE', 'PROCESSING') AND method = 'UPI'`, [saved.receivingAccountId]);
    let session = sessionRows.length === 1 ? sessionRepo.mapRow(sessionRows[0]) : null;
    const now = Date.now();
    const start = session?.slotAcquiredAt?.getTime();
    const end = session?.expiresAt?.getTime();
    const deadline = session?.status === 'PROCESSING' ? session.processingExpiresAt?.getTime() : end;
    const receiptStart = saved.observedAt.getTime();
    // The displayed minute must overlap the original QR window. No five-minute skew fallback.
    const eligible = session && session.amountPaise === saved.amountPaise && Number.isFinite(start) &&
      Number.isFinite(end) && deadline > now && receiptStart + 60_000 > start && receiptStart <= Math.min(now, end) &&
      saved.ingestedAt.getTime() >= start;
    if (!eligible) return { accepted: true, attributed: false, duplicate: false, observationId: saved.id, outcomeStatus: 'UNATTRIBUTED' };
    // A minute-resolution receipt overlapping another checkout cannot select this order.
    const competitors = db.query(`SELECT id FROM payment_sessions WHERE receiving_account_id = ?
      AND method = 'UPI' AND id <> ? AND amount_paise = ? AND slot_acquired_at < ? AND expires_at >= ?`,
      [saved.receivingAccountId, session.id, Number(saved.amountPaise), new Date(receiptStart + 60_000).toISOString(), saved.observedAt.toISOString()]);
    if (competitors.length) return { accepted: true, attributed: false, observationId: saved.id, outcomeStatus: 'AMBIGUOUS' };
    const verification = sessionRepo.recordVerificationSourceInTransaction(session.id, 'AMAZON_PAY', saved.id, { finalizeSuccess: true });
    obsRepo.markAttributed(saved.id, session.id);
    db.execute('UPDATE amazon_payment_receipts SET payment_id = ? WHERE receiving_account_id = ? AND utr = ?',
      [session.id, saved.receivingAccountId, saved.bankReferenceNumber]);
    db.execute('INSERT INTO payment_event_outbox (id, payment_id, event_type, created_at) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), session.id, 'SUCCESS', new Date().toISOString()]);
    return {
      accepted: true, attributed: true, duplicate: false, observationId: saved.id,
      paymentSessionId: session.id, outcomeStatus: 'SUCCESS', verification,
      event: { paymentId: session.id, orderId: session.orderId, merchantId: session.merchantId,
        amountPaise: session.amountPaise, observationId: saved.id, verificationLevel: verification.level,
        verificationTag: verification.tag, sources: verification.sources }
    };
  });
  if (result.verification?.isFirstSuccess) engine.eventEmitter.emit('PAYMENT.SUCCESS', result.event);
  const { verification, event, ...publicResult } = result;
  return publicResult;
}
