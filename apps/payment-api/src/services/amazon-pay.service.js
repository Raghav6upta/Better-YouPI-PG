import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getObserverToken } from '@youpi/common';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { AmazonBrowser } from '../../../amazon-pay-observer/src/browser.js';
import { AmazonObserver } from '../../../amazon-pay-observer/src/observer.js';
import { ReceiptJournal } from '../../../amazon-pay-observer/src/journal.js';
import { createObserverServer } from '../../../amazon-pay-observer/src/index.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function defaultAmazonBrowser(env = process.env) {
  if (['msedge', 'chrome', 'chromium'].includes(env.AMAZON_PAY_BROWSER_CHANNEL)) return env.AMAZON_PAY_BROWSER_CHANNEL;
  if (process.platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
      if (fs.existsSync(path.join(base, 'Microsoft/Edge/Application/msedge.exe'))) return 'msedge';
      if (fs.existsSync(path.join(base, 'Google/Chrome/Application/chrome.exe'))) return 'chrome';
    }
  }
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app')) return 'chrome';
  return 'chromium';
}

// One browser profile and receiving account per gateway host. Credentials remain in
// the local Chromium profile; the dashboard never receives Amazon cookies/passwords.
export class AmazonPayService {
  constructor({ merchantRepo, accountRepo, db, browserFactory = options => new AmazonBrowser(options),
    journalFactory = file => new ReceiptJournal(file), env = process.env, port } = {}) {
    Object.assign(this, { merchantRepo, accountRepo, db, browserFactory, journalFactory, env });
    this.port = port ?? Number(env.AMAZON_PAY_OBSERVER_PORT || 6004);
    this.config = merchantRepo.getDefault()?.branding?.amazonPayConfig || null;
    this.state = this.config ? 'STOPPED' : 'NOT_CONFIGURED';
    if (this.config) this.applyConfig();
  }
  accounts() {
    return this.accountRepo.findByMerchantId(this.merchantRepo.getDefault().id)
      .map(a => ({ id: a.id, upiId: a.upiId, payeeName: a.payeeName, isActive: a.isActive }));
  }
  applyConfig() {
    Object.assign(this.env, { AMAZON_PAY_ENABLED: 'true', AMAZON_PAY_DRY_RUN: String(this.config.mode !== 'live'),
      AMAZON_PAY_MATCHING_MODE: this.config.mode === 'live' ? 'slot' : 'observe',
      AMAZON_PAY_RECEIVING_ACCOUNT_ID: this.config.receivingAccountId, AMAZON_PAY_RECEIVER_VPA: this.config.receiverVpa });
  }
  persist(config) {
    const merchant = this.merchantRepo.getDefault();
    this.merchantRepo.update(merchant.id, { branding: { ...merchant.branding, amazonPayConfig: config } });
    this.config = config;
  }
  idlePayments() {
    if (this.db.queryOne("SELECT id FROM payment_sessions WHERE status IN ('ACTIVE', 'PROCESSING') LIMIT 1")) {
      throw fail('Wait for active payments to finish before changing the Amazon Pay connection.');
    }
  }
  async externalHealth() {
    if (this.server) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
        headers: { Authorization: `Bearer ${getObserverToken()}` }, signal: AbortSignal.timeout(800)
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }
  async status() {
    const external = await this.externalHealth();
    return { config: this.config, accounts: this.accounts(), defaultChannel: defaultAmazonBrowser(this.env), busy: !!this.operation,
      state: this.operation ? this.state : external ? 'EXTERNAL_OBSERVER' : this.observer?.health().state || this.state,
      health: external || this.observer?.health() || null, external: !!external, error: this.error || null };
  }
  account(config = this.config) {
    const account = config?.receivingAccountId && this.accountRepo.findById(config.receivingAccountId);
    if (!account || account.merchantId !== this.merchantRepo.getDefault().id || !account.isActive ||
      account.upiId.trim().toLowerCase() !== config.receiverVpa) throw fail('Select the active receiving UPI account first.', 400);
    return account;
  }
  async save(input) {
    if (this.operation || this.browser || this.observer) throw fail('Stop Amazon Pay before changing its settings.');
    this.operation = this.saveSettings(input);
    try { await this.operation; } finally { this.operation = null; }
  }
  async saveSettings(input) {
    if (await this.externalHealth()) throw fail('Stop the separately running Amazon Pay observer before using dashboard controls.');
    this.idlePayments();
    if (!['observe', 'live'].includes(input.mode) || !['msedge', 'chrome', 'chromium'].includes(input.channel)) throw fail('Invalid mode or browser.', 400);
    if (input.mode === 'live' && input.acceptSlotRisk !== true) throw fail('Acknowledge the matching limitation before enabling live verification.', 400);
    const a = typeof input.receivingAccountId === 'string' && this.accountRepo.findById(input.receivingAccountId);
    const config = { receivingAccountId: a?.id, receiverVpa: a?.upiId?.trim().toLowerCase(),
      mode: input.mode, channel: input.channel, autoStart: false };
    this.account(config);
    this.persist(config);
    this.applyConfig();
    this.state = 'STOPPED'; this.error = null;
  }
  async release() {
    if (this.observer) await this.observer.stop();
    else if (this.browser) await this.browser.close();
    this.observer = null; this.browser = null;
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
  async execute(action, { acceptSlotRisk = false, channel } = {}) {
    if (!['connect', 'enable', 'login', 'start', 'stop', 'scan'].includes(action)) throw fail('Unknown action.', 400);
    if (this.operation) throw fail('Another Amazon Pay action is still running.');
    // Hold the lock across all awaits, including the external-worker check.
    this.operation = (async () => {
      if (await this.externalHealth()) throw fail('Stop the separately running Amazon Pay observer before using dashboard controls.');
      if (action === 'scan') {
        if (!this.observer) throw fail('Start verification first.');
        this.error = null;
        await this.observer.sweep(); return;
      }
      // Resuming the unchanged saved configuration after a crash must also work
      // while an existing checkout is ACTIVE. Changes still require idle slots.
      if (!(action === 'start' && this.config && !this.browser && !this.observer)) this.idlePayments();
      if (action === 'connect') {
        if (!this.config) {
          const account = this.accountRepo.findActiveForMerchant(this.merchantRepo.getDefault().id);
          await this.saveSettings({ receivingAccountId: account?.id, mode: 'observe', channel: channel || defaultAmazonBrowser(this.env) });
        }
        action = 'login';
      }
      const enableLive = action === 'enable';
      if (enableLive && this.config?.mode !== 'live' && acceptSlotRisk !== true) {
        throw fail('Acknowledge the matching limitation before enabling live verification.', 400);
      }
      if (enableLive) action = 'start';
      if (action !== 'stop') this.account();
      this.state = action === 'login' ? 'OPENING_LOGIN' : action === 'start' ? 'STARTING' : 'STOPPING';
      this.error = null;
      await this.release();
      if (action === 'stop') {
        if (this.config) this.persist({ ...this.config, autoStart: false });
        this.state = 'STOPPED'; return;
      }
      if (enableLive) this.persist({ ...this.config, mode: 'live' });
      this.applyConfig();
      this.persist({ ...this.config, autoStart: action === 'start' });
      this.browser = this.browserFactory({
        profileDir: path.resolve(root, this.env.AMAZON_PAY_PROFILE_DIR || 'data/browser-sessions/amazon-pay'),
        headless: action !== 'login', channel: this.config.channel === 'chromium' ? undefined : this.config.channel
      });
      await this.browser.start();
      if (action === 'login') {
        this.browser.context.once('close', () => { if (!this.observer) this.state = 'LOGIN_CLOSED'; });
        await this.browser.page.goto('https://www.amazon.in/pay/history', { waitUntil: 'domcontentloaded' });
        this.state = 'LOGIN_OPEN'; return;
      }
      const apiBaseUrl = this.env.BASE_PAYMENT_API_URL || 'http://127.0.0.1:6100';
      this.observer = new AmazonObserver({ browser: this.browser,
        journal: this.journalFactory(path.join(root, `data/browser-sessions/amazon-pay/receipts-${this.config.mode === 'live' ? 'live' : 'dry-run'}.sqlite`)),
        client: new PaymentObserverClient({ sourceName: 'AMAZON_PAY', apiBaseUrl }),
        receivingAccountId: this.config.receivingAccountId, receiverVpa: this.config.receiverVpa,
        dryRun: this.config.mode !== 'live', canSettle: this.config.mode === 'live',
        hasActivePayment: async () => !!this.db.queryOne("SELECT id FROM payment_sessions WHERE status IN ('ACTIVE', 'PROCESSING') AND receiving_account_id = ? LIMIT 1", [this.config.receivingAccountId])
      });
      this.server = createObserverServer(this.observer);
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.port, '127.0.0.1', resolve);
      });
      this.observer.start();
    })();
    try { await this.operation; }
    catch (error) {
      // Never return browser exception strings: they may contain account data.
      this.error = error.status ? error.message : 'Could not open the Amazon browser. Close any separate Amazon observer or sign-in browser, and check that the selected browser is installed.';
      if (!error.status) { await this.release(); this.state = 'ERROR'; }
      throw fail(this.error, error.status || 503);
    } finally { this.operation = null; }
  }
  async close() {
    if (!this.closePromise) this.closePromise = (async () => {
      await this.operation?.catch(() => {});
      await this.release();
    })();
    return this.closePromise;
  }
}
