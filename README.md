# POINTGH

A multi-department Ghanaian store built with **Node 22, Express, EJS and SQLite**. Only the owner can upload products or change the catalogue; staff can support orders and customers.

- **Account checkout:** signup/login and a valid phone number are required. Orders, receipts and automatic tracking are private to their customer.
- **VAT (1%):** added to merchandise after coupon discounts, excluding delivery. Each new order snapshots its rate; historical charges are not rewritten. This is the requested store setting, not a statement about statutory Ghanaian tax obligations.
- **Real online payments:** Paystack-hosted card/Mobile Money checkout, server-side verification, exact amount/currency/reference/environment checks, raw-body signed webhooks, transactional/idempotent settlement, and a payment-review path for late or duplicate charges. No live PAN/CVV form is served by POINTGH.
- **Owner alerts:** persistent email + WhatsApp outbox, Resend and Meta Cloud API transports, retry/backoff, explicit WhatsApp opt-in and an owner-only delivery log. Provider acceptance is distinguished from delivery/read confirmation.
- **Persistent production:** a single Node process with SQLite, sessions, uploads, alert retries and backups under one durable disk mount. Live startup refuses temporary/serverless storage, missing provider configuration and published demo credentials.

**Implementation is not deployment.** Provider keys, an attached paid persistent disk, your public HTTPS address, authorized verification sends and a verified live transaction must be configured/checked in your own accounts. No code change alone creates a hosting service or activates provider accounts.

## Run the isolated local demo

```sh
npm ci
cp .env.example .env
npm run db:init
npm run db:seed       # sample catalogue/accounts/orders; DEMO ONLY
npm run dev          # http://localhost:3000
```

Published **demo-only** logins:

| Role | Email | Password |
| --- | --- | --- |
| Owner | `owner@biahensenterprise.com` | `Biahens@2026` |
| Staff | `staff@biahensenterprise.com` | `Staff@2026` |
| Shopper | any seeded customer email | `Customer@2026` |

The demo simulator accepts test card `4084 0840 8408 4081`. It never charges money. Do not enter real card details. Notification sending is disabled by default in demo mode.

## Deploy the real store

Follow **[docs/production.md](docs/production.md)**. For your **existing server**, use the supplied `Dockerfile` with a durable volume and HTTPS reverse proxy, or the managed-Node/VPS instructions in the guide. `render.yaml` is an optional alternative: one paid Node web service with a persistent disk at `/var/data`. No resources are provisioned by these files until you deploy them.

1. Publish/review this version of the code, choose your hosting service and attach its durable disk.
2. Configure the private variables listed in `.env.production.example` in the hosting dashboard. Use your existing approved Paystack, verified Resend domain and WhatsApp Business template. **Do not send secrets in chat or commit environment files.**
3. Start with `NODE_ENV=production`, `STORE_MODE=live`, `PAYMENT_PROVIDER=paystack`, `GATEWAY_MODE=live`, `DATA_DIR=/var/data`, `PERSISTENT_STORAGE=true`. The real store initializes its schema and first owner, **not** demo products, customers or orders.
4. Register `https://YOUR-STORE/webhooks/paystack` in Paystack. The callback URL is set per transaction by the backend. Review both modern and legacy signature setup in the guide.
5. Check **Admin → System health → Production readiness**. Explicitly authorize a verification email/WhatsApp send in **Order alerts & delivery**, check both devices, then perform only an authorized payment verification transaction.
6. Verify survival of a service restart and deployment. Configure encrypted **off-server** backups of both the database and uploads and test recovery.

Do not scale this SQLite deployment to multiple app instances. Vercel's `/tmp` SQLite path remains **demo-only**, with `STORE_MODE=demo`; live startup refuses it. A live Vercel deployment would require a separate managed-database migration, not an environment-variable workaround.

### Payment/refund boundaries

- Customers pay on `checkout.paystack.com`, not a local live card form. Initialization errors keep the order and expose a safe retry/check path, never simulator fallback.
- Online stock is allocated once for a 30-minute payment window. Unpaid expired/cancelled orders release it once. COD collection does not allocate a second time.
- Late payments on closed orders and additional successful attempts are recorded as captured funds requiring owner review, without resurrecting fulfilment or consuming stock again.
- **Refunds are issued and reconciled directly in Paystack.** This app does not initiate or automatically synchronize refunds. The old local-only refund action is disabled. Cancelling an order or editing its status cannot return money or fabricate a paid/refunded state. Cash refunds are handled separately.

## Owner email and WhatsApp alerts

See **[docs/order-alerts.md](docs/order-alerts.md)** for the six-parameter approved template and provider settings. Each order and its two alert jobs are committed together. A worker drains the durable outbox every 30 seconds. Credentials are server-only; no secret is displayed in templates, public APIs or the payment ledger.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Long-running server; listens on `0.0.0.0:$PORT` |
| `npm run dev` | Local watch mode |
| `npm test` | Isolated storefront, commerce, VAT, provider/payment, safety and persistence tests; mocked external HTTP only |
| `npm run db:init` | Additive schema/settings/owner setup; no sample dataset |
| `npm run db:seed` / `npm run db:reset` | Demo-only sample data helpers; refused for live stores/keys |
| `npm run production:check` | Read-only readiness evidence; makes no provider requests |
| `npm run notifications:send` | Attempt queued notifications using configured providers |
| `npm run backup` | Integrity-checked SQLite online backup; copy it and uploads off-server |
| `npm run vercel:build` | Disposable, demo-only serverless bundle; refuses to overwrite an existing DB |

Live servers keep seven local database snapshots, approximately daily. A backup on the same disk is **not** disaster recovery. Uploads need a separate off-server copy.

## Layout

`src/config` — environment/safety checks · `src/db` — additive schema, owner bootstrap and persistent sessions · `src/services` — commerce, provider clients, outbox, backups/readiness · `src/routes` — storefront/account/admin/provider endpoints · `views` — EJS · `public` — local assets · `tests` — isolated verification · `docs` — operator setup.

The working database (`data/`), generated caches, private environment files and uploads are ignored by Git and excluded from the Docker build context. Never reset an existing store to deploy an update.
