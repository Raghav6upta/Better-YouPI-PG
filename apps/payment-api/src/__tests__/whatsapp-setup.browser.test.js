import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Database } from '@youpi/db';
import { createPaymentApp } from '../index.js';
import { AdminServer } from '../../../merchant-admin/src/server.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

test('WhatsApp dashboard pairs, reports delivery errors, persists navigation and disconnects', { timeout: 60000 }, async () => {
  let status = 'DISCONNECTED', failSend = true, failStart = true;
  const berry = {
    getStatus: () => status,
    getClientInfo: () => ({ status, isConnected: status === 'CONNECTED',
      phoneNumber: '919876543210', pairingCode: status === 'PAIRING_CODE_READY' ? '12345678' : null }),
    getQrCode: () => status === 'QR_READY' ? { dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' } : null,
    initialize: async () => {
      if (failStart) throw new Error('WhatsApp could not start.');
      status = 'QR_READY';
    },
    reconnect: async () => { status = 'QR_READY'; },
    requestPairingCode: async phoneNumber => { status = 'PAIRING_CODE_READY'; return { pairingCode: '12345678', phoneNumber }; },
    disconnect: async () => { status = 'DISCONNECTED'; },
    sendMessage: async () => failSend ? { success: false, error: 'Connection closed' } : { success: true, delivered: true }
  };
  const db = new Database({ inMemory: true });
  const app = createPaymentApp(db, { whatsappBerryService: berry });
  await new Promise(r => app.rawServer.listen(0, '127.0.0.1', r));
  const previousPort = process.env.PAYMENT_API_PORT;
  process.env.PAYMENT_API_PORT = String(app.rawServer.address().port);
  const api = `http://127.0.0.1:${app.rawServer.address().port}`;
  const admin = new AdminServer({ db, apiBaseUrl: api }).createServer();
  await new Promise(r => admin.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(token => sessionStorage.setItem('youpi_admin_token', token), TEST_ADMIN_TOKEN);
  const state = expected => page.waitForFunction(s => document.getElementById('waHeaderBadge').dataset.state === s, expected);
  try {
    const unauthorized = await fetch(`${api}/api/v1/admin/whatsapp/reconnect`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    await page.goto(`http://127.0.0.1:${admin.address().port}/#whatsapp`);
    await state('DISCONNECTED');
    assert.equal(await page.locator('#whatsAppSetupCard').isVisible(), true);
    assert.equal(await page.locator('#subViewDevProtocols').isVisible(), false);
    assert.equal(await page.locator('#btnWaTest').isDisabled(), true);
    await page.locator('#btnWaConnect').click();
    await page.waitForFunction(() => document.getElementById('waSetupMessage').textContent === 'WhatsApp could not start.');
    failStart = false;
    await page.locator('#btnWaConnect').click();
    await state('QR_READY');
    assert.equal(await page.locator('#waQrImg').isVisible(), true);
    await page.getByText('Cannot scan? Link using a phone number', { exact: true }).click();
    await page.locator('#waPairingPhone').fill('919876543210');
    await page.locator('#btnWaPair').click();
    await state('PAIRING_CODE_READY');
    assert.equal(await page.locator('#waPairingCode').textContent(), '12345678');
    status = 'CONNECTED';
    await page.getByRole('button', { name: 'Check status', exact: true }).click();
    await state('CONNECTED');
    assert.equal(await page.locator('#waQrBox').isVisible(), false);
    assert.equal(await page.locator('#waPairingCodeBox').isVisible(), false);
    await page.locator('#waTestPhone').fill('919876543211');
    await page.locator('#btnWaTest').click();
    await page.waitForFunction(() => document.getElementById('waTestResult').textContent === 'Connection closed');
    failSend = false;
    await page.locator('#btnWaTest').click();
    await page.waitForFunction(() => document.getElementById('waTestResult').textContent.startsWith('Message sent.'));
    await page.reload();
    await state('CONNECTED');
    assert.equal(await page.locator('#whatsAppSetupCard').isVisible(), true);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#btnWaDisconnect').click();
    await state('DISCONNECTED');
    await page.locator('#mainNavAmazonPay').click();
    await page.locator('#mainNavWhatsApp').click();
    assert.equal(new URL(page.url()).hash, '#whatsapp');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.destroy();
    admin.closeAllConnections(); app.rawServer.closeAllConnections();
    await Promise.all([new Promise(r => admin.close(r)), new Promise(r => app.rawServer.close(r))]);
    db.close();
    if (previousPort === undefined) delete process.env.PAYMENT_API_PORT;
    else process.env.PAYMENT_API_PORT = previousPort;
  }
});
