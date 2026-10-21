import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { createPaymentApp } from '../index.js';
import { Database } from '@youpi/db';
import { authFetch } from '../../../../scripts/test-support.js';
import { formatQrDataUrl } from '../services/whatsapp-berry.service.js';

test('WhatsApp QR preserves the exact SDK payload', async () => {
  const raw = '2@reference,public-key,identity-key,secret';
  let encoded;
  const qr = await formatQrDataUrl(raw, { toDataURL: async value => {
    encoded = value;
    return 'data:image/png;base64,fixture';
  } });
  assert.equal(encoded, raw);
  assert.match(qr, /^data:image/);
});

test('checkout requires real WhatsApp dispatch and supports signup without email', async t => {
  const previous = process.env.YOUPI_EXPOSE_DEV_OTP;
  process.env.YOUPI_EXPOSE_DEV_OTP = 'false';
  const db = new Database({ inMemory: true });
  let dispatch = { success: false, delivered: false };
  const issued = new Map();
  const berry = { sendOtp: async (phone, otp) => {
    issued.set(phone, otp);
    if (dispatch instanceof Error) throw dispatch;
    return dispatch;
  } };
  const app = createPaymentApp(db, { whatsappBerryService: berry });
  await new Promise(resolve => app.rawServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.rawServer.address().port}/api/v1/customer`;
  const post = (route, body) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  t.after(async () => {
    await app.destroy(); app.rawServer.closeAllConnections();
    await new Promise(resolve => app.rawServer.close(resolve)); db.close();
    if (previous === undefined) delete process.env.YOUPI_EXPOSE_DEV_OTP;
    else process.env.YOUPI_EXPOSE_DEV_OTP = previous;
  });
  for (const [i, outcome] of [
    { success: false, delivered: false },
    { success: true, delivered: true, simulated: true },
    new Error('Connection closed')
  ].entries()) {
    dispatch = outcome;
    const mobileNumber = `987654320${i}`;
    const response = await post('send-otp', { mobileNumber, name: 'Test Customer', isNewUser: true });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'OTP_DELIVERY_UNAVAILABLE');
    assert.equal(body.devOtp, undefined);
    assert.equal((await post('verify-otp', { mobileNumber, otp: issued.get(mobileNumber) })).status, 400);
  }
  dispatch = { success: true, delivered: true };
  const mobileNumber = '9876543219';
  const sent = await post('send-otp', { mobileNumber, name: 'WhatsApp Customer', isNewUser: true });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).devOtp, undefined);
  const verified = await post('verify-otp', { mobileNumber, otp: issued.get(mobileNumber) });
  assert.equal(verified.status, 200);
  assert.ok((await verified.json()).token);

  // A failed delivery must also invalidate an existing customer's challenge.
  const future = Date.now() + 31_000;
  t.mock.method(Date, 'now', () => future);
  dispatch = { success: false, delivered: false };
  assert.equal((await post('send-otp', { mobileNumber })).status, 503);
  assert.equal((await post('verify-otp', { mobileNumber, otp: issued.get(mobileNumber) })).status, 400);
});

test('WhatsApp Berry Protocol OTP Customer Auth & Merchant Configuration Suite', async (t) => {
  const customDb = new Database({ inMemory: true });
  // Exercise HTTP/auth behavior without starting a real WhatsApp client or pairing a phone.
  let berryStatus = 'DISCONNECTED';
  const berry = {
    getStatus: () => berryStatus,
    getClientInfo: () => ({ status: berryStatus, platform: 'BerryProtocol v0.1.10', isConnected: false }),
    getQrCode: () => berryStatus === 'DISCONNECTED' ? null : { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    initialize: async () => { berryStatus = 'AWAITING_SCAN'; },
    reconnect: async () => { berryStatus = 'AWAITING_SCAN'; },
    requestPairingCode: async phoneNumber => ({ pairingCode: '12345678', phoneNumber }),
    disconnect: async () => { berryStatus = 'DISCONNECTED'; },
    sendOtp: async () => ({ success: true, delivered: false, simulated: true })
  };
  const app = createPaymentApp(customDb, { whatsappBerryService: berry });
  const testPort = 6288;

  const serverInstance = await new Promise(resolve => {
    const s = app.rawServer.listen(testPort, () => resolve(s));
  });

  t.after(async () => {
    app.destroy();
    await new Promise(resolve => serverInstance.close(resolve));
    customDb.close();
  });

  const apiBase = `http://localhost:${testPort}`;

  await t.test('1. POST /api/v1/customer/check-user identifies new unregistered mobile', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.exists, false);
    assert.equal(data.mobileNumber, '9123456789');
    assert.equal(data.customer, null);
  });

  await t.test('2. POST /api/v1/customer/check-user rejects malformed phone numbers', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '123' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  let signupOtp = null;

  await t.test('3. POST /api/v1/customer/send-otp creates challenge for new customer signup', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        name: 'Rohan Sharma',
        email: 'rohan@sharma.local',
        isNewUser: true
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mobileNumber, '9123456789');
    assert.ok(data.devOtp);
    assert.equal(data.devOtp.length, 6);
    signupOtp = data.devOtp;
  });

  await t.test('4. POST /api/v1/customer/verify-otp rejects incorrect OTP code', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: '000000'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Invalid'));
  });

  let authToken = null;
  let customerId = null;

  await t.test('5. POST /api/v1/customer/verify-otp completes signup and issues session token', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: signupOtp
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token);
    assert.equal(data.customer.name, 'Rohan Sharma');
    assert.equal(data.customer.email, 'rohan@sharma.local');
    assert.equal(data.customer.mobileNumber, '9123456789');

    authToken = data.token;
    customerId = data.customerId;
  });

  await t.test('6. POST /api/v1/customer/check-user detects now-existing customer', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.exists, true);
    assert.equal(data.customer.name, 'Rohan Sharma');
  });

  let loginOtp = null;

  await t.test('resending an OTP during the cooldown is rejected', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 429);
  });

  await t.test('7. POST /api/v1/customer/send-otp dispatches WhatsApp OTP for existing user', async (t) => {
    const afterCooldown = Date.now() + 31_000;
    t.mock.method(Date, 'now', () => afterCooldown);
    const res = await authFetch(`${apiBase}/api/v1/customer/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.devOtp);
    loginOtp = data.devOtp;
  });

  await t.test('8. POST /api/v1/customer/verify-otp logs in existing user', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: loginOtp
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token);
    assert.equal(data.customer.id, customerId);
  });

  await t.test('9. Merchant WhatsApp status API responds with BerryProtocol metadata', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.platform, 'BerryProtocol v0.1.10');
    assert.ok(data.status);
  });

  await t.test('10. Merchant WhatsApp reconnect API triggers pairing QR code generation', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.qrCode);
  });

  await t.test('11. Merchant WhatsApp pairing-code API accepts phone and returns 8-digit code', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/pairing-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '918796266491' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.pairingCode);
  });

  await t.test('12. Merchant WhatsApp disconnect API safely clears session', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'DISCONNECTED');
  });
});
