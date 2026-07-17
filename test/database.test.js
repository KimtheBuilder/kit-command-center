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
      if (options && options.failTransactions) throw new Error('transaction failed');
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

test('real PostgreSQL migrations, CRUD, transactions, concurrency, and rollback', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_SSL = 'false';
  store.resetForTests();
  await database.migrate('down', 0);
  await database.migrate('up');
  await store.initialize({ force: true });

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

  await database.migrate('down', 0);
  const versions = await database.connect()`SELECT version FROM schema_migrations`;
  assert.equal(versions.length, 0);
  await database.close();
  delete process.env.DATABASE_URL;
});
