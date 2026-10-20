import { chromium } from 'playwright';

// Traverse the rendered component tree, including assigned slots, without duplicating light DOM.
export function composedText(root) {
  const parts = [];
  function visit(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.trim();
      if (text) parts.push(text);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName) || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return;
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      for (const child of assigned.length ? assigned : node.childNodes) visit(child);
    } else {
      for (const child of (node.shadowRoot || node).childNodes) visit(child);
    }
  }
  visit(root);
  return parts.join('\n').replace(/₹\s*\n\s*/g, '₹');
}

export class AmazonBrowser {
  constructor({ profileDir, headless = true, channel, baseUrl = 'https://www.amazon.in', maxPages = 5, maxReceipts = 100 } = {}) {
    Object.assign(this, { profileDir, headless, channel, baseUrl, maxPages, maxReceipts });
  }

  async start() {
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless, ...(this.channel ? { channel: this.channel } : {}),
      locale: 'en-IN', timezoneId: 'Asia/Kolkata', acceptDownloads: false
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
    this.detail = await this.context.newPage();
    this.detail.setDefaultTimeout(10_000);
  }

  async history() {
    const response = await this.page.goto(`${this.baseUrl}/pay/history`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (response?.status() >= 500 || response?.status() === 429) throw new Error('AMAZON_TEMPORARILY_UNAVAILABLE');
    const current = new URL(this.page.url());
    if (current.origin !== new URL(this.baseUrl).origin || current.pathname !== '/pay/history') throw new Error('LOGIN_REQUIRED');
    try {
      await this.page.locator('#payui-transaction-history-page').waitFor({ state: 'visible' });
    } catch { throw new Error('HISTORY_UNAVAILABLE_OR_CHALLENGE'); }
  }

  async scan(known = new Set()) {
    await this.history();
    const receipts = [];
    const visited = new Set();
    let checkedKnown = false;
    let complete = false;
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber++) {
      const cards = this.page.locator('#payui-transaction-history-page .transaction-item');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const text = await card.evaluate(composedText);
        if (!/\bReceived\b/i.test(text)) continue;
        const link = card.locator('a[href*="/pay/transaction-details"]').first();
        let url;
        if (await link.count()) url = new URL(await link.getAttribute('href'), this.baseUrl).href;
        else {
          // Some Amazon component versions navigate from the card itself.
          await card.click();
          await this.page.waitForURL('**/pay/transaction-details**');
          url = this.page.url();
          await this.page.goBack({ waitUntil: 'domcontentloaded' });
          await this.page.locator('#payui-transaction-history-page').waitFor();
        }
        const parsed = new URL(url);
        if (parsed.origin !== new URL(this.baseUrl).origin || parsed.pathname !== '/pay/transaction-details') throw new Error('UNEXPECTED_RECEIPT_URL');
        if (visited.has(url) || (known.has(url) && checkedKnown)) continue;
        if (known.has(url)) checkedKnown = true;
        visited.add(url);
        if (receipts.length >= this.maxReceipts) return { receipts, complete: false };
        const response = await this.detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (response?.status() >= 500 || response?.status() === 429) throw new Error('AMAZON_TEMPORARILY_UNAVAILABLE');
        if (new URL(this.detail.url()).origin !== parsed.origin || new URL(this.detail.url()).pathname !== parsed.pathname) throw new Error('LOGIN_REQUIRED');
        const root = this.detail.locator('#payui-transaction-receipt-id');
        await root.waitFor({ state: 'visible' });
        receipts.push({ url, text: await root.evaluate(composedText) });
      }
      const more = this.page.getByRole('button', { name: /^(load more|show more|next)$/i }).first();
      if (!await more.count() || !await more.isVisible() || !await more.isEnabled()) { complete = true; break; }
      const previous = await cards.allTextContents();
      await more.click();
      // Wait for newly rendered cards, not an arbitrary sleep after clicking.
      await this.page.waitForFunction(({ count, previous }) => {
        function collect(root) {
          const cards = [...root.querySelectorAll('.transaction-item')];
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) cards.push(...collect(el.shadowRoot));
          return cards;
        }
        const cards = collect(document);
        return cards.length !== count || JSON.stringify(cards.map(c => c.textContent)) !== JSON.stringify(previous);
      }, { count, previous }, { timeout: 10_000 });
    }
    return { receipts, complete };
  }

  async close() { await this.context?.close(); }
}
