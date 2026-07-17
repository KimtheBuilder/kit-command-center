const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
let sql;

function enabled() { return !!process.env.DATABASE_URL; }

function connectionOptions() {
  const ssl = String(process.env.DB_SSL || '').toLowerCase();
  const max = Number(process.env.DB_POOL_MAX || 10);
  const timeoutMs = Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('DB_POOL_MAX must be an integer from 1 to 50.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 60000) throw new Error('DB_CONNECTION_TIMEOUT_MS must be between 250 and 60000.');
  return {
    max,
    connect_timeout: Math.ceil(timeoutMs / 1000),
    idle_timeout: 30,
    ssl: ['true', 'require', '1'].includes(ssl) ? 'require' : false,
    prepare: false,
    onnotice: () => {}
  };
}

function connect() {
  if (sql) return sql;
  if (!enabled()) return null;
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
  await ensureMigrationTable(client);
  const applied = await client`SELECT version FROM schema_migrations`;
  const versions = new Set(applied.map(row => Number(row.version)));
  if (direction === 'down') {
    for (const migration of migrationFiles('down').reverse()) {
      if (!versions.has(migration.version) || (targetVersion !== undefined && migration.version <= targetVersion)) continue;
      await client.begin(async tx => { await tx.unsafe(migration.sql); await tx`DELETE FROM schema_migrations WHERE version = ${migration.version}`; });
    }
    return;
  }
  for (const migration of migrationFiles('up')) {
    if (versions.has(migration.version) || (targetVersion !== undefined && migration.version > targetVersion)) continue;
    await client.begin(async tx => { await tx.unsafe(migration.sql); await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`; });
  }
}

async function health() {
  if (!enabled()) return { configured: false, ready: false };
  const started = Date.now();
  await connect()`SELECT 1 AS ok`;
  return { configured: true, ready: true, latency_ms: Date.now() - started };
}

async function close() { if (sql) await sql.end({ timeout: 5 }); sql = null; }
function setClientForTests(client) { sql = client; }

module.exports = { close, connect, connectionOptions, enabled, health, migrate, migrationFiles, setClientForTests };
