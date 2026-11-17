# POINTGH — persistent live deployment

## What is implemented, and what still needs an operator

The code supports real Paystack-hosted payments, Resend email and WhatsApp Business template requests. It does **not** create hosting resources, verify ownership of your provider accounts, supply credentials, buy a domain, send an unrequested test message, or charge anyone as part of deployment/readiness checks.

Use your **existing** approved merchant and messaging accounts. Enter secrets directly in your hosting dashboard (or a private environment file on your own server), **never in chat, Git, a browser bundle, public settings fields or screenshots**.

For your chosen **existing server / VPS**, use the `Dockerfile` with a durable volume and HTTPS reverse proxy (section 3B), or managed Node/systemd on durable storage without Docker (section 3C). Exact commands depend on your provider and domain.

`render.yaml` is an optional alternative for one paid persistent Node web service, not a service already created for you (section 3A).

This is **single-instance SQLite**, not a horizontally scalable cluster. Do not use Vercel/serverless, multiple replicas, network/shared SQLite filesystems, or a detached cron service that cannot access the app's disk.

## 1. Attach the durable disk before startup

Mount a persistent disk at `/var/data` and set:

```text
NODE_ENV=production
STORE_MODE=live
HOST=0.0.0.0
DATA_DIR=/var/data
PERSISTENT_STORAGE=true
SEED_ON_BOOT=false
PAYMENT_PROVIDER=paystack
GATEWAY_MODE=live
NOTIFICATIONS_ENABLED=true
```

Default paths:

| Data | Durable location |
| --- | --- |
| Orders, accounts, products, settings, inventory | `/var/data/pointgh.sqlite` (+ SQLite WAL/SHM while open) |
| Login sessions and carts | Tables in the same SQLite database |
| Notification outbox/retry state | Tables in the same SQLite database |
| Owner-uploaded photos/logos | `/var/data/uploads/` |
| Seven retained SQLite backup snapshots | `/var/data/backups/` |

If overriding `DB_FILE`, `UPLOADS_DIR` or `BACKUP_DIR`, keep every path **under `DATA_DIR`**. The app validates this and refuses `/tmp` or detected serverless live deployments. `PERSISTENT_STORAGE=true` is your assertion that the host attached a durable disk; it does not turn an ephemeral directory into one.

Migrations and first-owner setup run at **runtime**, after the disk is mounted. Build/install steps must not open, seed or reset the database. No live demo-data reset action is available.

## 2. Private environment values

`.env.production.example` is the complete reference. Supply actual values only to the host:

| Variable | Requirement |
| --- | --- |
| `PUBLIC_URL` | Your HTTPS origin, e.g. the actual domain you control; no path/query. On Render it can initially be inferred from `RENDER_EXTERNAL_URL`. Set explicitly after attaching a custom domain. |
| `SESSION_SECRET` | At least 32 random characters. Render generates a value. Keep stable across restarts/deployments; rotation signs everyone out. |
| `OWNER_NAME`, `OWNER_EMAIL`, `OWNER_PHONE` | Your real owner profile, phone including country code. |
| `OWNER_PASSWORD` | Unique 16+ character secret for **first boot only**. Existing accounts/passwords are never silently overwritten or promoted. Remove it from the host after setup if desired. |
| `PAYSTACK_SECRET_KEY` | Your live `sk_live_…` key. Test keys are rejected by live startup. |
| `PAYSTACK_WEBHOOK_SECRET` | Modern `whsec_…` signing secret from Paystack if using `Paystack-Signature`. See below. Legacy signatures use the API key instead. |
| `RESEND_API_KEY` | API key with email-sending access for your verified domain. |
| `MAIL_FROM` | Address on that verified domain, optionally `POINTGH <address@domain>`. |
| `OWNER_NOTIFICATION_EMAIL` | Real owner recipient; required explicitly for live startup. |
| `OWNER_NOTIFICATION_WHATSAPP` | Owner WhatsApp recipient with country code; required explicitly for live startup. |
| `WHATSAPP_ACCESS_TOKEN` | Server access token for the existing business app/number, with appropriate messaging permission. Use an appropriately managed token, not a short-lived development token. |
| `WHATSAPP_PHONE_NUMBER_ID` | Numeric Cloud API phone-number ID, **not** the displayed telephone number. |
| `WHATSAPP_ORDER_TEMPLATE` | Existing approved six-body-parameter utility template name. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Exact approved language, default `en`. |
| `WHATSAPP_API_VERSION` | A supported version for your app, default `v23.0`. |
| `WHATSAPP_OWNER_OPT_IN` | `true` only with the owner recipient's permission. |

