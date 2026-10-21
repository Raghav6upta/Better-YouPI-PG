# Contributing

Read [licensing status](LICENSING.md), [security](SECURITY.md), and [the architecture](docs/AMAZON_PAY.md) first.

Use Node 24, run `npm ci`, and work on a branch. Installation applies the WhatsApp logging patch; do not disable it. Use synthetic accounts and receipts in tests.

Before opening a pull request:

```sh
npm test
npm run test:amazon
npm run test:whatsapp
git diff --check
```

Browser tests need Edge on Windows or Playwright Chromium on other platforms. Install Chromium with `npx playwright install chromium` if needed.

Describe the problem, resulting behavior, relevant tests and limitations. Keep changes focused. Preserve receipt deduplication, atomic state transitions, OTP attempt limits and signed webhook verification. Never add a public force-success endpoint.

Do not commit account data, environment secrets, browser state, logs, real receipts or screenshots of financial activity. Do not send real messages or payments from automated tests.

New original contributions should be offered under the contribution license documented in LICENSING.md. Preserve upstream notices and dependency licenses.
