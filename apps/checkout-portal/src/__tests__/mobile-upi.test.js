import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../views/checkout.html', import.meta.url), 'utf8');
const logic = html.slice(html.indexOf("    let currentSelectedMethod = 'UPI';"),
  html.indexOf('    function hideAllContent()'));
function fixture(userAgent = 'Android Mobile') {
  const elements = Object.fromEntries(['mobileUpiAction', 'btnPayWithUpiApp', 'mobileUpiHelp', 'viewUpiContent']
    .map(id => [id, { hidden: false, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; }, hasAttribute(k) { return k in this.attributes; } }]));
  const state = { status: 'ACTIVE', method: 'UPI', expiresAt: new Date(Date.now() + 300000).toISOString(),
    upiUri: 'upi://pay?pa=fixture%40upi&pn=Test&am=1.00&tn=ORDER-1' };
  let refreshes = 0;
  const context = vm.createContext({ URL, Date, navigator: { userAgent }, state,
    document: { getElementById: id => elements[id], addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} }, loadState: () => refreshes++ });
  vm.runInContext(logic, context);
  return { context, state, elements, refreshes: () => refreshes };
}

test('mobile link preserves the server URI; desktop and ineligible sessions cannot launch', () => {
  const f = fixture();
  f.context.updateMobileUpiAction(f.state);
  assert.equal(f.elements.btnPayWithUpiApp.attributes.href, f.state.upiUri);
  for (const status of ['INITIATED', 'QUEUED', 'PROCESSING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED']) {
    f.context.updateMobileUpiAction({ ...f.state, status });
    assert.equal(f.elements.mobileUpiAction.hidden, true, status);
    assert.equal(f.elements.btnPayWithUpiApp.attributes.href, undefined);
  }
  for (const change of [{ method: 'COD' }, { isBanned: true }, { fraudDetected: true },
    { expiresAt: new Date(Date.now() - 1).toISOString() }, { upiUri: null },
    { upiUri: 'javascript:alert(1)' }, { upiUri: 'https://example.com' }, { upiUri: 'upi://pay' }]) {
    assert.equal(f.context.mobileUpiUri({ ...f.state, ...change }), null);
  }
  assert.equal(fixture('Desktop').context.mobileUpiUri(f.state), null);
  assert.equal(fixture('iPhone').context.mobileUpiUri(f.state), f.state.upiUri);
});

test('tap and app return do not declare payment success; expired taps are blocked', () => {
  const f = fixture();
  f.context.updateMobileUpiAction(f.state);
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  assert.equal(f.context.openMobileUpiApp(event), true);
  assert.equal(prevented, false);
  assert.equal(f.state.status, 'ACTIVE');
  f.context.refreshAfterUpiApp();
  assert.equal(f.refreshes(), 1);
  assert.equal(f.elements.mobileUpiAction.hidden, true);
  assert.equal(f.state.status, 'ACTIVE');
  f.context.updateMobileUpiAction(f.state);
  f.state.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(f.context.openMobileUpiApp(event), false);
  assert.equal(prevented, true);
  assert.equal(f.elements.btnPayWithUpiApp.attributes.href, undefined);
});
