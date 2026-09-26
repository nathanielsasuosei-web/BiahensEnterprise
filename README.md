# Biahens Enterprise

A complete single-owner e-commerce platform for the Ghanaian market — built with **Node.js, Express, EJS and SQLite**. Think Jumia / Jiji / Temu in structure, but with one hard rule: **only the store owner can upload products, change prices or edit settings.** Staff accounts can run orders and support customers, nothing more.

- **Storefront:** heavy multi-level header (announcement bar, logo + search + account/cart, category mega-menu, mobile drawer), hero carousel, flash-deal countdown rails, category and brand pages, product pages with variants/reviews/related items, cart, wishlist, guest or account checkout, order tracking.
- **Checkout:** Ghana regions and cities, standard/express/pickup delivery, Mobile Money (MTN · Telecel · AT), card and cash on delivery, coupons, and a **Paystack-compatible stub gateway** with a real HMAC SHA-512 webhook handler — drop in live keys and it works unchanged.
- **Admin panel:** dashboard with KPIs and charts, product CRUD + CSV import/export, inventory valuation, categories/brands/hero slides, order pipeline with timeline and invoices, customer files with notes and segmentation, coupons, review moderation, newsletter list, promotions, analytics reports, payment ledger, email outbox, audit log, system health and notifications.
- **Currency:** Ghana cedi (GH₵), prices formatted `en-GH`.

---

## Quick start

```bash
npm install
cp .env.example .env        # optional — every value has a working default
npm run db:init             # create the schema + owner account
npm run db:seed             # optional: 96 products, 65 orders, 26 customers…
npm start                   # http://localhost:3000
```

| Role | Email | Password |
| --- | --- | --- |
| **Owner** (full control, product uploads) | `owner@biahensenterprise.com` | `Biahens@2026` |
| Staff (orders, customers, marketing) | `staff@biahensenterprise.com` | `Staff@2026` |
| Demo shopper | any seeded customer email | `Customer@2026` |

Admin panel: `/admin/login` · Storefront: `/`

Test payments (stub gateway): card `4084 0840 8408 4081` succeeds, `5060 6666 6666 6666 666` is declined, `4084 0999 9999 9995` fails for insufficient funds, and any Mobile Money number ending `0000` fails.

---

## Deploying

### Option A — Vercel (ready to go, but read the storage note)

Everything needed is already in the repo:

| File | Purpose |
| --- | --- |
| `vercel.json` | Build command, `public/` as static output, rewrite every dynamic route to the function, cache headers, `lhr1` region |
| `api/index.js` | Serverless entry — exports the Express app (no `listen()`) |
| `scripts/vercel-build.js` | Builds a **fully seeded** `data/biahens.sqlite` at build time |
| `src/db/bootstrap.js` | On cold start, copies that baked database into `/tmp` (or seeds it if missing) |
| `src/config/index.js` | Detects serverless and moves the DB + uploads into `/tmp` |

Deploy:

```bash
npm i -g vercel
vercel login
vercel --prod
```

Or import the GitHub repo at <https://vercel.com/new> — the settings in `vercel.json` are picked up automatically. If you prefer setting them in the dashboard: **Framework Preset** `Other`, **Build Command** `npm run vercel:build`, **Output Directory** `public`, **Install Command** `npm install`.

Environment variables to set in the Vercel project (Settings → Environment Variables):

```
SESSION_SECRET=<long random string>
OWNER_EMAIL=<your email>
OWNER_PASSWORD=<strong password>
GATEWAY_MODE=test            # or live, with the Paystack keys below
PAYSTACK_SECRET_KEY=sk_live_…
PAYSTACK_WEBHOOK_SECRET=whsec_…
```

`PUBLIC_URL` is inferred from Vercel, so you can leave it out.

> ### ⚠️ Storage on Vercel is ephemeral
> Vercel Functions mount your code **read-only**; only `/tmp` is writable and it is wiped whenever an instance recycles (minutes of idleness, or every new deployment). So on Vercel this app boots with the full demo catalogue, works end to end, but **orders, product edits, uploads and customer sign-ups do not persist**, and concurrent instances each have their own copy.
>
> That makes Vercel ideal for a **demo, design review or client preview** — not for taking real orders. The admin panel says so loudly on *System → Health* when it detects this mode.
>
> To run the real shop on Vercel you would need the data layer pointed at a hosted database (Turso/libSQL keeps the SQLite dialect, or Neon/Supabase Postgres). That is a deliberate change to `src/db` and the query layer — say the word and it can be done.

### Option B — a host with a real disk (recommended for production)

The code needs **zero changes** on any platform that gives you a persistent filesystem and a long-lived Node process:

| Platform | Notes |
| --- | --- |
| **Railway / Render / Fly.io** | Connect the repo, start command `npm start`, attach a volume mounted at `/app/data` (and `/app/public/uploads`). Free/cheap tiers are fine. |
| **Any VPS** (DigitalOcean, Hetzner, AWS EC2) | `npm ci && npm run db:init && npm run db:seed && npm start` behind Nginx/Caddy with TLS and `systemd`. |
| **Docker** | One container, two volumes: `data/` and `public/uploads/`. |

Then set `NODE_ENV=production`, a strong `SESSION_SECRET`, your real `PUBLIC_URL`, and register `https://your-domain/webhooks/paystack` in your Paystack dashboard.

### Production checklist

1. `NODE_ENV=production` + long random `SESSION_SECRET`.
2. Real `PUBLIC_URL` on HTTPS (session cookies become `Secure` automatically).
3. Live gateway keys, `GATEWAY_MODE=live`, webhook URL registered.
4. Connect an SMTP provider in `sendMail()` (`src/utils/log.js`) — until then emails are captured in the admin **Email outbox** instead of being sent.
5. Replace the placeholder logo/imagery and review the policy pages.
6. Back up `data/biahens.sqlite` (admin → *System health → Download backup*) on a schedule, off-server.

---

## Project layout

```
api/                     Vercel function entry
scripts/                 build helpers (vercel-build.js)
src/
  config/                env-driven configuration
  db/                    schema.sql, connection, bootstrap, seed, session store
  middleware/            auth (owner/staff/customer), context, uploads, errors
  routes/                site, cart, checkout, pay, auth, account, api
    admin/               products, catalog, orders, customers, marketing,
                         settings, analytics, system, uploads
  services/              catalog, cart, orders, payments, settings, stats
  utils/                 helpers, icons, images, logging/audit/mail outbox
views/                   EJS templates (storefront, account, admin, pages)
public/                  css, js, images, uploads
data/                    SQLite database (gitignored, created at build/init)
```

**Owner-only enforcement** lives in `src/middleware/auth.js`: `requireAdmin` (owner + staff) guards the panel, `requireOwner` guards `products`, `catalog`, `settings` and `uploads`. Every mutating admin action is written to `audit_log` with actor, role, IP and a before/after payload.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the server (`PORT`, default 3000) |
| `npm run dev` | Run with `--watch` |
| `npm run db:init` | Create/upgrade the schema, ensure the owner account |
| `npm run db:seed` | Seed demo data (skips if products already exist) |
| `npm run db:reset` | Wipe and rebuild the demo dataset |
| `npm run vercel:build` | Bake a seeded database for serverless deploys |
