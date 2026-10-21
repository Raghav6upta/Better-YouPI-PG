import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations, PaymentSessionRepository, ObservationRepository, ReceivingAccountRepository } from '@youpi/db';
import { AttributionEngine } from '../attribution-engine.js';
import { normalizeAmazonPayReceipt, parseAmazonPayReceipt, parseAmazonPayDate } from '../amazon-pay.js';
import { receiptText } from './fixtures/amazon-receipt.js';

describe('Amazon receipt validation and atomic attribution', () => {
  let db, sessions, observations, account, merchant, engine, events;
  beforeEach(() => {
    process.env.AMAZON_PAY_ENABLED = 'true';
    process.env.AMAZON_PAY_DRY_RUN = 'false';
    process.env.AMAZON_PAY_MATCHING_MODE = 'slot';
    db = new Database({ inMemory: true });
    merchant = runMigrations(db).defaultMerchant;
    sessions = new PaymentSessionRepository(db);
    observations = new ObservationRepository(db);
    account = new ReceivingAccountRepository(db).findActiveForMerchant(merchant.id);
    db.execute('UPDATE payment_receiving_accounts SET upi_id = ? WHERE id = ?', ['merchant@amazonpay', account.id]);
    account.upiId = 'merchant@amazonpay';
    events = [];
    engine = new AttributionEngine({ sessionRepo: sessions, obsRepo: observations,
      eventEmitter: { emit: (...args) => events.push(args) } });
  });
  afterEach(() => { engine.destroy?.(); db.close(); delete process.env.AMAZON_PAY_ENABLED; delete process.env.AMAZON_PAY_DRY_RUN; delete process.env.AMAZON_PAY_MATCHING_MODE; });
  function active(orderId = 'ORDER-1', amountPaise = 20000n) {
    const session = sessions.create({ merchantId: merchant.id, receivingAccountId: account.id, orderId, amountPaise });
    sessions.acquireSlotAtomic(session.id, account.id, 300000);
    return session;
  }
  const normalize = (options) => normalizeAmazonPayReceipt(receiptText(options), account);

  test('parses exact paise, Indian grouping, IST noon/midnight and rejects malformed receipts', () => {
    assert.equal(parseAmazonPayReceipt(receiptText({ amount: '1,23,456.78' })).amountPaise, 12345678n);
    assert.equal(parseAmazonPayDate('19 Oct 2026, 12:00 AM').toISOString(), '2026-10-18T18:30:00.000Z');
    assert.equal(parseAmazonPayDate('19 Oct 2026, 12:00 PM').toISOString(), '2026-10-19T06:30:00.000Z');
    assert.throws(() => parseAmazonPayDate('31 Feb 2026, 1:00 PM'));
    for (const status of ['Pending', 'Failed', 'Sent', 'Refunded']) assert.throws(() => normalize({ status }));
    assert.throws(() => normalize({ receiver: 'someone@upi' }));
    assert.throws(() => normalize({ amount: '0' }));
    assert.throws(() => normalize({ utr: '1234' }));
    assert.throws(() => parseAmazonPayReceipt(receiptText() + '\nUPI transaction ID\n123456789012'));
  });

  test('settles exactly once with atomic receipt consumption and durable notification intent', () => {
    const session = active();
    const result = engine.processObservation(normalize());
    assert.equal(result.outcomeStatus, 'SUCCESS');
    assert.equal(sessions.findById(session.id).status, 'SUCCESS');
    assert.equal(db.queryOne('SELECT payment_id FROM amazon_payment_receipts').payment_id, session.id);
    assert.equal(db.query('SELECT * FROM payment_event_outbox').length, 1);
    assert.equal(engine.processObservation(normalize()).duplicate, true);
    assert.equal(events.filter(e => e[0] === 'PAYMENT.SUCCESS').length, 1);
    assert.equal(db.queryOne('SELECT is_slot_busy FROM payment_receiving_accounts WHERE id = ?', [account.id]).is_slot_busy, 0);
  });

  test('rolls back payment, receipt and observation when notification persistence fails', () => {
    const session = active();
    db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON payment_event_outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => engine.processObservation(normalize()), /test failure/);
    assert.equal(sessions.findById(session.id).status, 'ACTIVE');
    assert.equal(db.query('SELECT * FROM payment_observations').length, 0);
    assert.equal(db.query('SELECT * FROM amazon_payment_receipts').length, 0);
    assert.equal(events.length, 0);
  });

  test('dry-run observations never settle, including after configuration changes', () => {
    const session = active();
    process.env.AMAZON_PAY_DRY_RUN = 'true';
    assert.equal(engine.processObservation(normalize()).outcomeStatus, 'OBSERVED_ONLY');
    process.env.AMAZON_PAY_DRY_RUN = 'false';
    assert.equal(engine.processObservation(normalize()).outcomeStatus, 'OBSERVED_ONLY');
    assert.equal(sessions.findById(session.id).status, 'ACTIVE');
  });

  test('rejects old, future and wrong-amount transfers without changing an active order', () => {
    const session = active();
    assert.equal(engine.processObservation(normalize({ amount: '199.00' })).attributed, false);
    assert.equal(engine.processObservation(normalize({ date: new Date(Date.now() - 600_000), utr: '223456789012', reference: 'TEST-OLD-001' })).attributed, false);
    assert.throws(() => engine.processObservation(normalize({ date: new Date(Date.now() + 600_000), utr: '323456789012', reference: 'TEST-FUTURE-001' })));
    assert.equal(sessions.findById(session.id).status, 'ACTIVE');
  });

  test('same-minute prior order makes a same-amount receipt ambiguous', () => {
    const first = active();
    sessions.transitionToTerminal(first.id, 'CANCELLED');
    const second = active('ORDER-2');
    assert.equal(engine.processObservation(normalize()).outcomeStatus, 'AMBIGUOUS');
    assert.equal(sessions.findById(second.id).status, 'ACTIVE');
  });

  test('expired sessions cannot be revived and other observation sources are disabled', () => {
    const session = active();
    sessions.transitionToTerminal(session.id, 'EXPIRED');
    assert.equal(engine.processObservation(normalize()).attributed, false);
    assert.equal(engine.processObservation({ ...normalize(), source: 'GMAIL' }).outcomeStatus, 'SOURCE_DISABLED');
    assert.equal(sessions.findById(session.id).status, 'EXPIRED');
  });

  test('conflicting Amazon references roll back instead of creating another receipt', () => {
    process.env.AMAZON_PAY_DRY_RUN = 'true';
    engine.processObservation(normalize());
    assert.throws(() => engine.processObservation(normalize({ reference: 'DIFFERENT-REFERENCE' })), /Conflicting/);
    assert.equal(db.query('SELECT * FROM amazon_payment_receipts').length, 1);
  });
});
