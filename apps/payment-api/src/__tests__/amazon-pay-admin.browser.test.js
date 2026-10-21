import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { Database, ensureDatabaseInitialized, runMigrations, MerchantRepository, ReceivingAccountRepository } from '@youpi/db';
import { AmazonPayService } from '../services/amazon-pay.service.js';
import { createPaymentApp } from '../index.js';
import { AdminServer } from '../../../merchant-admin/src/server.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';
import { receiptText } from '../../../../packages/core/src/__tests__/fixtures/amazon-receipt.js';

test('two-step dashboard connects, enables verification, pauses and resumes without advanced settings', { timeout: 60000 }, async () => {
  const db = new Database({ inMemory: true });
  ensureDatabaseInitialized(db); runMigrations(db);
  const merchantRepo = new MerchantRepository(db), accountRepo = new ReceivingAccountRepository(db);
  const account = accountRepo.findActiveForMerchant(merchantRepo.getDefault().id);
  const opened = [];
  const service = new AmazonPayService({ db, merchantRepo, accountRepo, env: {}, port: 0,
    browserFactory: options => {
      opened.push(options);
      const context = new EventEmitter();
      return { context, page: { goto: async () => {} }, start: async () => {}, close: async () => context.emit('close'),
        scan: async () => ({ receipts: [{ url: 'fixture-receipt', text: receiptText({ receiver: account.upiId }) }], complete: true }) };
    },
    journalFactory: () => ({ knownUrls: () => new Set(), add() {}, pending: () => [], pendingCount: () => 0, close() {} }) });
  const app = createPaymentApp(db, { amazonPayService: service });
  await new Promise(r => app.rawServer.listen(0, '127.0.0.1', r));
  const originalPort = process.env.PAYMENT_API_PORT;
  process.env.PAYMENT_API_PORT = String(app.rawServer.address().port);
  const admin = new AdminServer({ db, apiBaseUrl: `http://127.0.0.1:${app.rawServer.address().port}` }).createServer();
  await new Promise(r => admin.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(token => sessionStorage.setItem('youpi_admin_token', token), TEST_ADMIN_TOKEN);
  const state = value => page.waitForFunction(expected => document.getElementById('amazonPayState').dataset.state === expected, value);
  try {
    await page.goto(`http://127.0.0.1:${admin.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#mainNavAmazonPay').click();
    assert.equal(new URL(page.url()).hash, '#amazon-pay');
    await state('NOT_CONFIGURED');
    assert.equal(await page.locator('#amazonPaySave').isVisible(), false);
    assert.equal(await page.locator('#amazonPayEnable').isDisabled(), true);
    await page.locator('#amazonPayLogin').click();
    await state('LOGIN_OPEN');
    assert.equal(service.config.receiverVpa, account.upiId.toLowerCase());
    assert.equal(opened[0].headless, false);
    assert.equal(await page.locator('#amazonPayEnable').isDisabled(), true);
    await page.locator('#amazonPayRisk').check();
    await page.locator('#amazonPayEnable').click();
    await state('READY');
    assert.equal(opened[1].headless, true);
    assert.equal(service.config.mode, 'live');
    assert.match(await page.locator('#amazonPayMessage').textContent(), /Incoming UPI payments can now be verified/);
    assert.equal(service.config.autoStart, true);
    await page.locator('#amazonPayStop').click();
    await state('STOPPED');
    assert.equal(service.config.autoStart, false);
    await page.locator('#amazonPayEnable').click();
    await state('READY');
    await page.reload();
    await state('READY');
    assert.equal(await page.locator('#amazonPayCard').isVisible(), true);
    assert.equal(await page.locator('#subViewOpsObservers').isVisible(), false);
    assert.equal(await page.locator('#amazonPayAccount').inputValue(), account.id);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Dashboard test state:', await service.status(), await page.locator('#amazonPayMessage').textContent());
    throw error;
  } finally {
    await browser.close(); app.destroy(); await service.close();
    admin.closeAllConnections(); app.rawServer.closeAllConnections();
    await Promise.all([new Promise(r => admin.close(r)), new Promise(r => app.rawServer.close(r))]); db.close();
    if (originalPort === undefined) delete process.env.PAYMENT_API_PORT;
    else process.env.PAYMENT_API_PORT = originalPort;
  }
});