`PAYSTACK_PUBLIC_KEY` is **optional**, because hosted checkout requires no browser integration/key. Optional `PAYSTACK_PREVIOUS_WEBHOOK_SECRET` supports a signing-secret rotation overlap. Remove it when the provider's overlap expires.

`NOTIFICATION_CRON_SECRET` is optional for an external bearer-authenticated drain call. The long-running server already drains every 30 seconds; it does not need a separate worker instance.

Changing the database's old `gateway_mode` or demo webhook secret cannot override these production values. Live local authorization, fake signed-event helpers, demo seeding/reset and manual online-payment marking are refused.

A fresh live disk creates an owner and departments, not demo inventory, customers, orders or fake payment history. Add/review your real products, stock, support details, delivery fees, branding and policies in the owner panel. VAT defaults to the requested 1%, after discounts and excluding delivery; confirm your legal tax requirements separately.

## 3A. Deploy with the supplied Render Blueprint

1. Publish the reviewed version of this code to the repository branch you intend to deploy. Local workspace edits alone are not a remote deployment.
2. In your Render account, create a **Blueprint** from that repository and branch. Review `render.yaml` before confirming. The supplied paid plan and 10 GB disk incur hosting charges; review the current price/region in your account. It is deliberately **not** a free ephemeral service.
3. Keep **one instance** with disk `pointgh-data` mounted at `/var/data`. Never remove/recreate that disk as part of an update. The blueprint disables automatic deploys so code changes can be reviewed before a controlled deploy.
4. Supply the prompted private values in Render. Match the WhatsApp language/API version to your existing approved template. Set opt-in only with consent. No migration/seed pre-deploy command is needed.
5. Build command: `npm ci --omit=dev`. Start command: `npm start`. Health path: `/healthz`. Node: 22.22.3. The disk is used at runtime, never during build/pre-deploy.
6. After startup, sign in at `/admin/login`, configure real store details/products, then complete provider setup and the verification checklist below.
7. When adding a custom domain, configure its DNS/TLS in Render and set `PUBLIC_URL` to that exact HTTPS origin. Browse/administer the store at this canonical origin; live mutation requests from other origins are rejected.

Keep the existing Vercel deployment clearly demo-only (`STORE_MODE=demo`, no live keys, notification delivery disabled), or remove its public/custom-domain routing after cutover. Never send live Paystack webhooks to the old Vercel demo.

## 3B. Docker / an existing persistent server

The Docker image excludes local databases, uploads, caches, Git and environment files. It does not seed anything. The container runs as the unprivileged `node` user.

On your own host, after reviewing the file and storing a populated environment file privately:

```sh
docker build -t pointgh .
docker volume create pointgh-data
docker run -d --name pointgh --restart unless-stopped \
  --env-file /PRIVATE/PATH/pointgh.env \
  -v pointgh-data:/var/data \
  -p 127.0.0.1:3000:3000 pointgh
```

Put Caddy/Nginx or the host's HTTPS proxy in front of this port. Only the proxy should reach the application port on a public server; Express trusts one proxy hop. Keep browser requests same-origin (relative URLs). For a bind-mounted directory, give container UID/GID 1000 appropriate private read/write ownership. Preserve the volume when replacing the container. Health: `/healthz`. Docker CLI/build validation still needs a Docker-capable host.

