# Amazon Pay receipt observer

This observer reads incoming UPI receipts from a dedicated, signed-in Amazon India browser profile. It uses the existing checkout, payment state machine and signed merchant webhooks. Customers do not enter a UTR. Amazon web receipt extraction is browser automation, not an Amazon-signed payment API.

## Requirements

For normal dashboard setup, follow [Amazon Pay + WhatsApp frontend setup](FRONTEND_SETUP.md). The standalone commands below are for observer diagnostics; dashboard users do not need to configure Gmail or SMS.

- Node 24 or later (the repository uses `node:sqlite`).
- `npm ci` from the repository root.
- Installed Edge/Chrome, configured with `AMAZON_PAY_BROWSER_CHANNEL=msedge` or `chrome`; otherwise install Chromium using `npx playwright install chromium`.
- The checkout receiving VPA must be the same VPA visible under **Credited to** in Amazon Pay receipts.
- A dedicated browser profile. Do not point this worker at your everyday browser profile.

## Local read-only trial

Copy the Amazon settings from `.env.example` to a git-ignored `.env.amazon-local`. Set your receiving VPA, the corresponding YouPI receiving account ID and browser channel. Keep `AMAZON_PAY_DRY_RUN=true` and `AMAZON_PAY_MATCHING_MODE=observe`.

```powershell
npm run amazon:login
# Sign in manually, open Amazon Pay history, then close the dedicated browser.
npm run amazon:observe
```

The operator handles passwords, OTPs and any login challenge directly. The worker never solves or bypasses challenges. It reports `LOGIN_REQUIRED` or `PAGE_UNAVAILABLE` when receipts cannot be read. Stop it with Ctrl+C before opening the login browser again: only one process may own a profile.

The observer binds to `127.0.0.1:6004`. Both `GET /health` and `POST /api/sweep` require the existing observer bearer token. Health reports the last complete scan, configured receiver, dry-run status and whether settlement is enabled; it excludes receipt contents. A scan must read a matching receipt before it can verify the account. An empty history therefore reports `ACCOUNT_UNVERIFIED`.

Dry-run stores sanitized receipts locally and sends no observations to the payment API. Names and bank account digits are omitted. Browser cookies, receipt journals and original-draft backups are excluded from Git. Dry-run and live journals are separate, so enabling live mode cannot submit a dry-run backlog.

## Live integration and matching limits

For an operator-controlled ₹1 local test, stop other services on ports 6100, 6105, 7000 and 6004, then run `npm run amazon:trial`. It creates a separate trial database, checks observer readiness, activates a five-minute ₹1 payment, serves the original checkout and a QR/status page at `http://127.0.0.1:6105`, and validates the signed webhook at a local receiver. The operator makes the payment themselves. This command explicitly enables slot matching for that process only; `.env.amazon-local` remains dry-run. The trial result is saved to git-ignored `data/amazon-local-trial.json`. Stop the trial with Ctrl+C before starting another observer/login process.

For the supervised gateway, put settings in `.env` (normal `npm run dev` does not automatically read `.env.amazon-local`). Enable `AMAZON_PAY_ENABLED=true`, choose the exact active receiving account ID/VPA, and restart the services. The supervisor starts Amazon instead of Gmail/SMS. Amazon mode also rejects legacy observer events and removes their checkout health dependency.

The default observe mode cannot settle orders. Automatic attribution requires **both** `AMAZON_PAY_DRY_RUN=false` and `AMAZON_PAY_MATCHING_MODE=slot` on the API and worker. Keep these settings consistent across processes. Confirm live extraction and timing first.

Slot mode deliberately preserves the existing heuristic: active receiving account, exact paise amount, active/processing session, receipt time overlapping the original payment window, and an unused transfer reference. It rejects a receipt whose displayed minute overlaps another same-amount checkout. Receipt time is interpreted as IST with one-minute precision; discovery time is not substituted for transaction time. Expired/cancelled sessions are never revived.

