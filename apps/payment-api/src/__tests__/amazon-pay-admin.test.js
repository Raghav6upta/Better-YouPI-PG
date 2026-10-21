import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Database, ensureDatabaseInitialized, runMigrations, MerchantRepository, ReceivingAccountRepository, PaymentSessionRepository } from '@youpi/db';
import { AmazonPayService } from '../services/amazon-pay.service.js';
import { createPaymentApp } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

function fixture() {
  const db = new Database({ inMemory: true });
  ensureDatabaseInitialized(db); runMigrations(db);
  const merchantRepo = new MerchantRepository(db), accountRepo = new ReceivingAccountRepository(db);
  const account = accountRepo.findActiveForMerchant(merchantRepo.getDefault().id);
  const browsers = [];
  const options = { db, merchantRepo, accountRepo, env: {}, port: 0,
    browserFactory: config => {
      const browser = { config, context: new EventEmitter(), page: { goto: async () => {} },
        start: async () => {}, close: async () => { browser.closed = true; browser.context.emit('close'); },
        scan: async () => ({ receipts: [], complete: true }) };
      browsers.push(browser); return browser;
    },
    journalFactory: () => ({ knownUrls: () => new Set(), pending: () => [], pendingCount: () => 0, close() {} }) };
  return { db, account, browsers, options, service: new AmazonPayService(options),
    config: { receivingAccountId: account.id, mode: 'observe', channel: 'msedge' } };
}

test('Amazon checkout state includes the configured receiver in its canonical UPI URI and preserves the snapshot', async t => {
  const priorEnv = Object.fromEntries(['AMAZON_PAY_ENABLED', 'AMAZON_PAY_OBSERVER_PORT'].map(key => [key, process.env[key]]));
  const f = fixture();
  const app = createPaymentApp(f.db, { amazonPayService: f.service });
  await new Promise(resolve => app.rawServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.rawServer.address().port}`;
  t.after(async () => {
    await app.destroy();
    await new Promise(resolve => app.rawServer.close(resolve));
    f.db.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const post = (path, body) => authFetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const receiver = 'amazon-test.receiver@apl';
  const settings = await post('/api/v1/admin/upi-settings', { upiId: receiver, payeeName: 'Fixture Amazon Store' });
  assert.equal(settings.status, 200);
  await f.service.save(f.config);
  await f.service.execute('start');
  process.env.AMAZON_PAY_ENABLED = 'true';
  process.env.AMAZON_PAY_OBSERVER_PORT = String(f.service.server.address().port);

  const created = await post('/api/v1/payments', { orderId: 'AMAZON-URI-FIXTURE', amount: '1.25', autoActivate: true });
  assert.equal(created.status, 201);
  const { paymentId } = await created.json();
  const readState = async () => {
    const response = await fetch(`${base}/api/v1/checkout/${paymentId}/state`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const active = await readState();
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.payeeVpa, receiver);
  const uri = new URL(active.upiUri);
  assert.equal(uri.protocol, 'upi:');
  assert.equal(uri.hostname, 'pay');
  assert.equal(uri.searchParams.get('pa'), receiver);
  assert.equal(uri.searchParams.get('pn'), 'Fixture Amazon Store');
  assert.equal(uri.searchParams.get('am'), '1.25');
  assert.equal(uri.searchParams.get('cu'), 'INR');
  assert.equal(uri.searchParams.get('tn'), 'AMAZON-URI-FIXTURE');

  // Bypass the normal busy-account update guard to verify the immutable checkout snapshot.
  f.db.execute('UPDATE payment_receiving_accounts SET upi_id = ? WHERE id = ?', ['changed-after-start@apl', f.account.id]);
  const unchanged = await readState();
  assert.equal(unchanged.payeeVpa, receiver);
  assert.equal(unchanged.upiUri, active.upiUri);
});

test('Amazon dashboard lifecycle persists config, releases login profile, and stops without fallback', async t => {
  const f = fixture();
  t.after(async () => { await f.service.close(); f.db.close(); });
  await f.service.save(f.config);
  assert.equal(f.options.env.AMAZON_PAY_ENABLED, 'true');
  assert.equal(f.options.env.AMAZON_PAY_DRY_RUN, 'true');
  const restored = new AmazonPayService(f.options);
  assert.equal(restored.config.receivingAccountId, f.account.id);
  await f.service.execute('login');
  assert.equal((await f.service.status()).state, 'LOGIN_OPEN');
  assert.equal(f.browsers[0].config.headless, false);
  await assert.rejects(f.service.save(f.config), /Stop Amazon Pay/);
  await f.service.execute('start');
  assert.equal(f.browsers[0].closed, true);
  assert.equal(f.browsers[1].config.headless, true);
  assert.equal(f.service.config.autoStart, true);
  assert.ok(f.service.server.listening);
  await f.service.execute('stop');
  assert.equal(f.service.config.autoStart, false);
  assert.equal(f.service.state, 'STOPPED');
  assert.equal(f.options.env.AMAZON_PAY_ENABLED, 'true');
});

test('Amazon dashboard validates account, live consent, and concurrent commands', async t => {
  const f = fixture();
  t.after(async () => { await f.service.close(); f.db.close(); });
  await assert.rejects(f.service.save({ ...f.config, receivingAccountId: 'missing' }), /active receiving/);
  await assert.rejects(f.service.save({ ...f.config, mode: 'live' }), /Acknowledge/);
  await f.service.save({ ...f.config, mode: 'live', acceptSlotRisk: true });
  assert.equal(f.options.env.AMAZON_PAY_MATCHING_MODE, 'slot');
  const login = f.service.execute('login');
  await assert.rejects(f.service.execute('start'), /still running/);
  await login;
  f.service.idlePayments = () => { throw Object.assign(new Error('active payments'), { status: 409 }); };
  await assert.rejects(f.service.execute('stop'), /active payments/);
  assert.equal(f.browsers[0].closed, undefined);
});

test('Amazon dashboard HTTP endpoints require admin auth and parse settings/actions', async t => {
  const f = fixture();
  const app = createPaymentApp(f.db, { amazonPayService: f.service });
  await new Promise(resolve => app.rawServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.rawServer.address().port}/api/v1/admin/amazon-pay`;
  t.after(async () => { app.destroy(); await f.service.close(); await new Promise(r => app.rawServer.close(r)); f.db.close(); });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url + '/action', { method: 'POST', body: '{"action":"login"}' })).status, 401);
  const save = await authFetch(url + '/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.config) });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).config.receiverVpa, f.account.upiId.toLowerCase());
  const action = await authFetch(url + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"login"}' });
  assert.equal(action.status, 202);
  await f.service.operation;
  assert.equal((await (await authFetch(url)).json()).state, 'LOGIN_OPEN');
});

