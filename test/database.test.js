const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const database = require('../src/database');
const store = require('../src/store');
const { assertStartupSecurity } = require('../src/security');
const { importDirectory } = require('../scripts/import-json');
const { prepare } = require('../src/startup');
const shutdown = require('../src/shutdown');

function memoryAdapter(options) {
  const state = Object.fromEntries(store.COLLECTIONS.map(name => [name, []]));
  return {
    kind: 'memory-postgres-test', state,
    async initialize() {},
    async loadAll() { return structuredClone(state); },
    async apply(op) {
      if (op.type === 'insert') state[op.collection].push(structuredClone(op.row));
      if (op.type === 'update') state[op.collection] = state[op.collection].map(row => row.id === op.row.id ? structuredClone(op.row) : row);
      if (op.type === 'delete') state[op.collection] = state[op.collection].filter(row => row.id !== op.id);
    },
    async transaction(ops) {
      if (options && options.failTransactions) {
        if (options.failTransactions !== 'always') options.failTransactions = false;
        throw new Error('transaction failed');
      }
      const snapshot = structuredClone(state);
      try { for (const op of ops) await this.apply(op); } catch (error) { Object.assign(state, snapshot); throw error; }
    },
    async health() { return { configured: true, ready: true, backend: 'memory-postgres-test' }; }
  };
}

test.beforeEach(() => store.resetForTests());

test('migration is versioned, indexed, reversible, and makes events immutable', () => {
  const up = database.migrationFiles('up');
  const down = database.migrationFiles('down');
  assert.deepEqual(up.map(item => item.version), [1]);
  assert.deepEqual(down.map(item => item.version), [1]);
  for (const collection of store.COLLECTIONS) assert.match(up[0].sql, new RegExp('CREATE TABLE ' + collection));
  assert.match(up[0].sql, /events_immutable_update/);
  assert.match(up[0].sql, /CREATE INDEX tasks_status_idx/);
  assert.match(down[0].sql, /DROP TABLE IF EXISTS/);
});

test('pool settings are bounded by explicit environment configuration', () => {
  const old = { ...process.env };
  process.env.DB_POOL_MAX = '7'; process.env.DB_CONNECTION_TIMEOUT_MS = '4500'; process.env.DB_SSL = 'require';
  const options = database.connectionOptions();
  assert.equal(options.max, 7);
  assert.equal(options.connect_timeout, 5);
  assert.equal(options.ssl, 'require');
  process.env = old;
});

test('DB_SSL rejects unknown modes and supports verified certificates', () => {
  const original = { ...process.env };
  process.env.DB_SSL = 'opportunistic';
  assert.throws(database.connectionOptions, /DB_SSL must be/);
  process.env.DB_SSL = 'verify-full'; process.env.DB_SSL_CA = 'test-ca';
  assert.deepEqual(database.connectionOptions().ssl, { rejectUnauthorized: true, ca: 'test-ca' });
  process.env = original;
});

test('CRUD preserves the existing store interface and safe IDs', async () => {
  const adapter = memoryAdapter();
  await store.initialize({ adapter, force: true });
  const goal = store.create('goals', { title: 'Durable goal' }, 'goal');
  assert.match(goal.id, /^goal_[A-Za-z0-9_-]{16}$/);
  await store.flush();
  assert.equal(store.get('goals', goal.id).title, 'Durable goal');
  assert.equal(store.update('goals', goal.id, { status: 'active' }).status, 'active');
  await store.flush();
  assert.equal(adapter.state.goals[0].status, 'active');
  assert.equal(store.remove('goals', goal.id), true);
  await store.flush();
  assert.equal(store.list('goals').length, 0);
});

test('concurrent writes are serialized without ID collisions', async () => {
  const adapter = memoryAdapter();
  await store.initialize({ adapter, force: true });
  const rows = Array.from({ length: 100 }, (_, index) => store.create('tasks', { title: 'Task ' + index }, 'task'));
  await Promise.all([store.flush(), store.flush(), store.flush()]);
  assert.equal(new Set(rows.map(row => row.id)).size, 100);
  assert.equal(adapter.state.tasks.length, 100);
});

