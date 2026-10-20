# Set up Amazon Pay and WhatsApp

Use the merchant dashboard at http://127.0.0.1:6001. Unlock it with the admin token from `data/.secrets/admin_api_token`. Keep this token private.

## 0. Prepare a dedicated Amazon account

**Recommended: use a separate Amazon account and receiving UPI ID for this gateway.** Keep personal shopping and unrelated payments out of the account used by the watcher. This reduces mixed receipt history and the personal activity accessible through its saved browser session. It does not remove the same-amount attribution risk.

1. Create or choose an Amazon account you control for gateway use. Its login number and the number used for UPI verification have separate roles; see the two-number example below.
2. Complete **Amazon Pay UPI** registration and bank linking in the Amazon app using your bank-registered number/SIM. If you are moving an existing Amazon Pay UPI setup from another Amazon account, follow the migration steps below first. An Amazon shopping account alone is insufficient. Amazon distinguishes bank-linked UPI from its wallet; this observer requires received bank UPI receipts, not Amazon Pay Balance credits. See [Amazon's Pay guide](https://www.aboutamazon.in/news/amazon-pay/amazon-pay-guide-wallet-upi-features).
3. Note the actual receiving UPI ID shown by Amazon. Do not construct a UPI ID from a phone number or assume a payment sent to a mobile-number alias will appear in this account's history.
4. Make a small controlled incoming transfer to that exact UPI ID. Sign in to the same Amazon account on the desktop and confirm a **Received** receipt with that UPI ID under **Credited to**. This receipt also lets the watcher's initial scan verify the account.

### Amazon login number and bank-registered number

**Better-YouPI-PG does not require the number on your Amazon login to match the number registered with your bank.** The watcher uses your signed-in Amazon session and matches the receiving UPI ID in receipts.

The maintainer describes this two-number arrangement:

| Purpose | Number to use |
| --- | --- |
| Create and sign in to the dedicated Amazon account | **Number A**, which you control and which need not be linked to your bank |
| Verify Amazon Pay UPI and link your bank account | **Number B**, the number registered with your bank, using its SIM |
| Receive and verify gateway payments | The actual **UPI ID** created in that Amazon account; copy it from Amazon |

In that setup, the Amazon account is created with Number A, while Amazon Pay UPI is registered inside it using Number B. Incoming payments go to the resulting UPI ID and must appear in that account's Amazon Pay web history for the watcher to read them. Creating the Amazon login with Number A alone does not complete UPI registration.

The bank-linked number requirement applies to **Number B's UPI verification**: the number verified by the UPI app must match the number registered with your bank for account discovery. It is not a requirement in this gateway for Number A and Number B to match. [NPCI UPI FAQ](https://www.npci.org.in/what-we-do/upi/faqs)

This two-number setup is maintainer-reported experience, not an independently verified Amazon policy for every account. Complete the current Amazon app flow and confirm the small incoming receipt test before enabling the watcher.

This initial registration may require Amazon/bank verification SMS or OTPs. The gateway's **payment verification** needs no Gmail/SMS observer; customer checkout OTPs use WhatsApp.

### Moving UPI from another Amazon account

Number B may already be associated with an Amazon account or Amazon Pay UPI registration you control. When moving that UPI setup to the dedicated gateway account, **we recommend deregistering Amazon Pay UPI on the old account before registering it on the new one**, once you are ready to retire the old setup. This is project migration advice, not a promise that Amazon allows simultaneous UPI registrations across accounts.

1. Finish active payments and stop sharing the old UPI ID or QR for new payments. Review any payment links and active AutoPay mandates that depend on the old setup.
2. Sign in to the old Amazon account, open Amazon Pay's UPI settings and use its UPI deregistration control. Read the confirmation and follow any instructions about linked accounts or mandates before proceeding. This concerns the UPI registration; you do not need to delete the Amazon shopping account.
3. Sign in to the dedicated Amazon account with Number A. Start Amazon Pay UPI setup and verify the bank-linked Number B/SIM as instructed by Amazon.
4. Copy the UPI ID Amazon shows after setup; do not assume the old ID will remain usable or transfer to the new account.
5. Confirm a small incoming transfer appears in the new account's web history, then select that exact UPI ID in the gateway's Store Settings and connect the same Amazon account.

If Amazon reports that the number is already registered or blocks registration, follow its in-app help or contact Amazon support. The gateway cannot resolve an Amazon account-registration conflict. You do not need to deregister unrelated UPI apps for this migration.

## 1. Connect Amazon Pay

1. In Store Settings, select your receiving UPI account. Its UPI ID must match the **Credited to** UPI ID in Amazon Pay.
2. Open the **Amazon Pay** tab and choose **Connect Amazon Pay**.
3. Sign in yourself in the dedicated browser that opens on the server computer. Amazon handles your password and login OTP.
4. Return to the dashboard, read the matching limitation, acknowledge it, and choose **Enable verification**.
5. Wait for **Ready**. The first complete scan must find a valid received UPI receipt for the selected account. An empty history cannot verify the account; wallet credits do not count.

The saved browser session is reused in the background. Enable verification also enables restart recovery. Pause stops checking. Reconnect is available when Amazon requires sign-in again. A remote server needs a desktop for the initial Amazon sign-in.

Matching uses recipient UPI ID, amount and time, not a verified order ID. An unrelated transfer of the same amount can match a checkout. This limitation remains even when the connection is Ready.

## 2. Connect WhatsApp for checkout OTP

1. Open **WhatsApp OTP** in the main navigation.
2. Click **Connect WhatsApp**.
3. On the sender phone, open WhatsApp → Settings/menu → Linked devices → Link a device, and scan the dashboard QR.
4. Alternatively, expand **Cannot scan? Link using a phone number**, enter the sender number with country code, and request a pairing code. Enter that code in the phone's **Link with phone number** screen.
5. Wait for **Connected**.
6. Enter a WhatsApp recipient number you control and click **Send test message**. Check the phone to confirm receipt.

The sender is the account linked to the server. The customer receives a separate six-digit login OTP on their own WhatsApp number. A device pairing code is not a checkout OTP.

The linked WhatsApp session is saved locally and reconnects on server restart. **Disconnect** removes that saved session. The dashboard never asks for a WhatsApp password.

If WhatsApp cannot start because its native database module is missing, run `npm rebuild better-sqlite3` once on the server and retry. A normal `npm ci` must allow dependency installation scripts.

## 3. Try checkout

Open a new checkout from your merchant store. Enter the customer's WhatsApp number and name; email is optional. Request the OTP, read it on the phone, and enter it in checkout. Then pay the displayed UPI QR using another person's UPI account.

On a phone, an active UPI checkout also offers **Pay with a UPI app** above the QR. Tap it to open the server-generated `upi://pay` link with the same receiver, amount and order note as the QR. Your phone may show an app chooser or open its default UPI app. Return to checkout after paying; opening an app does not confirm payment.

App launching depends on the installed apps, operating system and browser. Generic UPI links are primarily intended for Android; iOS and in-app browsers may not handle them. If nothing opens, use a supported browser or scan the QR from another device. The button is unavailable for queued, processing, expired or completed payments. A desktop browser preview cannot verify a real phone's app handoff.

Amazon Pay verifies the incoming payment. The merchant must verify the signed server webhook before treating the order as paid. Gmail and SMS observers are not required in Amazon mode.

The current local test page is http://127.0.0.1:6105. It opens a real ₹1 checkout in a separate tab and checks the signed webhook. It requires both connections to be ready; it does not simulate payment.

## Restart locally

After stopping existing gateway services, run:

```powershell
npm run dev:amazon
```

This loads `.env.amazon-local` when present. Keep its `SQLITE_DB_PATH` pointing at the same database so the saved dashboard configuration and receiving account are reused. The supervisor starts the gateway services; a configured Amazon connection replaces Gmail/SMS observers. The optional standalone trial on port 6105 is a separate diagnostic.

Do not enable `YOUPI_EXPOSE_DEV_OTP` for real checkout testing. The supplied Amazon example disables it. An unavailable WhatsApp connection now returns a delivery error instead of claiming that a code was sent.

## Automated checks

```powershell
npm run test:amazon
npm run test:whatsapp
npm test
```

Automated pairing and dispatch tests use isolated test services. They do not replace a real phone pairing, OTP receipt, and payment test.
