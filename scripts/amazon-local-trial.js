// Operator-controlled, real ₹1 payment trial. Never run this from the automated test suite.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Database } from '@youpi/db';
import { buildUpiUri, verifyHmac } from '@youpi/common';
import { generateQrSvg } from '@youpi/core';
import { createPaymentApp } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { main as startObserver } from '../apps/amazon-pay-observer/src/index.js';

process.env.AMAZON_PAY_ENABLED = 'true';
process.env.AMAZON_PAY_DRY_RUN = 'false';
process.env.AMAZON_PAY_MATCHING_MODE = 'slot';
process.env.YOUPI_MODE = 'localhost';
process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = 'true';
process.env.BASE_PAYMENT_API_URL = 'http://127.0.0.1:6100';
process.env.BASE_CHECKOUT_URL = 'http://127.0.0.1:7000';
if (!process.env.AMAZON_PAY_RECEIVER_VPA) throw new Error('Configure the test receiving VPA first');

const runId = Date.now().toString();
const db = new Database({ dbPath: `data/amazon-trial-${runId}.sqlite` });
const app = createPaymentApp(db);
const { defaultMerchant, merchantRepo, accountRepo, sessionRepo } = app.context;
const account = accountRepo.findActiveForMerchant(defaultMerchant.id);
db.execute('UPDATE payment_receiving_accounts SET upi_id = ?, payee_name = ? WHERE id = ?',
  [process.env.AMAZON_PAY_RECEIVER_VPA, 'Local UPI test', account.id]);
process.env.AMAZON_PAY_RECEIVING_ACCOUNT_ID = account.id;
let session, svg = '', observerRuntime, portal, lastStatus = '';
const proof = { orderId: `AMAZON-TRIAL-${runId}`, amount: '1.00', status: 'PREPARING', webhookVerified: false };
const deliveries = new Set();
const save = () => fs.writeFileSync('data/amazon-local-trial.json', JSON.stringify(proof, null, 2));
const receiver = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const merchant = merchantRepo.findById(defaultMerchant.id);
    const signature = String(req.headers['x-gateway-signature'] || '');
    if (!signature.startsWith('sha256=') || !verifyHmac(raw, merchant.webhookSecret, signature.slice(7))) { res.writeHead(401); res.end(); return; }
    const payload = JSON.parse(raw.toString('utf8'));
    if (payload.event === 'SUCCESS' && payload.paymentId === session?.id && payload.orderId === proof.orderId && payload.amountPaise === 100 && payload.method === 'UPI') {
      deliveries.add(req.headers['x-gateway-delivery-id']);
      Object.assign(proof, { status: 'SUCCESS', webhookVerified: true, verifiedAt: new Date().toISOString(), utrLast4: String(payload.utr).slice(-4), uniqueDeliveries: deliveries.size });
      save();
      console.log('[Trial] PAYMENT VERIFIED: exact ₹1 UPI receipt and signed merchant webhook matched.');
    }
    res.end('{"received":true}'); return;
  }
  if (req.url === '/qr.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-store'); res.end(svg); return; }
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ...proof, observer: observerRuntime?.observer.health().state })); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>₹1 Amazon Pay local test</title></head><body style="font:20px system-ui;text-align:center;background:#fff;color:#111;padding:24px"><h1>₹1 UPI test</h1><p>Pay exactly ₹1 from your family member’s UPI app.</p><img id="qr" src="/qr.svg" width="360" height="360"><p>Receiving UPI ID: ${process.env.AMAZON_PAY_RECEIVER_VPA}</p><p id="state">Preparing…</p><p id="expiry"></p><script>setInterval(async()=>{const s=await(await fetch('/status')).json();document.getElementById('state').textContent=s.webhookVerified?'Payment confirmed — signed webhook verified':s.status+' · Amazon observer: '+s.observer;document.getElementById('expiry').textContent=s.expiresAt?'Expires: '+new Date(s.expiresAt).toLocaleTimeString():'';if(['EXPIRED','FAILED','CANCELLED','SUCCESS'].includes(s.status))document.getElementById('qr').style.display='none';},1000)</script></body></html>`);
});

async function listen(server, port) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}
await listen(receiver, 6105);
db.execute('UPDATE merchants SET webhook_url = ? WHERE id = ?', ['http://127.0.0.1:6105/webhook', defaultMerchant.id]);
await listen(app.rawServer, 6100);
portal = await startCheckoutServer(7000, { apiBaseUrl: 'http://127.0.0.1:6100' });
observerRuntime = await startObserver();
await observerRuntime.observer.sweep();
if (observerRuntime.observer.health().status !== 'UP') {
  console.error('[Trial] Observer readiness:', observerRuntime.observer.health().state, observerRuntime.observer.health().lastFailure);
  await observerRuntime.observer.stop(); observerRuntime.server.close(); app.destroy(); await portal.close(); receiver.close(); app.rawServer.close();
  process.exitCode = 1;
  throw new Error('Amazon observer is not ready; no payment QR has been activated');
}

session = sessionRepo.create({ merchantId: defaultMerchant.id, receivingAccountId: account.id,
  orderId: proof.orderId, amountPaise: 100n, metadata: { purpose: 'operator-controlled-local-trial' } });
sessionRepo.acquireSlotAtomic(session.id, account.id, 300000);
session = sessionRepo.findById(session.id);
app.context.timingEngine.startActiveTimer(session.id, session.expiresAt);
svg = generateQrSvg(buildUpiUri({ payeeVpa: process.env.AMAZON_PAY_RECEIVER_VPA, payeeName: 'Local UPI test', amountPaise: 100n, transactionRef: proof.orderId }));
Object.assign(proof, { paymentId: session.id, status: session.status, expiresAt: session.expiresAt.toISOString(),
  paymentPage: 'http://127.0.0.1:6105', checkoutUrl: `http://127.0.0.1:7000/checkout/${session.id}` });
save();
fs.mkdirSync('output/playwright', { recursive: true });
const page = await observerRuntime.observer.browser.context.newPage();
await page.goto('http://127.0.0.1:6105');
await page.locator('#qr').screenshot({ path: 'output/playwright/amazon-live-qr.png' });
await page.close();
console.log(JSON.stringify({ ...proof, qrImage: path.resolve('output/playwright/amazon-live-qr.png') }));

const statusTimer = setInterval(() => {
  const current = sessionRepo.findById(session.id);
  if (current.status !== lastStatus) {
    lastStatus = current.status;
    proof.status = current.status;
    save();
    console.log(`[Trial] ${current.status}`);
  }
}, 1000);
async function stop() {
  clearInterval(statusTimer);
  await observerRuntime?.observer.stop();
  observerRuntime?.server.close();
  app.destroy();
  await portal?.close();
  receiver.close(); app.rawServer.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