test('transactions commit atomically and restore cache on rollback', async () => {
  const good = memoryAdapter();
  await store.initialize({ adapter: good, force: true });
  await store.transaction(() => {
    store.create('approvals', { title: 'Approve', status: 'pending' }, 'apr');
    store.create('events', { action: 'approval.requested' }, 'evt');
  });
  assert.equal(good.state.approvals.length, 1);
  assert.equal(good.state.events.length, 1);

  const failing = memoryAdapter({ failTransactions: true });
  await store.initialize({ adapter: failing, force: true });
  await assert.rejects(store.transaction(() => store.create('tasks', { title: 'Rolled back' }, 'task')), /transaction failed/);
  assert.equal(store.list('tasks').length, 0);
  assert.equal(failing.state.tasks.length, 0);
});

test('failed queued writes restore cache and later writes can succeed', async () => {
  const adapter = memoryAdapter({ failTransactions: true });
  await store.initialize({ adapter, force: true });
  store.create('tasks', { title: 'Must disappear' }, 'task');
  await assert.rejects(store.flush(), /transaction failed/);
  assert.equal(store.list('tasks').length, 0);
  assert.equal(adapter.state.tasks.length, 0);

  const recovered = store.create('tasks', { title: 'Recovered' }, 'task');
  await store.flush();
  assert.equal(store.get('tasks', recovered.id).title, 'Recovered');
  assert.equal(adapter.state.tasks.length, 1);
});

test('events reject update and delete operations', async () => {
  await store.initialize({ adapter: memoryAdapter(), force: true });
  const event = store.create('events', { action: 'created' }, 'evt');
  assert.throws(() => store.update('events', event.id, { action: 'changed' }), /immutable/);
  assert.throws(() => store.remove('events', event.id), /immutable/);
});

