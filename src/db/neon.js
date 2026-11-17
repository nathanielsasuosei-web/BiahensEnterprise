'use strict';

/**
 * Async Neon/PostgreSQL connection layer for the Vercel migration.
 *
 * This is intentionally not wired into the current app yet: the storefront
 * still uses better-sqlite3's synchronous API. Do not enable live Vercel mode
 * until all callers, migrations, sessions and transaction boundaries have
 * been converted and verified against PostgreSQL.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

function createNeonDatabase({ pool }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A Neon-compatible PostgreSQL pool is required.');
  }

  const transactionContext = new AsyncLocalStorage();

  async function query(text, values = []) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('SQL text is required.');
    if (!Array.isArray(values)) throw new TypeError('PostgreSQL query values must be an array.');
    const client = transactionContext.getStore() || pool;
    return client.query(text, values);
  }

  async function all(text, values = []) {
    return (await query(text, values)).rows;
  }

  async function get(text, values = []) {
    return (await query(text, values)).rows[0];
  }

  async function run(text, values = []) {
    const result = await query(text, values);
    return { changes: result.rowCount, rows: result.rows };
  }

  function transaction(work) {
    if (typeof work !== 'function') throw new TypeError('Transaction work must be a function.');
    return async (...args) => {
      if (transactionContext.getStore()) {
        throw new Error('Nested transactions are not supported; use the active transaction.');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await transactionContext.run(client, () => work(...args));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
        throw error;
      } finally {
        client.release();
      }
    };
  }

  return {
    query,
    all,
    get,
    run,
    transaction,
    close: () => pool.end(),
  };
}

function createFromEnvironment(env = process.env) {
  const connectionString = String(env.NEON_DATABASE_URL || '').trim();
  if (!connectionString) {
    const error = new Error('Set NEON_DATABASE_URL in the hosting environment.');
    error.code = 'NEON_DATABASE_URL_REQUIRED';
    throw error;
  }
  // Load only when Neon is selected so the existing SQLite/demo runtime does
  // not initialize a remote connection or require Neon credentials at import.
  const { Pool } = require('@neondatabase/serverless');
  const pool = new Pool({ connectionString, max: env.VERCEL ? 1 : 10 });
  return createNeonDatabase({ pool });
}

module.exports = { createNeonDatabase, createFromEnvironment };
