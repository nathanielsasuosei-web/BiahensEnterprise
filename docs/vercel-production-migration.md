# Vercel production migration (Neon + Vercel Blob)

## Decision and current status

Target: Vercel Node functions, Neon PostgreSQL for all durable relational state, and Vercel Blob for public uploaded images. Vercel's current function filesystem is not a persistence layer. The existing app uses synchronous `better-sqlite3`, a SQLite-backed session store, filesystem uploads, and local SQLite backups, so adding Vercel environment variables alone is not a safe migration.

The async database and Blob adapters in `src/db/neon.js` and `src/services/blob-storage.js` are **foundation only**. The running app still uses SQLite; they are not yet wired into routes. The existing live-store guard must remain in place until every milestone below is complete. In particular, do not set `STORE_MODE=live` or add real Paystack/message credentials to the current Vercel deployment as a workaround.

## Required milestones before a live Vercel cutover

1. **PostgreSQL schema and migrations:** port all tables, constraints, indexes, data upgrades, owner bootstrap and safe one-time migration rules. Do not import seeded/demo users, simulated payments, sample orders, or queued messages for synthetic recipients.
2. **Async query conversion:** replace synchronous SQLite calls throughout routes and services with awaited PostgreSQL operations. Preserve atomic order/payment/stock/outbox transactions and idempotent webhook handling under concurrent function instances.
3. **Shared sessions and throttling:** move sessions to the durable PostgreSQL store and replace process-local rate-limit state with a shared store. Verify session rotation, secure cookies, expiry, and concurrent requests.
4. **Blob-backed uploads:** process images in memory or temporary function storage, upload immutable variants to Blob, persist provider URLs, and safely delete only owned Blob assets. Remove assumptions that `/uploads` is a durable local directory.
5. **Operational checks and backup policy:** replace SQLite/WAL/quick-check/local-backup reporting with honest PostgreSQL and Blob diagnostics. Document provider-managed database recovery and independently retained upload/database backups; a successful `SELECT 1` is not a backup or durability proof.
6. **Verification:** add PostgreSQL integration tests for transactions, constraints, webhook retries, session behavior, migrations, and upload lifecycle. Keep live charges and message sends out of automated tests. Run the full existing suite and the new integration suite before permitting live startup.
7. **Vercel cutover:** only after the prior work is reviewed, create/link the Vercel project, provision Neon and Blob, set secrets privately in Vercel, deploy first to a non-production environment, and complete operator-authorized provider checks.

## Hosting values (only after implementation is ready)

- `NEON_DATABASE_URL`: Neon connection string for the intended database/environment; use the provider's pooled connection string if recommended for serverless functions.
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob read/write token, scoped to the intended project/store.
- Existing store, owner, Paystack, Resend, and WhatsApp settings remain server-side. Keep production secrets separate from preview/development targets. Never paste values into Git, issue text, or chat.

Until the migration is complete, the existing Vercel configuration intentionally remains demo-only (`STORE_MODE=demo`, simulator/test payments, notifications disabled), and the production readiness report must not imply that a Vercel deployment is a persistent live store.
