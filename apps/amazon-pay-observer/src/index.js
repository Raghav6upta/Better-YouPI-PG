import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getAmazonPayConfig, getObserverToken, hasBearer } from '@youpi/common';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { AmazonBrowser } from './browser.js';
import { ReceiptJournal } from './journal.js';
import { AmazonObserver } from './observer.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export function createObserverServer(observer) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!hasBearer(req, getObserverToken())) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.end(JSON.stringify(observer.health())); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sweep') {
      // Scheduler coalesces requests; never keep an HTTP request open for a browser scan.
      void observer.sweep();
      res.writeHead(202); res.end(JSON.stringify({ accepted: true })); return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });
}

export async function main() {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const login = process.argv.includes('--login');
  const config = getAmazonPayConfig();
  const browser = new AmazonBrowser({
    profileDir: path.resolve(root, process.env.AMAZON_PAY_PROFILE_DIR || 'data/browser-sessions/amazon-pay'),
    headless: !login, channel: process.env.AMAZON_PAY_BROWSER_CHANNEL || undefined,
    maxPages: Number(process.env.AMAZON_PAY_MAX_PAGES || 5)
  });
  await browser.start();
  if (login) {
    await browser.page.goto('https://www.amazon.in/pay/history', { waitUntil: 'domcontentloaded' });
    console.log('[Amazon Pay] Sign in in the dedicated browser, then close that browser before starting the observer.');
    return;
  }
  const receivingAccountId = process.env.AMAZON_PAY_RECEIVING_ACCOUNT_ID;
  const receiverVpa = process.env.AMAZON_PAY_RECEIVER_VPA;
  if (!config.enabled || !receivingAccountId || !receiverVpa) {
    await browser.close();
    throw new Error('Set AMAZON_PAY_ENABLED, AMAZON_PAY_RECEIVING_ACCOUNT_ID and AMAZON_PAY_RECEIVER_VPA in .env');
  }
  const apiBaseUrl = (process.env.BASE_PAYMENT_API_URL || 'http://127.0.0.1:6100').replace(/\/$/, '');
  const journal = new ReceiptJournal(path.join(root, `data/browser-sessions/amazon-pay/receipts-${config.dryRun ? 'dry-run' : 'live'}.sqlite`));
  const observer = new AmazonObserver({ browser, journal, receivingAccountId, receiverVpa,
    dryRun: config.dryRun, canSettle: config.canSettle,
    intervalMs: Number(process.env.AMAZON_PAY_POLL_INTERVAL_MS || 5000),
    idleIntervalMs: Number(process.env.AMAZON_PAY_IDLE_INTERVAL_MS || 30000),
    client: new PaymentObserverClient({ sourceName: 'AMAZON_PAY', apiBaseUrl }),
    hasActivePayment: async () => {
      const response = await fetch(`${apiBaseUrl}/api/v1/pollers/active-window`, {
        headers: { Authorization: `Bearer ${getObserverToken()}` }, signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) throw new Error('API unavailable');
      return (await response.json()).sessions.some(s => s.receivingAccountId === receivingAccountId);
    }
  });
  const server = createObserverServer(observer);
  if (process.argv.includes('--once')) {
    try {
      const health = await observer.sweep();
      console.log(JSON.stringify({ ...health, receiverVpa: '[configured]', receivingAccountId: '[configured]' }));
      process.exitCode = health.status === 'UP' ? 0 : 1;
    } finally { await observer.stop(); }
    return;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.AMAZON_PAY_OBSERVER_PORT || 6004), '127.0.0.1', resolve);
  });
  observer.start();
  console.log(`[Amazon Pay] Observer running (${config.dryRun ? 'dry-run' : config.matchingMode}); health on loopback port ${server.address().port}`);
  const stop = async () => { server.close(); await observer.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { server, observer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[Amazon Pay]', error.message); process.exitCode = 1; });
}
