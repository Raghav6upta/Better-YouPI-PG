# Start here

Better-YouPI-PG is an experimental Amazon Pay + WhatsApp fork of YouPI PG.

1. Read [README](README.md) for requirements, quickstart and limitations.
2. Follow [frontend setup](docs/FRONTEND_SETUP.md) to connect Amazon Pay and WhatsApp yourself.
3. Read [what changed](docs/WHY_THIS_FORK.md) for the comparison with the upstream baseline.
4. Read [security](SECURITY.md) before sharing logs or deploying a server.
5. Review [licensing status](LICENSING.md) before redistribution.

The local live test completed WhatsApp login, a small UPI payment, Amazon receipt matching and signed webhook verification. This demonstrates one working path, not production reliability. Personal identifiers, financial references and local machine paths are intentionally omitted.

Run `npm test`, `npm run test:amazon`, and `npm run test:whatsapp` for repeatable automated checks. These tests use fixtures; they do not send real payments.
