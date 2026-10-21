import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReceiptJournal } from '../journal.js';
import { AmazonObserver } from '../observer.js';
import { receiptText } from '../../../../packages/core/src/__tests__/fixtures/amazon-receipt.js';

function setup(options = {}) {
  const journal = options.journal || new ReceiptJournal(':memory:');
  let submissions = 0, scans = 0;
  const observer = new AmazonObserver({ receivingAccountId: 'test-account', receiverVpa: 'merchant@amazonpay',
    journal, dryRun: false, canSettle: true,
    browser: { scan: async () => { scans++; return { receipts: [{ url: 'https://www.amazon.in/pay/transaction-details?id=1', text: receiptText() }], complete: true }; }, close: async () => {} },
    client: { submitObservation: async () => { submissions++; return { accepted: true, attribution: { outcomeStatus: 'SUCCESS' } }; } }, ...options });
  return { observer, journal, submissions: () => submissions, scans: () => scans };
}

test('coalesces simultaneous sweeps and rate-limits repeated requests', async () => {
  const x = setup();
  await Promise.all([x.observer.sweep(), x.observer.sweep(), x.observer.sweep()]);
  await x.observer.sweep();
  assert.equal(x.scans(), 1);
  assert.equal(x.submissions(), 1);
  assert.equal(x.observer.health().status, 'UP');
  await x.observer.stop();
});

test('dry-run never submits and strips payer names from the journal', async () => {
  const x = setup({ dryRun: true, canSettle: false });
  await x.observer.sweep();
  assert.equal(x.submissions(), 0);
  const row = x.journal.db.prepare('SELECT * FROM receipts').get();
  assert.equal(row.outcome, 'DRY_RUN');
  assert.equal(row.text.includes('Example Payer'), false);
  await x.observer.stop();
});

test('transport failures remain queued across restart and replay exactly once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-amazon-journal-'));
  const filename = path.join(dir, 'journal.sqlite');
  const x = setup({ journal: new ReceiptJournal(filename), client: { submitObservation: async () => { throw new Error('offline'); } } });
  await x.observer.sweep();
  assert.equal(x.observer.health().state, 'API_UNAVAILABLE');
  assert.equal(x.journal.pendingCount(), 1);
  await x.observer.stop();
  const y = setup({ journal: new ReceiptJournal(filename) });
  y.journal.db.exec('UPDATE receipts SET next_attempt_at = 0');
  await y.observer.sweep();
  assert.equal(y.submissions(), 1);
  y.observer.lastStartedAt = 0;
  await y.observer.sweep();
  assert.equal(y.submissions(), 1);
  await y.observer.stop();
  fs.rmSync(dir, { recursive: true });
});

test('login expiry and wrong-recipient receipts cannot report healthy or submit', async () => {
  const x = setup({ browser: { scan: async () => { throw new Error('LOGIN_REQUIRED'); }, close: async () => {} } });
  await x.observer.sweep();
  assert.equal(x.observer.health().state, 'LOGIN_REQUIRED');
  assert.equal(x.observer.health().status, 'DOWN');
  await x.observer.stop();
  const y = setup({ receiverVpa: 'different@upi' });
  await y.observer.sweep();
  assert.equal(y.observer.health().state, 'RECEIPT_REJECTED');
  assert.equal(y.submissions(), 0);
  await y.observer.stop();
});

test('incomplete scans do not submit partial evidence', async () => {
  const x = setup({ browser: { scan: async () => ({ receipts: [{ url: 'receipt', text: receiptText() }], complete: false }), close: async () => {} } });
  await x.observer.sweep();
  assert.equal(x.observer.health().state, 'BACKLOG');
  assert.equal(x.submissions(), 0);
  await x.observer.stop();
});

test('explicit wallet credits are ignored; only validated UPI receipts establish health or submit', async () => {
  const wallet = ['Transaction Details', 'Received', '₹10', 'Received from', 'Example payer',
    'Credited to', 'Amazon Pay Wallet', 'Amazon reference ID', 'WALLET-REFERENCE',
    'Bank reference ID', '123456789012', 'Date and time', '20 Oct 2026, 1:00 PM'].join('\n');
  const browser = receipts => ({ scan: async () => ({ receipts, complete: true }), close: async () => {} });
  const x = setup({ browser: browser([{ url: 'wallet', text: wallet }, { url: 'upi', text: receiptText() }]) });
  await x.observer.sweep();
  assert.equal(x.observer.health().status, 'UP');
  assert.equal(x.observer.health().receiptsValidated, 1);
  assert.equal(x.submissions(), 1);
  await x.observer.stop();
  const y = setup({ browser: browser([{ url: 'wallet', text: wallet }]) });
  await y.observer.sweep();
  assert.equal(y.observer.health().state, 'ACCOUNT_UNVERIFIED');
  assert.equal(y.submissions(), 0);
  await y.observer.stop();
  for (const text of [wallet.replace('Amazon Pay Wallet', 'Unknown credit'), receiptText().replace('UPI transaction ID', 'Bank reference ID')]) {
    const z = setup({ browser: browser([{ url: 'unknown', text }, { url: 'upi', text: receiptText() }]) });
    await z.observer.sweep();
    assert.equal(z.observer.health().state, 'RECEIPT_REJECTED');
    assert.equal(z.submissions(), 0);
    await z.observer.stop();
  }
});
