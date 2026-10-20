# Experimental beta preparation

## Added

- Amazon Pay incoming UPI receipt observer with shadow-DOM extraction, receiver validation, deduplication and retry handling.
- Amazon Pay dashboard connection and saved-session restart recovery.
- Dedicated WhatsApp OTP dashboard with QR/phone linking and a test-message control.
- Atomic receipt consumption and durable webhook outbox delivery.
- Logging protection for the reviewed Signal dependency, applied at installation and checked at runtime.
- Public setup, architecture, comparison, security and contribution documentation.
- Windows/Linux GitHub Actions test configuration.

## Fixed

- Checkout no longer reports successful OTP dispatch when no real message was sent.
- Failed OTP delivery invalidates the challenge.
- Signup email is optional for WhatsApp authentication.
- WhatsApp QR rendering preserves the SDK's original payload.
- Saved WhatsApp metadata reports connecting until the socket actually opens.
- Explicit Amazon wallet credits do not invalidate otherwise valid UPI receipt scans.
- A new dashboard-managed setup does not start a competing standalone Amazon browser.

## Validation

- Clean `npm ci` applies the dependency patch and installs the native WhatsApp SQLite module.
- 36 curated regression suites pass.
- 21 Amazon tests and 17 WhatsApp tests pass.
- A controlled live test completed WhatsApp login, UPI payment, Amazon receipt attribution and verified signed webhook delivery.
- A live WhatsApp reconnect after the logging fix emitted only gateway status messages.
- A fresh public clone starts the API, checkout, admin and demo services without existing account credentials. The admin token is created at startup; Amazon and WhatsApp wait for the operator to connect them.

Hosted Windows and Linux CI passed for the published beta. Check [GitHub Actions](https://github.com/Raghav6upta/Better-YouPI-PG/actions) for the result on the latest commit.

## Release limitations

This is an experimental beta, not production certification. See the same-amount attribution limitation in [Amazon architecture](AMAZON_PAY.md), dependency/session cautions in [security](../SECURITY.md), and the unresolved whole-project license in [licensing status](../LICENSING.md).
