const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION_LOCK = 744113001;
const INSTANCE_LOCK = 744113002;
let sql;
let instanceConnection;

function enabled() { return !!process.env.DATABASE_URL; }

function requireConfigured() {
  if (!enabled()) {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production; JSON fallback is prohibited.');
    return false;
  }
  return true;
}

function connectionOptions() {
  const ssl = String(process.env.DB_SSL || 'disable').toLowerCase();
  const max = Number(process.env.DB_POOL_MAX || 10);
  const timeoutMs = Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('DB_POOL_MAX must be an integer from 1 to 50.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 60000) throw new Error('DB_CONNECTION_TIMEOUT_MS must be between 250 and 60000.');
  if (!['disable', 'false', '0', 'require', 'true', '1', 'verify-full'].includes(ssl)) throw new Error('DB_SSL must be disable, require, or verify-full.');
  const sslOption = ssl === 'verify-full'
    ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}) }
    : ['require', 'true', '1'].includes(ssl) ? 'require' : false;
  return {
    max,
    connect_timeout: Math.ceil(timeoutMs / 1000),
    idle_timeout: 30,
    ssl: sslOption,
    prepare: false,
    onnotice: () => {}
  };
}

function connect() {
  if (sql) return sql;
  if (!requireConfigured()) return null;
  const postgres = require('postgres');
  sql = postgres(process.env.DATABASE_URL, connectionOptions());
  return sql;
}

function migrationFiles(direction) {
  return fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.' + direction + '.sql')).sort()
    .map(name => ({ name, version: Number(name.split('_')[0]), sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

async function ensureMigrationTable(client) {
  await client.unsafe('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
}

async function migrate(direction, targetVersion) {
  const client = connect();
  if (!client) throw new Error('DATABASE_URL is required for database migrations.');
  await client.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await ensureMigrationTable(tx);
    const applied = await tx`SELECT version FROM schema_migrations ORDER BY version`;
    const versions = new Set(applied.map(row => Number(row.version)));
    if (direction === 'down') {
      if (!versions.size) return;
      const highest = Math.max(...versions);
      const target = targetVersion === undefined ? highest - 1 : targetVersion;
      if (!Number.isInteger(target) || target < 0 || target >= highest) throw new Error('Rollback target must be a non-negative version below the current version.');
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_DB_ROLLBACK !== 'I_UNDERSTAND_DATA_WILL_BE_DELETED') {
        throw new Error('Production rollback requires ALLOW_DESTRUCTIVE_DB_ROLLBACK=I_UNDERSTAND_DATA_WILL_BE_DELETED.');
      }
      for (const migration of migrationFiles('down').reverse()) {
        if (!versions.has(migration.version) || migration.version <= target) continue;
        await tx.unsafe(migration.sql);
        await tx`DELETE FROM schema_migrations WHERE version = ${migration.version}`;
      }
      return;
    }
    for (const migration of migrationFiles('up')) {
      if (versions.has(migration.version) || (targetVersion !== undefined && migration.version > targetVersion)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
    }
  });
}

async function acquireInstanceLock() {
  if (!requireConfigured() || instanceConnection) return;
  const reserved = await connect().reserve();
  try {
    const [row] = await reserved`SELECT pg_try_advisory_lock(${INSTANCE_LOCK}) AS acquired`;
    if (!row.acquired) throw new Error('Another KIT production instance already owns the database lock.');
    instanceConnection = reserved;
  } catch (error) {
    await reserved.release();
    throw error;
  }
}

async function health() {
  if (!requireConfigured()) return { configured: false, ready: false };
  const started = Date.now();
  await connect()`SELECT 1 AS ok`;
  return { configured: true, ready: true, latency_ms: Date.now() - started };
}

async function close() {
  let closeError;
  if (instanceConnection) {
    try { await instanceConnection`SELECT pg_advisory_unlock(${INSTANCE_LOCK})`; }
    catch (error) { closeError = error; }
    finally { await instanceConnection.release(); instanceConnection = null; }
  }
  if (sql) {
    try { await sql.end({ timeout: 5 }); }
    catch (error) { closeError ||= error; }
    finally { sql = null; }
  }
  if (closeError) throw closeError;
}
function setClientForTests(client) { sql = client; instanceConnection = null; }

module.exports = { acquireInstanceLock, close, connect, connectionOptions, enabled, health, migrate, migrationFiles, requireConfigured, setClientForTests };
