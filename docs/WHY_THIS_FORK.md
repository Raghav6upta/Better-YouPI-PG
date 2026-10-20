# Why Better-YouPI-PG?

This fork targets a specific setup: receive UPI payments through Amazon Pay and send customer login codes through a linked WhatsApp account. It builds on YouPI PG's checkout, payment lifecycle, admin dashboard and signed webhooks.

“Better” describes this workflow's setup and verification changes. It is not a claim of universal superiority, bank approval, guaranteed delivery, or measured speed advantage.

## Compared with the imported upstream baseline

| Area | Imported YouPI PG baseline | This fork |
| --- | --- | --- |
| Payment evidence | Gmail/SMS banking notifications | Amazon Pay web history and UPI receipt details |
| Amazon connection | No dedicated setup | Connect, sign in, enable verification from the admin tab |
| Customer OTP setup | WhatsApp controls nested with Gmail settings | Dedicated WhatsApp OTP tab, QR/phone-code pairing, test message |
| Email/SMS configuration | Part of the observer workflow | Not needed when Amazon mode is enabled |
| Failed OTP dispatch | Could return “OTP sent” without dispatch | Returns an error and invalidates the undelivered challenge |
| Customer signup email | Required by signup validation | Optional for WhatsApp signup |
| Receipt replay | Generic observation deduplication | Amazon reference ledger and atomic receipt consumption |
| Confirmation delivery | Existing webhook engine | Durable event outbox plus delivery IDs reused across retries |
| Restarts | Existing service supervision | Saved Amazon settings/session and WhatsApp reconnection |
| Sensitive logging | Dependency could print Signal session objects | Reviewed installation patch, runtime check, SDK payload logs disabled |

This comparison is against the code imported into this fork, not every future upstream version.

## What we preserved

The customer checkout's overall design, UPI QR/intent flow, queue, customer metadata and server webhook contract remain. Legacy Gmail/SMS code remains available for other configurations. It is not a fallback that silently confirms payments when Amazon fails.

## What the changes accomplish

The gateway no longer waits for an email notification in Amazon mode. It refreshes the portal, reads incoming UPI receipts, validates the receiving account, and submits normalized evidence to the existing payment state machine.

The dashboard makes account linking visible. Merchants enter passwords and Amazon login challenges directly in Amazon's browser; the gateway stores the browser session locally. WhatsApp linking is also done by the operator, and the saved device session resumes after a restart.

When the observer cannot read reliable evidence, checkout verification becomes unavailable. Failed parsing, expired sessions and missing credentials do not turn into a payment success.

## Limits that remain

- Amazon receipt matching uses receiving UPI ID, exact amount and time. It does not verify a merchant order ID. An unrelated same-amount transfer can still match an order.
- Receipts display minute-level timestamps; ambiguous overlapping payments are rejected.
- Amazon UI changes, login expiry and outages can interrupt detection.
- WhatsApp linking uses BerryProtocol, not the official WhatsApp Business Cloud API. OTP delivery can be delayed, and a connected socket does not prove receipt on a customer's phone.
- There is one managed Amazon profile/receiving account per gateway host. This is not a multi-tenant hosted payment platform.
- No speed, availability or production-readiness claim follows from a successful local payment.

## Validation

The automated checks cover parsing, wrong amounts/recipients, stale evidence, replay, atomic rollback, restart recovery, dashboard setup, OTP dispatch failures, optional email, logging protection and raw-body webhook signatures.

A controlled live test also completed WhatsApp OTP login, a small UPI payment, Amazon receipt detection and signed merchant confirmation. WhatsApp delivery was delayed during that test. The saved WhatsApp session reconnected after restarting the gateway.

Run the checks in [README](../README.md) and conduct your own controlled test before evaluating a deployment.
