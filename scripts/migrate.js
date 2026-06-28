'use strict';

/**
 * Koro migration runner.
 *
 * Applies the SQL files in ../migrations in numeric order, tracking what's been
 * applied in the `schema_migrations` table so a deploy never re-runs or skips a
 * migration. Each file runs inside its own transaction — a failure rolls back
 * cleanly and stops the run.
 *
 * Connection: needs a direct Postgres URL (NOT the Supabase REST key). Set
 * DATABASE_URL in the environment / .env. In Supabase: Project Settings →
 * Database → "Connection string" → URI (use the "Session" pooler or direct).
 *   DATABASE_URL=postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
 *
 * Usage:
 *   node scripts/migrate.js            # apply all pending migrations
 *   node scripts/migrate.js --check    # list applied + pending, apply nothing
 *   node scripts/migrate.js --baseline # mark ALL existing files as applied
 *                                       # (run ONCE on a DB that already has the
 *                                       #  schema from manual SQL-editor runs)
 *
 * Files matching dev_*.sql are ignored (they're destructive dev resets).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config();

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  console.error('[migrate] missing dependency "pg". Run:  npm install');
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const TRACKING_FILE = '0031_schema_migrations.sql';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const BASELINE = args.includes('--baseline');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f)) // numbered files only; skips dev_*.sql
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function versionOf(file) {
  const m = file.match(/^(\d+)_/);
  return m ? m[1] : file;
}

function checksum(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

async function ensureTrackingTable(client) {
  // The tracking table is itself migration 0031. Apply just that file first
  // (idempotent — CREATE TABLE IF NOT EXISTS) so we have somewhere to record.
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, TRACKING_FILE), 'utf8');
  await client.query(sql);
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function record(client, file, sum) {
  await client.query(
    'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING',
    [versionOf(file), file, sum],
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL not set. See the header of this file for how to get it.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    // Supabase requires TLS; allow self-signed in the chain.
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await ensureTrackingTable(client);
    const applied = await appliedVersions(client);
    const files = migrationFiles();

    if (CHECK) {
      console.log('[migrate] status:\n');
      for (const f of files) {
        const mark = applied.has(versionOf(f)) ? '  applied ' : '· PENDING ';
        console.log(`  ${mark} ${f}`);
      }
      const pending = files.filter((f) => !applied.has(versionOf(f)));
      console.log(`\n[migrate] ${applied.size} applied, ${pending.length} pending.`);
      return;
    }

    if (BASELINE) {
      // Mark every existing file as applied WITHOUT running it — for a DB whose
      // schema was already created by hand. Run this exactly once.
      let n = 0;
      for (const f of files) {
        if (applied.has(versionOf(f))) continue;
        const sum = checksum(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
        await record(client, f, sum);
        n += 1;
      }
      console.log(`[migrate] baseline: recorded ${n} migration(s) as already applied.`);
      return;
    }

    // Apply pending migrations in order, each in its own transaction.
    const pending = files.filter((f) => !applied.has(versionOf(f)));
    if (!pending.length) {
      console.log('[migrate] nothing to do — database is up to date.');
      return;
    }
    for (const f of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const sum = checksum(sql);
      process.stdout.write(`[migrate] applying ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await record(client, f, sum);
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('FAILED');
        console.error(`\n[migrate] ${f} failed and was rolled back:\n`, err.message);
        process.exit(1);
      }
    }
    console.log(`[migrate] done — applied ${pending.length} migration(s).`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[migrate] fatal:', err.message);
  process.exit(1);
});
