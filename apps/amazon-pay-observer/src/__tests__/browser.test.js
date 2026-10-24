import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AmazonBrowser } from '../browser.js';
import { AmazonObserver } from '../observer.js';
import { ReceiptJournal } from '../journal.js';
import { createObserverServer } from '../index.js';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { Database } from '@youpi/db';
import { verifyHmac } from '@youpi/common';
import { createPaymentApp } from '../../../payment-api/src/index.js';
import { receiptText } from '../../../../packages/core/src/__tests__/fixtures/amazon-receipt.js';
import { TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const close = server => new Promise(resolve => server.close(resolve));

test('real browser shadow-DOM receipt → authenticated API → checkout SUCCESS → signed webhook, replay and restart recovery', { timeout: 60000 }, async () => {
  process.env.AMAZON_PAY_ENABLED = 'true';
  process.env.AMAZON_PAY_DRY_RUN = 'false';
  process.env.AMAZON_PAY_MATCHING_MODE = 'slot';
  process.env.YOUPI_MODE = 'localhost';
  process.env.NODE_ENV = 'test';
  const db = new Database({ inMemory: true });
  const app = createPaymentApp(db);
  const apiUrl = await listen(app.rawServer);
  const hooks = [];
  const webhook = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    hooks.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
    res.end('ok');
  });
  const webhookUrl = await listen(webhook);
  const { accountRepo, sessionRepo, merchantRepo, defaultMerchant } = app.context;
  const merchant = merchantRepo.findById(defaultMerchant.id);
  db.execute('UPDATE merchants SET webhook_url = ? WHERE id = ?', [webhookUrl, merchant.id]);
  const account = accountRepo.findActiveForMerchant(merchant.id);
  db.execute('UPDATE payment_receiving_accounts SET upi_id = ? WHERE id = ?', ['merchant@amazonpay', account.id]);
  const session = sessionRepo.create({ merchantId: merchant.id, receivingAccountId: account.id, orderId: 'BROWSER-ORDER', amountPaise: 20000n, metadata: { sku: 'UNCHANGED' } });
  sessionRepo.acquireSlotAtomic(session.id, account.id, 300000);
  const text = receiptText();
  let loggedIn = true;
  let unavailable = false;
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!loggedIn && req.url.startsWith('/pay/')) { res.writeHead(302, { Location: '/signin' }); loggedIn = true; res.end(); return; }
    if (req.url === '/signin') { res.end('<h1>Sign in</h1>'); return; }
    if (req.url.startsWith('/pay/history')) {
      res.end(`<html><body><div id="payui-transaction-history-page"><history-cards></history-cards></div>
      <script>customElements.define('history-cards',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML = '<div class="transaction-item"><a href="/pay/transaction-details?id=1">Received ₹200</a></div><div class="transaction-item">Sent ₹200</div>';}});</script></body></html>`);
    } else {
      if (unavailable) { res.writeHead(503); res.end('Service unavailable'); return; }
      res.end(`<html><body><receipt-view id="payui-transaction-receipt-id"><div slot="receipt">${text.split('\n').map(line => `<div>${line}</div>`).join('')}</div></receipt-view>
      <script>customElements.define('receipt-view',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<section><slot name="receipt"></slot></section>';}});</script></body></html>`);
    }
  });
  const fixtureUrl = await listen(fixture);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-amazon-browser-'));
  const browser = new AmazonBrowser({ profileDir, baseUrl: fixtureUrl, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const observer = new AmazonObserver({ browser, journal: new ReceiptJournal(':memory:'), receivingAccountId: account.id,
    receiverVpa: 'merchant@amazonpay', dryRun: false, canSettle: true,
    client: new PaymentObserverClient({ apiBaseUrl: apiUrl, sourceName: 'AMAZON_PAY' }) });
  const healthServer = createObserverServer(observer);
  const healthUrl = await listen(healthServer);
  try {
    await browser.start();
    const unauthorized = await fetch(`${apiUrl}/api/v1/pollers/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'AMAZON_PAY', receiptText: text, receivingAccountId: account.id }) });
    assert.equal(unauthorized.status, 401);
    assert.equal((await fetch(`${healthUrl}/health`)).status, 401);
    await observer.sweep();
    assert.equal(observer.health().status, 'UP');
    assert.equal(sessionRepo.findById(session.id).status, 'SUCCESS');
    await app.context.webhookEngine.flushPendingEvents();
    assert.equal(hooks.length, 1);
    assert.equal(verifyHmac(hooks[0].raw, merchant.webhookSecret, hooks[0].headers['x-gateway-signature'].slice(7)), true);
    const payload = JSON.parse(hooks[0].raw);
    assert.equal(payload.deliveryId, hooks[0].headers['x-gateway-delivery-id']);
    assert.equal(String(payload.timestamp), hooks[0].headers['x-gateway-timestamp']);
    assert.equal(verifyHmac(`${payload.timestamp}.${hooks[0].raw}`, merchant.webhookSecret,
      hooks[0].headers['x-gateway-signature-v2'].slice(7)), true);
    const outbox = db.queryOne('SELECT id FROM payment_event_outbox WHERE payment_id = ?', [session.id]);
    assert.equal(payload.deliveryId, outbox.id);
    assert.equal(payload.utr, '123456789012');
    assert.equal(payload.method, 'UPI');
    assert.equal(payload.orderId, 'BROWSER-ORDER');
    assert.deepEqual(payload.metadata, { sku: 'UNCHANGED' });
    const state = await (await fetch(`${apiUrl}/api/v1/checkout/${session.id}/state`)).json();
    assert.equal(state.status, 'SUCCESS');
    assert.equal(state.requiresUpiReference, undefined);
    observer.lastStartedAt = 0;
    await observer.sweep();
    assert.equal(hooks.length, 1);
    // Simulate a crash after durable delivery persistence but before outbox acknowledgement.
    db.execute('UPDATE payment_event_outbox SET dispatched_at = NULL');
    await app.context.webhookEngine.flushPendingEvents();
    assert.equal(hooks.length, 1);
    assert.equal(db.query('SELECT * FROM webhook_deliveries').length, 1);
    const gmail = await fetch(`${apiUrl}/api/v1/pollers/events`, { method: 'POST', headers: { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'GMAIL', receivingAccountId: account.id }) });
    assert.equal(gmail.status, 409);
    unavailable = true;
    observer.lastStartedAt = 0;
    await observer.sweep();
    assert.equal(observer.health().status, 'DOWN');
    assert.equal(observer.health().lastFailure, 'AMAZON_TEMPORARILY_UNAVAILABLE');
    unavailable = false;
    loggedIn = false;
    observer.lastStartedAt = 0;
    await observer.sweep();
    assert.equal(observer.health().state, 'LOGIN_REQUIRED');
    assert.equal(observer.health().status, 'DOWN');
  } finally {
    await observer.stop();
    app.destroy();
    await Promise.all([close(app.rawServer), close(fixture), close(webhook), close(healthServer)]);
    db.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    delete process.env.AMAZON_PAY_ENABLED; delete process.env.AMAZON_PAY_DRY_RUN; delete process.env.AMAZON_PAY_MATCHING_MODE;
  }
});
