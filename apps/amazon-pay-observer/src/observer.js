import { parseAmazonPayReceipt } from '@youpi/core';
import { toRupeesString } from '@youpi/common';

// History mixes wallet credits with bank UPI receipts. Ignore only the explicit
// wallet format; unknown or incomplete UPI receipts must still fail validation.
export function isAmazonWalletReceipt(text) {
  if (typeof text !== 'string' || text.length > 16_384) return false;
  const lines = text.replace(/\u00a0/g, ' ').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const credit = lines.indexOf('Credited to');
  return lines[0] === 'Transaction Details' && lines[1] === 'Received' &&
    lines.filter(s => s === 'Credited to').length === 1 &&
    lines.filter(s => s === 'Amazon reference ID').length === 1 &&
    credit > 1 && lines[credit + 1] === 'Amazon Pay Wallet' && lines[credit + 2] === 'Amazon reference ID' &&
    !lines.includes('UPI transaction ID') && !lines.includes('Amazon Pay UPI');
}

// Keep only fields needed for verification. Never journal names or bank account digits.
export function sanitizedReceipt(text, parsed) {
  const date = text.replace(/\u00a0/g, ' ').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return ['Transaction Details', 'Received', `₹${toRupeesString(parsed.amountPaise)}`,
    'Received from', parsed.senderVpa, 'Credited to', 'Amazon Pay UPI', parsed.receiverVpa,
    'UPI transaction ID', parsed.bankReferenceNumber, 'Amazon reference ID', parsed.amazonReferenceId,
    'Date and time', date[date.indexOf('Date and time') + 1]].join('\n');
}

export class AmazonObserver {
  constructor({ browser, journal, client, receivingAccountId, receiverVpa, dryRun = true,
    canSettle = false, intervalMs = 5000, idleIntervalMs = 30000, hasActivePayment = async () => true }) {
    Object.assign(this, { browser, journal, client, receivingAccountId, receiverVpa: receiverVpa?.toLowerCase().trim(),
      dryRun, canSettle, intervalMs: Math.max(1000, intervalMs), idleIntervalMs: Math.max(1000, idleIntervalMs), hasActivePayment });
    if (![this.intervalMs, this.idleIntervalMs].every(Number.isFinite)) throw new Error('Polling intervals must be finite numbers');
    this.lastScanAt = null;
    this.state = 'STARTING';
    this.failures = 0;
    this.stopped = true;
    this.lastStartedAt = 0;
    this.receiptsRead = 0;
    this.receiptsValidated = 0;
  }
  health() {
    const fresh = this.lastScanAt && Date.now() - Date.parse(this.lastScanAt) < Math.max(90_000, this.idleIntervalMs * 2);
    return { status: this.state === 'READY' && fresh ? 'UP' : 'DOWN', state: this.state,
      dryRun: this.dryRun, canSettle: this.canSettle, receivingAccountId: this.receivingAccountId,
      receiverVpa: this.receiverVpa, lastScanAt: this.lastScanAt, failures: this.failures,
      receiptsRead: this.receiptsRead, receiptsValidated: this.receiptsValidated, lastFailure: this.lastFailure || null };
  }
  sweep() {
    if (this.closing) return Promise.resolve(this.health());
    if (this.inFlight) return this.inFlight;
    const delay = Math.min(300_000, this.intervalMs * 2 ** Math.min(this.failures, 6));
    if (Date.now() - this.lastStartedAt < delay) return Promise.resolve(this.health());
    this.lastStartedAt = Date.now();
    this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async scan() {
    try {
      const result = await this.browser.scan(this.journal.knownUrls());
      this.receiptsRead = result.receipts.length;
      this.receiptsValidated = 0;
      let rejected = false;
      let accountVerified = false;
      for (const item of result.receipts) {
        if (isAmazonWalletReceipt(item.text)) continue;
        try {
          const receipt = parseAmazonPayReceipt(item.text);
          if (receipt.receiverVpa !== this.receiverVpa) throw new Error('WRONG_RECEIVER');
          accountVerified = true;
          if (receipt.observedAt.getTime() > Date.now()) throw new Error('FUTURE_RECEIPT');
          this.journal.add(`${receipt.receiverVpa}:${receipt.bankReferenceNumber}`, item.url, sanitizedReceipt(item.text, receipt));
          this.receiptsValidated++;
        } catch (error) { rejected = true; this.lastFailure = error.message; }
      }
      let transportFailed = false;
      // Dry-run journals are never retroactively submitted when live mode is enabled.
      for (const item of !rejected && result.complete && accountVerified ? this.journal.pending() : []) {
        if (this.dryRun) { this.journal.delivered(item.identity, 'DRY_RUN'); continue; }
        try {
          const reply = await this.client.submitObservation({ receivingAccountId: this.receivingAccountId, receiptText: item.text });
          if (reply.accepted !== true) throw new Error('INGEST_REJECTED');
          this.journal.delivered(item.identity, reply.attribution?.outcomeStatus || 'ACCEPTED');
        } catch (error) { transportFailed = true; this.lastFailure = error.message; this.journal.failed(item.identity, item.attempts); }
      }
      this.state = rejected ? 'RECEIPT_REJECTED' : !result.complete ? 'BACKLOG' : !accountVerified ? 'ACCOUNT_UNVERIFIED' : transportFailed || this.journal.pendingCount() > 0 ? 'API_UNAVAILABLE' : 'READY';
      if (this.state === 'READY') { this.lastScanAt = new Date().toISOString(); this.failures = 0; this.lastFailure = null; }
      else this.failures++;
    } catch (error) {
      this.state = error.message === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'PAGE_UNAVAILABLE';
      this.lastFailure = ['LOGIN_REQUIRED', 'HISTORY_UNAVAILABLE_OR_CHALLENGE', 'UNEXPECTED_RECEIPT_URL', 'AMAZON_TEMPORARILY_UNAVAILABLE'].includes(error.message)
        ? error.message : 'BROWSER_PAGE_UNAVAILABLE';
      this.failures++;
    }
    return this.health();
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      await this.sweep();
      if (this.stopped) return;
      let active = true;
      try { active = await this.hasActivePayment(); } catch { /* Poll conservatively when API is unavailable. */ }
      if (this.stopped) return;
      this.timer = setTimeout(() => { this.loop = tick(); }, Math.min(300_000, (active ? this.intervalMs : this.idleIntervalMs) * 2 ** Math.min(this.failures, 6)));
      this.timer.unref?.();
    };
    this.loop = tick();
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closing = this.stopped = true;
    this.stopPromise = (async () => {
      clearTimeout(this.timer);
      await this.inFlight;
      await this.loop;
      await this.browser.close();
      this.journal.close();
      this.state = 'STOPPED';
    })();
    return this.stopPromise;
  }
}
