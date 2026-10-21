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
# Upstream sync and mobile QR checkout

- Synced upstream `youpi-pg/YouPI-PG` through `90eecd5` (21 October 2026), including payment-state hardening, verification rejection handling, shared QR generation, merchant iframe configuration and checkout partials.
- Retained dashboard-managed Amazon Pay and WhatsApp OTP. The consolidated observer poller skips SMS/Gmail in Amazon mode, and the durable Amazon webhook outbox remains enabled.
- Added a mobile button whose link is identical to the QR payload. Added checks for receiving UPI ID, amount, expiry, app return and stale state responses.
- Removed invented QR fallback details, added a white QR border, and fixed duplicate layout wrappers introduced by the upstream template extraction that collapsed the desktop checkout.
- Upstream Docker files are included, but Amazon sign-in still requires a supported browser and desktop. The Alpine image has not been validated for the Amazon browser workflow; use the documented host installation for Amazon Pay. The image includes the Amazon workspace manifest and runs the logging protection patch.

On 21 October 2026, the operator paid ₹1 using the real checkout QR and Amazon verification marked it successful. The local webhook was initially blocked by the private-address URL guard; after explicitly allowing the loopback test receiver, the existing verified payment was resent and its signature and amount were verified. Real phone app launch remains an operator acceptance check.
