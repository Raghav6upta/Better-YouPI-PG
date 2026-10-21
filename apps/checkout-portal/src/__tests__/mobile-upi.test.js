import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import jsQR from 'jsqr';
import { CheckoutServer } from '../server.js';
import { buildUpiUri } from '@youpi/common';

const html = fs.readFileSync(new URL('../views/checkout.html', import.meta.url), 'utf8');
const fixture = () => ({ status: 'ACTIVE', method: 'UPI', payeeVpa: 'test.receiver@apl',
  amount: '1.25', amountPaise: '125', expiresAt: new Date(Date.now() + 300000).toISOString(),
  upiUri: buildUpiUri({ payeeVpa: 'test.receiver@apl', payeeName: 'Test & Shop', amountPaise: 125n, transactionRef: 'ORDER-123' }) });

function pageContext() {
  const elements = new Map();
  const listeners = {};
  const document = { visibilityState: 'visible', addEventListener: (n, f) => { listeners[n] = f; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: false, attrs: {}, handlers: {},
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k] ?? null; }, addEventListener(k, v) { this.handlers[k] = v; } });
      return elements.get(id);
    }
  };
  const context = vm.createContext({ document, URL, Date, console, state: fixture(), currentSelectedMethod: 'UPI',
    refreshes: 0, loadState() { context.refreshes++; },
    window: { addEventListener: (n, f) => { listeners[n] = f; } } });
  vm.runInContext(html.slice(html.indexOf('    // Use exactly the same server-generated URI'), html.indexOf('    function hideAllContent()')), context);
  return { context, document, listeners };
}

test('mobile anchor preserves the complete QR URI, including decoded receiver and amount', () => {
  const { context, document } = pageContext();
  context.updateUpiAppLink(context.state);
  const link = document.getElementById('btnPayWithUpiApp');
  assert.equal(link.getAttribute('href'), context.state.upiUri);
  const params = new URL(link.getAttribute('href')).searchParams;
  assert.equal(params.get('pa'), 'test.receiver@apl');
  assert.equal(params.get('am'), '1.25');
  assert.equal(params.get('pn'), 'Test & Shop');
  let prevented = false;
  link.handlers.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(context.state.status, 'ACTIVE');
  assert.equal(context.refreshes, 0, 'launch stays in the synchronous click, without fetching');
});

test('missing/mismatched receiver, amount, expiry and nonpayable states never expose a link', () => {
  const { context, document } = pageContext();
  for (const patch of [{ payeeVpa: '' }, { upiUri: 'upi://pay?am=1.25' },
    { payeeVpa: 'wrong@upi' }, { amount: '2.00' }, { isBanned: true },
    { expiresAt: new Date(0).toISOString() }, ...['QUEUED','PROCESSING','SUCCESS','FAILED','EXPIRED','CANCELLED','BLOCKED'].map(status => ({ status }))]) {
    context.updateUpiAppLink({ ...fixture(), ...patch });
    assert.equal(document.getElementById('mobileUpiAction').hidden, true);
    assert.equal(document.getElementById('btnPayWithUpiApp').getAttribute('href'), null);
  }
});

test('expiry at tap blocks navigation and returning from an app refreshes without claiming success', () => {
  const { context, document, listeners } = pageContext();
  context.updateUpiAppLink(context.state);
  const link = document.getElementById('btnPayWithUpiApp');
  context.state.expiresAt = new Date(0).toISOString();
  let prevented = false;
  link.handlers.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  context.state = fixture();
  context.updateUpiAppLink(context.state);
  link.handlers.click({ preventDefault() { assert.fail('valid click prevented'); } });
  listeners.focus();
  assert.equal(context.refreshes, 1);
  assert.equal(context.state.status, 'ACTIVE');
  assert.equal(document.getElementById('mobileUpiAction').hidden, true);
});

test('polls are coalesced and an SSE terminal state wins over an older HTTP response', async () => {
  let resolveResponse;
  let calls = 0;
  const context = vm.createContext({ stateRevision: 0, pendingStateLoad: null, checkoutLocked: false, state: fixture(),
    DeviceIdentity: { getOrRegister: async () => {} }, getApiHeaders: () => ({}), API_BASE: '', PAYMENT_ID: 'test',
    dismissSplashScreen() {}, mobileUpi: { clear() {} }, console,
    fetch: async () => { calls++; return new Promise(resolve => { resolveResponse = resolve; }); } });
  const renderPrefix = html.slice(html.indexOf('    function renderState(data) {'), html.indexOf('      const b = data.branding || {};'));
  vm.runInContext(renderPrefix + '\n}', context);
  vm.runInContext(html.slice(html.indexOf('    async function loadState() {'), html.indexOf('    function adjustHexColor(')), context);
  const first = context.loadState(), second = context.loadState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  context.renderState({ ...fixture(), status: 'SUCCESS' });
  resolveResponse({ ok: true, status: 200, json: async () => fixture() });
  await Promise.all([first, second]);
  assert.equal(context.state.status, 'SUCCESS');
  context.renderState(fixture());
  assert.equal(context.state.status, 'SUCCESS', 'a later ACTIVE snapshot cannot undo success');
});

// Rasterize the emitted SVG rectangles and decode using a separate QR library.
function decodeSvg(svg) {
  const modules = Number(svg.match(/viewBox="0 0 (\d+) /)[1]);
  const scale = 6, size = modules * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"/g)) {
    for (let y = Number(match[2])*scale; y < (Number(match[2])+1)*scale; y++) {
      for (let x = Number(match[1])*scale; x < (Number(match[1])+1)*scale; x++) {
        const offset = (y*size+x)*4;
        pixels[offset] = pixels[offset+1] = pixels[offset+2] = 0;
      }
    }
  }
  return jsQR(pixels, size, size)?.data;
}

test('served QR independently decodes to the exact same URI used by the mobile anchor', async t => {
  let state = fixture();
  const app = new CheckoutServer();
  app.fetchPaymentState = async () => state;
  const server = app.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/checkout/test/qr.svg`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const decoded = decodeSvg(await response.text());
  assert.equal(decoded, state.upiUri);
  const page = pageContext();
  page.context.updateUpiAppLink(state);
  assert.equal(decoded, page.document.getElementById('btnPayWithUpiApp').getAttribute('href'));
  assert.equal(new URL(decoded).searchParams.get('pa'), state.payeeVpa);
  for (const patch of [{ upiUri: 'upi://pay?am=1.25' }, { payeeVpa: '' }, { status: 'SUCCESS' }, { amount: '2.00' }]) {
    state = { ...fixture(), ...patch };
    assert.equal((await fetch(url)).status, 409);
  }
  state = null;
  assert.equal((await fetch(url)).status, 503);
});
