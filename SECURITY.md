# Security

This is an experimental payment observer, not an audited payment processor. Do not use browser events as payment proof. Verify webhook signatures over the original raw request bytes and deduplicate deliveries.

## Keep local state private

Never publish `.env*` files with real values, `data/.secrets/`, databases, browser profiles, WhatsApp authentication files, receipt journals, logs, HAR files or screenshots containing account data. Example environment files contain configuration only.

The admin, observer and internal service tokens are backend credentials. Use filesystem permissions to restrict the server's data directory. Keep the server bound to loopback unless you have deliberately configured an authenticated HTTPS deployment.

## WhatsApp logging protection

The pinned `libsignal` dependency can print session objects with cryptographic material. The root `postinstall` runs `scripts/patch-whatsapp-logging.js`, which removes the reviewed sensitive log calls. The patch verifies source hashes and dependency version before changing files. An unknown version or modified source fails closed.

Before starting WhatsApp, the service checks that the actual SDK dependency copy is patched. SDK structured payload logging is disabled; the gateway retains fixed connection and dispatch messages without phone numbers, OTP bodies or session objects.

If installation scripts were disabled, run:

```sh
npm run security:patch-whatsapp
```

Do not bypass a failed check. Review a dependency update and refresh the patch/tests instead. This guard covers the reviewed dependency files; it is not a claim that every dependency can never log sensitive data.

## Existing logs

The fix does not remove past output. If an earlier version ran with real accounts, treat captured logs as sensitive. Remove public copies and revoke/relink affected WhatsApp device sessions if their key material was exposed. Rotate any admin/observer credentials that were published. Do not delete the encryption master key casually: existing encrypted data depends on it.

## Reporting

Use GitHub's private vulnerability reporting feature if it is enabled on the fork. If it is unavailable, open an issue asking for a private reporting channel without including exploit details, credentials, customer information or payment evidence.

Include the affected commit, a minimal reproduction using fake data, expected behavior and actual behavior. Never post a real OTP or account session as a reproduction.