test('Connect chooses the active account; enabling live verification requires acknowledgement', async t => {
  const f = fixture();
  t.after(async () => { await f.service.close(); f.db.close(); });
  await f.service.execute('connect', { channel: 'msedge' });
  assert.equal(f.service.config.receivingAccountId, f.account.id);
  assert.equal(f.service.config.mode, 'observe');
  assert.equal(f.service.state, 'LOGIN_OPEN');
  await assert.rejects(f.service.execute('enable'), /Acknowledge/);
  assert.equal(f.service.config.mode, 'observe');
  await f.service.execute('enable', { acceptSlotRisk: true });
  assert.equal(f.service.config.mode, 'live');
  assert.equal(f.service.config.autoStart, true);
  assert.equal(f.browsers[0].closed, true);
  assert.equal(f.browsers[1].config.headless, true);
  assert.equal(f.options.env.AMAZON_PAY_MATCHING_MODE, 'slot');
  await f.service.observer.inFlight;
  assert.equal(f.service.observer.health().status, 'DOWN'); // No valid receipt in this fixture.
});

test('saved observer resumes after a crash with an active payment; changing mode/account remains blocked', async t => {
  const f = fixture();
  let resumed;
  t.after(async () => { await resumed?.close(); await f.service.close(); f.db.close(); });
  await f.service.save(f.config);
  await f.service.execute('start');
  const sessions = new PaymentSessionRepository(f.db);
  const payment = sessions.create({ merchantId: f.account.merchantId, receivingAccountId: f.account.id,
    orderId: 'RESTART-ACTIVE', amountPaise: 100n });
  sessions.acquireSlotAtomic(payment.id, f.account.id, 300000);
  await f.service.close(); // Graceful teardown preserves the same autoStart setting as a crash.
  resumed = new AmazonPayService(f.options);
  assert.equal(resumed.config.autoStart, true);
  assert.equal(sessions.findById(payment.id).status, 'ACTIVE');
  await resumed.execute('start');
  assert.ok(resumed.server.listening);
  assert.equal(resumed.config.mode, 'observe');
  assert.equal(sessions.findById(payment.id).status, 'ACTIVE');
  await assert.rejects(resumed.execute('enable', { acceptSlotRisk: true }), /active payments/);
  await assert.rejects(resumed.execute('connect'), /active payments/);
  await assert.rejects(resumed.execute('stop'), /active payments/);
  assert.equal(resumed.config.mode, 'observe');
});
