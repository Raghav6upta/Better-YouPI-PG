# Why Better-YouPI-PG?

This fork targets a specific setup: receive UPI payments through Amazon Pay and send customer login codes through a linked WhatsApp account. It builds on YouPI PG's checkout, payment lifecycle, admin dashboard and signed webhooks.

“Better” describes this workflow's setup and verification changes. It is not a claim of universal superiority, bank approval, guaranteed delivery, or measured speed advantage.

## The problem: waiting for a notification after payment

A successful UPI transfer and delivery of the bank's SMS/email alert are separate events. With notification-based verification, the gateway must wait for the alert to arrive before it can ingest evidence. The Gmail path also checks the inbox on a polling schedule. Delayed or missing alerts can therefore hold up checkout confirmation after the customer has paid. [NPCI's UPI FAQ](https://www.npci.org.in/what-we-do/upi/faqs) also notes that bank confirmation SMS delivery can be delayed by operator issues.

Amazon mode reads the received UPI receipt in Amazon Pay's web portal. It removes bank notification delivery, Gmail access and email polling from the verification path. The observer still refreshes the portal; it is not a push API and still depends on Amazon making the receipt available.

| Verification path | What the gateway waits for |
| --- | --- |
| Bank email + Gmail observer | Bank alert delivery, the next inbox check and message processing |
| Bank SMS + SMS observer | Bank alert delivery and SMS relay ingestion |
| Amazon Pay observer | Receipt availability in Amazon Pay, the next portal scan and receipt validation |

The default active scan delay is five seconds after a scan finishes, compared with thirty seconds while idle. The imported Gmail poller also defaults to five seconds, so this is a change in the evidence source and waiting steps, not a demonstrated reduction in the polling interval. Reading an available Amazon receipt can avoid the remaining wait for a bank alert.

There is no published before/after latency benchmark. A scan takes time, a newly active checkout may inherit an already scheduled idle wait, and failures trigger backoff. Five seconds is a scheduling setting, not a confirmation deadline. See [polling and failure handling](AMAZON_PAY.md#polling-and-failure-handling).

## Compared with the imported upstream baseline

| Area | Imported YouPI PG baseline | This fork |
| --- | --- | --- |
| Payment evidence | Gmail/SMS banking notifications | Amazon Pay web history and UPI receipt details |
| Notification dependency | Wait for bank SMS/email delivery before ingesting evidence | Check available Amazon receipts without a bank alert |
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

The gateway no longer waits for a bank SMS/email notification in Amazon mode. It refreshes the portal, reads incoming UPI receipts, validates the receiving account, and submits normalized evidence to the existing payment state machine. The aim is to reduce the time spent waiting for notifications after a payment, while keeping the existing checkout experience.

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