**This is not proof of order identity.** An unrelated same-amount transfer, or a payment using an old saved QR, can still look like the current order. The observed Amazon receipt fields contain a transfer UTR, not a verified YouPI order ID. No order-reference propagation is assumed. Use observe mode until the operator accepts this limitation or a reliable correlation mechanism is added. Ambiguous/unmatched receipts remain recorded and do not produce success. There is no public force-success endpoint.

Receipt consumption, payment settlement, slot release and a durable notification intent commit together. Each transfer can be consumed once. Notification delivery persists before sending and retries after restart; webhook consumers must still deduplicate delivery IDs and verify the HMAC over raw bytes. The webhook includes the UTR and preserves customer metadata. Browser success events remain UI feedback only.

## Polling and failure handling

- Default refresh interval: five seconds while active, thirty seconds idle. End-to-end latency is not guaranteed and requires live measurement.
- Sweep requests join the current scan and are rate limited. Failed scans back off to at most five minutes.
- The reader traverses open shadow roots and assigned slots, visits incoming receipt details, and follows recognized Load more/Show more/Next controls.
- `AMAZON_PAY_MAX_PAGES` bounds scanning (default five); an incomplete backlog reports `BACKLOG` and is not submitted. Selectors/pagination must be verified against the live account layout.
- Unrecognized receipt formats, wrong receivers and future dates fail closed. Failed API submissions remain in the SQLite retry journal across restarts.
- A receipt already read is periodically rechecked to validate the signed-in account. Login/profile state is not inferred from a saved boolean.

## Tests

```powershell
npm run test:amazon
npm test
```

`test:amazon` includes a local HTTP page using web components and slots, a real browser, an in-memory payment API and a local webhook receiver. It requires Edge on Windows or Playwright Chromium elsewhere. It creates no real payment and never visits Amazon. It verifies receipt parsing, matching, duplicate protection, dry-run isolation, rollback, retries/restarts, login failure, source isolation, unchanged checkout response behavior and raw-body webhook signatures.

`npm test` includes the Amazon parser/matcher and journal/scheduler tests alongside the existing regression suites. It does not require a browser for these added suites. Passing fixtures does not establish compatibility with every live Amazon layout or measure banking latency.

## Files

- `apps/amazon-pay-observer/src/browser.js`: browser profile, history traversal, shadow-DOM reader.
- `observer.js`, `journal.js`, `index.js`: scheduling, durable retries, authentication, login and service entry point.
- `packages/core/src/amazon-pay.js`: strict receipt validation and atomic attribution.
- `packages/common/src/amazon-config.js`: explicit observe/slot policy.
- `packages/db/src/sqlite-schema.sql`: receipt identity ledger and notification outbox.
- `packages/core/src/webhook-engine.js`: durable delivery and retry processing.

The pre-existing interrupted draft was preserved under `data/backups/amazon-draft/` before modification.
# Dashboard setup

Open `http://127.0.0.1:6001/#amazon-pay`, unlock it with your admin token, or click **Amazon Pay** in the Merchant Admin's main navigation.

1. Click **Connect Amazon Pay**. YOUPI selects your active receiving UPI account and an installed browser. Complete Amazon sign-in in the dedicated browser on the server computer. Passwords and OTPs are entered only on Amazon.
2. Read and acknowledge the amount/time matching limitation, then click **Enable verification**. YOUPI reuses the saved session and checks receipts. Wait for **Connected** before testing a payment. An unrelated same-amount transfer can still be mistaken for a checkout payment.

The card shows connection errors, login expiry and the last successful check. **Pause** stops polling and disables automatic restart. **Reconnect Amazon Pay** opens sign-in again. Browser selection, observe-only testing, saved settings and manual scanning are under **Advanced settings**. Settings are stored in the gateway database; Amazon cookies remain in the dedicated local profile. Pausing does not fall back to Gmail. Finish active payments before pausing or changing settings.

Starting enables automatic restart with the Payment API. An unchanged saved connection can resume while a checkout remains active after a crash; changing the account or mode is still blocked until active payments finish.

This is one Amazon connection per gateway host, for the default merchant's active receiving account. A remote server needs an interactive desktop for Amazon sign-in. If a CLI observer is already running, stop that observer before using the dashboard; do not run two browsers against the same profile.
