# Set up Amazon Pay and WhatsApp

Use the merchant dashboard at http://127.0.0.1:6001. Unlock it with the admin token from `data/.secrets/admin_api_token`. Keep this token private.

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