## 3C. Existing managed Node service / VPS without Docker

Use Node **22** and install this version's locked dependencies with `npm ci --omit=dev`. Start command: `npm start`; bind `HOST=0.0.0.0` on the host-provided port. Set the same private environment values through the hosting panel or a protected service environment file.

Keep `DATA_DIR` on the server's durable disk **outside the code/release directory**, for example an operator-created `/var/lib/pointgh` owned by the application service user. Set `PERSISTENT_STORAGE=true` only after confirming that disk survives a deploy/restart. Keep DB, uploads and backup paths beneath it. Do not use `/tmp`, release-build folders or a hosting tier with an ephemeral filesystem.

Run one process using the host's process manager or a dedicated unprivileged systemd service. With PM2, use one fork, not cluster mode. The service user needs write access only to its durable data and temporary image-processing directory; the code can be read-only. Keep HTTPS at the provider proxy/Nginx/Caddy, and restrict direct access to the app port so only the trusted proxy can reach it. Configure that proxy for normal same-origin requests and one trusted proxy hop.

Exact service paths, start/restart commands, SSL and disk configuration depend on your existing provider. Confirm the hosting provider, domain/current URL and whether it supports Docker or managed Node before applying a server-specific deployment. No SSH password, private key or provider token should be shared in chat.

## 4. Paystack setup and verification

In the existing Paystack business's **live** API/webhook configuration:

- Webhook URL: `PUBLIC_URL` + `/webhooks/paystack`.
- The backend sets an account-owned `/pay/REFERENCE/callback` URL when initializing each transaction; there is no browser amount or `?paid=1` trust.
- Enable the card/Mobile Money channels approved for your merchant account.
- Keep API keys server-side. The only outgoing payment API origin is `https://api.paystack.co`, and redirect URLs are restricted to HTTPS `checkout.paystack.com`.

Supported signatures:

1. **Modern `Paystack-Signature`**: `t=SECONDS,v1=whk_KEY_ID:HEX`. Configure the full `whsec_…` signing secret. The backend signs `timestamp + '.' + exact raw body` with HMAC-SHA512, compares in constant time, supports multiple `v1` entries/previous secret during rotation, and rejects timestamps more than five minutes old/in the future. Keep the server clock synchronized. An invalid modern header is never rescued by a valid legacy header.
2. **Legacy `x-paystack-signature`**: HMAC-SHA512 of the exact raw body using `PAYSTACK_SECRET_KEY`, **not** `whsec_…`. Supported for existing legacy integrations. If modern signatures are enabled in the dashboard, configure the signing secret before enabling the new header.

Each successful callback/webhook must match saved reference, amount in pesewas, currency, mode (`live`), successful status and transaction ID. Payment/order/stock/customer-receipt changes commit atomically. Webhooks receive 200 only after durable handling; database failure returns 500 for provider retry. Invalid signatures receive 401.

Unpaid online stock holds expire after 30 minutes. A late charge to an expired/cancelled order or an additional successful charge is captured in the ledger **for owner review** without resurrecting the order or consuming stock twice. Contact the customer and use the provider dashboard for any required refund. Do not ask the customer to pay twice while MoMo approval is pending.

### Refund boundary — do not mistake bookkeeping for money movement

This version deliberately **does not initiate or automatically reconcile refunds**. Issue and track online refunds in Paystack, and handle cash refunds outside the app. The former local-only refund action is disabled; manual fulfilment changes cannot create paid/refunded financial facts. Cancelling a paid order keeps the payment paid and warns that a real refund may be required. Reconcile your provider refund/settlement report separately; leave an internal support note rather than falsely marking money returned.

## 5. Email and WhatsApp

Use the existing verified domain and approved utility template; see [order-alerts.md](order-alerts.md) for the exact six body parameter positions. No recreation of approved accounts/templates is needed if the existing ones match.

