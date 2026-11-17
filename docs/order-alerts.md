# Owner order alerts

New orders require a signed-in account with a valid phone number. The order and its two owner alerts (email + WhatsApp) are saved together in a database transaction. Orders are **not** marked paid because an alert was sent.

## Production prerequisite: persistent storage

Use the single-instance persistent Node server deployment in [production.md](production.md), with the database and uploads under `DATA_DIR`. Live startup refuses detected ephemeral storage. The repository’s existing Vercel demo copies SQLite into `/tmp`; that is **ephemeral and not shared between instances**. Customer accounts, sessions, orders and queued alerts can disappear or diverge on cold starts. Adding notification credentials does not fix that limitation.

## 1. Owner recipients

Sign in as the owner and open **Admin → Order alerts & delivery** (`/admin/system/mail`). Enter the owner’s email and WhatsApp number (including the country code) and explicitly opt in to automated WhatsApp order alerts. Blank recipients fall back to the owner account’s email/phone.

Live startup requires explicit environment recipients. Environment overrides take precedence: `OWNER_NOTIFICATION_EMAIL`, `OWNER_NOTIFICATION_WHATSAPP`, and `WHATSAPP_OWNER_OPT_IN=true`. Do not leave the demo owner contact details in a real shop.

## 2. Email (Resend)

Use your existing Resend account and verified sending domain, and set these **private server environment variables**:

- `NOTIFICATIONS_ENABLED=true`: explicitly enable sending (disabled by default in demos).
- `RESEND_API_KEY`: the provider’s API key.
- `MAIL_FROM`: an address on the verified domain, such as `POINTGH <orders@your-domain.com>`.

No API keys are stored in public templates, browser JavaScript or database settings. Welcome, password reset, payment/status emails and owner alerts use the same persistent delivery log. Resend idempotency keys are used on retries.

## 3. WhatsApp Business Cloud API

A regular WhatsApp number or `wa.me` link **cannot send automatic alerts**. Use your existing WhatsApp Business Platform app, registered sending number and suitable server access token. The owner recipient must opt in; in Meta’s test environment it must also be an allowed test recipient.

Set these private environment variables:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`: the API phone-number ID, not the phone number itself.
- `WHATSAPP_ORDER_TEMPLATE`: the name of an **approved utility message template**.
- `WHATSAPP_TEMPLATE_LANGUAGE`: the exact approved template language, default `en`.
- `WHATSAPP_API_VERSION`: defaults to `v23.0`; use a supported Graph API version for your app.

The template must have **six body text parameters** in this order:

1. Order number
2. Customer name
3. Item count
4. Order total, including currency
5. Payment method and payment status
6. Absolute admin order URL

Expected template shape (reuse an already approved template when it matches):

> New POINTGH order {{1}}. Customer: {{2}}. Items: {{3}}. Total: {{4}}. Payment: {{5}}. Review your order: {{6}}.

Use the same parameter order and do not add required header or button parameters unless the sender code is updated accordingly. Meta determines template approval and charges. Credentials alone do not bypass template approval or recipient opt-in.

## 4. Delivery and retries

- Checkout persists the order, both alert jobs and the emptied bag before external calls, then attempts the two owner alerts before returning its redirect. Provider failures never roll back a valid order.
- On a normal Node server, a worker drains the outbox every 30 seconds. Temporary errors retry with exponential backoff, up to five attempts.
- The owner can inspect errors and click **Retry pending messages** after fixing configuration. Messages already accepted by a provider are not resent by that action.
- For a scheduler, set `NOTIFICATION_CRON_SECRET` to a long random secret (at least 24 characters) and request `GET /api/internal/notifications/drain` with `Authorization: Bearer <secret>`. Never place this secret in a browser URL or client bundle. Run the scheduler against the same persistent database as the shop.
- Alternatively run `npm run notifications:send` on the application server.

Statuses are explicit: **queued**, **sending**, **unconfigured**, **failed**, or **sent**. “Sent / provider accepted” means the provider accepted the request, **not** that the owner received or read it. Delivery/read webhooks are not implemented. Network timeouts can leave an ambiguous provider outcome; as with other external messaging systems, exactly-once delivery is not guaranteed.

## Verification

`npm test` uses isolated temporary databases and mocked provider responses. No real email, WhatsApp message, payment or customer order is produced by the test suite. After configuring a persistent production deployment, use the owner-only **Send verification messages** action. It requires explicit consent and sends one real email and one real approved-template WhatsApp message to the configured owner recipients; it does not create a customer order or charge money. Check provider IDs in the log AND both recipient devices. A readiness check never sends anything automatically. Then verify an authorized order under the production go-live checklist.