test('JSON import preserves source files, IDs, timestamps, and legacy providers', async () => {
  const adapter = memoryAdapter();
  await store.initialize({ adapter, force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-json-import-'));
  const created = '2025-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify([{ id: 'goal_existing', title: 'Imported', created_at: created }]));
  fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify([{ id: 'prv_existing', record_type: 'provider', name: 'Provider' }, { id: 'asset_existing', record_type: 'render_job' }]));
  const before = fs.readFileSync(path.join(dir, 'goals.json'), 'utf8');
  const totals = await importDirectory(dir);
  assert.deepEqual(totals, { goals: 1, providers: 1, assets: 1 });
  assert.equal(store.get('goals', 'goal_existing').created_at, created);
  assert.equal(store.list('providers').length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'goals.json'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('production startup requires a database while development can use JSON fallback', () => {
  const original = { ...process.env };
  process.env.NODE_ENV = 'production'; process.env.ADMIN_KEY = 'a'.repeat(32); process.env.VIDEO_ALLOWED_HOSTS = 'video.example.com'; delete process.env.DATABASE_URL;
  assert.throws(assertStartupSecurity, /DATABASE_URL is required/);
  process.env.DATABASE_URL = 'postgres://example.invalid/kit';
  assert.doesNotThrow(assertStartupSecurity);
  process.env.NODE_ENV = 'development'; delete process.env.DATABASE_URL;
  assert.doesNotThrow(assertStartupSecurity);
  process.env = original;
});

test('store itself prohibits every production JSON fallback path', async () => {
  const original = { ...process.env };
  process.env.NODE_ENV = 'production'; delete process.env.DATABASE_URL;
  store.resetForTests();
  assert.throws(() => store.list('goals'), /JSON persistence is prohibited|JSON fallback is prohibited/);
  await assert.rejects(store.initialize({ force: true }), /JSON persistence is prohibited|JSON fallback is prohibited/);
  assert.throws(database.requireConfigured, /DATABASE_URL is required/);
  process.env = original;
});

test('application preparation checks database health before serving', async () => {
  const original = { ...process.env };
  process.env.NODE_ENV = 'production'; process.env.ADMIN_KEY = 'a'.repeat(32); process.env.VIDEO_ALLOWED_HOSTS = 'video.example.com'; process.env.DATABASE_URL = 'postgres://test.invalid/kit';
  await store.initialize({ adapter: memoryAdapter(), force: true });
  const status = await prepare();
  assert.equal(status.ready, true);
  delete process.env.DATABASE_URL;
  await assert.rejects(prepare(), /DATABASE_URL is required/);
  process.env = original;
});

test('graceful shutdown stops accepting requests, drains writes, and closes PostgreSQL', async () => {
  shutdown.resetForTests();
  const originalFlush = store.flush;
  const originalClose = database.close;
  const calls = [];
  store.flush = async () => { calls.push('flush'); };
  database.close = async () => { calls.push('database'); };
  const server = { close(callback) { calls.push('server'); callback(); } };
  try {
    await shutdown.gracefulShutdown(server, 'SIGTERM');
    assert.equal(calls[0], 'server');
    assert.ok(calls.includes('flush'));
    assert.equal(calls.at(-1), 'database');
  } finally {
    store.flush = originalFlush;
    database.close = originalClose;
    shutdown.resetForTests();
  }
});

test('real PostgreSQL migrations, CRUD, import, concurrency, locking, and safe rollback', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const original = { ...process.env };
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_SSL = 'false';
  store.resetForTests();
  await database.close();
  await database.migrate('down', 0);
  await Promise.all([database.migrate('up'), database.migrate('up')]);
  const versionsAfterCompetingMigrations = await database.connect()`SELECT version FROM schema_migrations`;
  assert.deepEqual(versionsAfterCompetingMigrations.map(row => Number(row.version)), [1]);
  await store.initialize({ force: true });
  const [lock] = await database.connect()`SELECT pg_try_advisory_lock(744113002) AS acquired`;
  assert.equal(lock.acquired, false);

  const goal = store.create('goals', { title: 'PostgreSQL integration' }, 'goal');
  await store.flush();
  assert.equal(store.get('goals', goal.id).title, 'PostgreSQL integration');
  store.update('goals', goal.id, { status: 'active' });
  await store.flush();
  assert.equal(store.get('goals', goal.id).status, 'active');

  await store.transaction(() => {
    store.create('approvals', { title: 'Atomic', status: 'pending' }, 'apr');
    store.create('events', { action: 'approval.requested' }, 'evt');
  });
  for (let index = 0; index < 25; index++) store.create('tasks', { title: 'Concurrent ' + index }, 'task');
  await store.flush();
  assert.equal(store.list('tasks').length, 25);
  await assert.rejects(database.connect().unsafe('UPDATE events SET data = data'), /immutable/);

  const importedAt = '2025-01-01T00:00:00.000Z';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pg-import-'));
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify([{ id: 'goal_pg_import', title: 'Imported once', created_at: importedAt, updated_at: importedAt }]));
  assert.deepEqual(await importDirectory(dir), { goals: 1 });
  assert.deepEqual(await importDirectory(dir), { goals: 0 });
  const [imported] = await database.connect()`SELECT id, created_at, updated_at FROM goals WHERE id = 'goal_pg_import'`;
  assert.equal(imported.id, 'goal_pg_import');
  assert.equal(new Date(imported.created_at).toISOString(), importedAt);
  assert.equal(new Date(imported.updated_at).toISOString(), importedAt);
  fs.rmSync(dir, { recursive: true, force: true });

  const competing = store.create('tasks', { title: 'Compete' }, 'task');
  await store.flush();
  const [before] = await database.connect()`SELECT updated_at FROM tasks WHERE id = ${competing.id}`;
  const first = await database.connect().unsafe('UPDATE tasks SET data = $2::jsonb, updated_at = now() WHERE id = $1 AND updated_at = $3', [competing.id, JSON.stringify({ title: 'winner' }), before.updated_at]);
  const second = await database.connect().unsafe('UPDATE tasks SET data = $2::jsonb, updated_at = now() WHERE id = $1 AND updated_at = $3', [competing.id, JSON.stringify({ title: 'loser' }), before.updated_at]);
  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(store.remove('tasks', competing.id), true);
  await assert.rejects(store.flush(), /Concurrent delete rejected/);
  assert.equal(store.get('tasks', competing.id).id, competing.id);
  const recovery = store.create('tasks', { title: 'Write after conflict' }, 'task');
  await store.flush();
  assert.equal(store.get('tasks', recovery.id).title, 'Write after conflict');

  await assert.rejects(database.connect().begin(async tx => {
    await tx`INSERT INTO goals (id, data) VALUES ('rolled_back', '{"title":"no"}'::jsonb)`;
    throw new Error('force rollback');
  }), /force rollback/);
  const rolledBack = await database.connect()`SELECT id FROM goals WHERE id = 'rolled_back'`;
  assert.equal(rolledBack.length, 0);

  delete process.env.ALLOW_DESTRUCTIVE_DB_ROLLBACK;
  process.env.NODE_ENV = 'production';
  await assert.rejects(database.migrate('down'), /requires ALLOW_DESTRUCTIVE_DB_ROLLBACK/);
  process.env.NODE_ENV = 'test';
  await database.migrate('down');
  const versions = await database.connect()`SELECT version FROM schema_migrations`;
  assert.equal(versions.length, 0);
  await database.close();
  process.env = original;
});