In **Admin → Order alerts & delivery**, inspect both configured recipients, authorize **Send verification messages**, and check the actual email inbox and WhatsApp device. This action sends two real messages; it is not run automatically during readiness checks. Record provider IDs and check any error. An API-accepted message is not proof that a device received/read it. Message charges and account restrictions are determined by the providers.

Never enable delivery on a copied demo database containing synthetic customer email addresses. Live startup refuses marked/legacy demo data, simulated or test-mode payment history, and active published staff/owner demo passwords.

## 6. Go-live acceptance checklist

- [ ] Real HTTPS domain reaches the persistent Node service, not Vercel.
- [ ] Durable disk attached; DB, sessions, uploads, outbox and backups all under its mount.
- [ ] Exactly one app instance; no network/shared filesystem for SQLite.
- [ ] Owner uses a unique password; no active demo credentials or synthetic order history.
- [ ] Real catalogue, stock, contact details, delivery rates, VAT policy and returns terms reviewed.
- [ ] Both owner verification messages accepted, and actual receipt checked on both devices.
- [ ] Only an **explicitly authorized** live payment is made; card/MoMo details are entered on Paystack, never POINTGH.
- [ ] Server-verified receipt matches amount including VAT, currency and reference in Paystack; failed/pending attempts are not marked paid.
- [ ] Paystack webhook reaches the new endpoint and repeated delivery does not change stock/sales twice.
- [ ] Restart/redeploy leaves an authorized test account/session, order, uploaded file and outbox history intact.
- [ ] `npm run production:check` and owner System health checks reviewed. These are evidence, not a remote account/delivery guarantee.
- [ ] Daily local backups exist, encrypted off-server DB/upload copies exist, and recovery has been tested.
- [ ] Old demo domain/webhook routing removed or clearly separated.

Tests in this repository use isolated databases and mocked external requests. Passing them does not perform or prove any of the live steps above.

## 7. Backups, migration and recovery

`npm run backup` and **System health → Download backup** use SQLite's online backup API, include committed WAL data and check the snapshot with `quick_check`. The live process attempts a daily backup and retains seven local snapshots. They include accounts, sessions and the outbox. Uploaded images are separate and are **not** included in a SQLite download.

Copy both snapshots and uploads to encrypted off-server storage using your own backup system. Same-disk retention and hosting disk snapshots alone are not sufficient. Monitor failures and disk capacity. This repository does not silently create cloud backup credentials or claim an off-server copy exists.

For **real existing merchant data**, before cutover:

1. Export a consistent database backup and copy uploads from the old running service before it stops or loses its temporary filesystem. A Vercel cold-start demo snapshot is not a reliable export of all instances.
2. Review the export in an isolated offline environment: do not import sample accounts, fake paid orders, reset-password tokens, or queued messages to synthetic recipients. The checked-out demo database is intentionally not packaged into live deployment.
3. Restore only a vetted database and matching uploads to a **fresh/offline durable disk**. Never overwrite an open SQLite file or copy only its main file while uncheckpointed WAL writes exist. Back up first.
4. Start this version against that durable path. Migrations are additive and do not reprice historical orders, reset passwords, or reseed stock. New inventory flags record known legacy allocation state without moving historical stock.
5. Reconcile provider charges, outstanding COD, refunds and unsent alerts before reopening checkout or retrying deliveries. Restoring an older outbox can resend messages; exactly-once messaging is not guaranteed.

Practice disaster recovery on a separate offline copy, compare integrity and important row counts/files, then verify the intended recovery point. Do not experiment with a destructive restore on the live disk. For deployment updates, retain the same disk and stable session secret; never run `db:reset`, `db:seed` or `vercel:build` on the live store.

References: [Paystack transactions](https://paystack.com/docs/api/transaction/), [signed webhooks](https://paystack.com/docs/payments/webhooks/), [Render persistent disks](https://render.com/docs/disks), [Render Blueprint fields](https://render.com/docs/blueprint-spec).
