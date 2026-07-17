// Synchronous compatibility surface backed by an initialized PostgreSQL working
// set. REST and MCP boundaries call flush(), so acknowledged writes are durable.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const database = require('./database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'local');
const COLLECTIONS = [
  'agents','goals','tasks','approvals','campaigns','audits','findings',
  'recommendations','workflows','assets','providers','kpis','benchmarks','reviews',
  'scorecards','decisions','events','cinematic_projects','scenes','edit_jobs'
];
const TABLE = new Set(COLLECTIONS);
const cache = {};
let initialized = false;
let adapter;
let pending = Promise.resolve();
let transactionOps = null;
let transactionLocked = false;

function assertCollection(col) {
  if (!TABLE.has(col)) throw new Error('Unknown store collection: ' + col);
}

function clone(value) { return structuredClone(value); }
function jsonFile(col) { return path.join(DATA_DIR, col + '.json'); }

function jsonAdapter() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return {
    kind: 'json-development-fallback',
    async initialize() {},
    async loadAll() {
      const out = {};
      for (const col of COLLECTIONS) {
        try { out[col] = JSON.parse(fs.readFileSync(jsonFile(col), 'utf8')); } catch { out[col] = []; }
      }
      return out;
    },
    async apply(op) {
      fs.writeFileSync(jsonFile(op.collection), JSON.stringify(cache[op.collection] || [], null, 2));
    },
    async transaction(ops) {
      for (const col of new Set(ops.map(op => op.collection))) fs.writeFileSync(jsonFile(col), JSON.stringify(cache[col] || [], null, 2));
    },
    async health() { return { configured: false, ready: true, backend: 'json-development-fallback' }; }
  };
}

function postgresAdapter() {
  return {
    kind: 'postgresql',
    async initialize() { await database.migrate('up'); await database.health(); },
    async loadAll() {
      const client = database.connect();
      const out = {};
      for (const col of COLLECTIONS) {
        const rows = await client.unsafe(`SELECT id, data, created_at, updated_at FROM "${col}" ORDER BY created_at, id`);
        out[col] = rows.map(row => ({ ...row.data, id: row.id, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() }));
      }
      return out;
    },
    async apply(op, client) {
      const sql = client || database.connect();
      if (op.type === 'delete') return sql.unsafe(`DELETE FROM "${op.collection}" WHERE id = $1`, [op.id]);
      if (op.type === 'insert') {
        return sql.unsafe(`INSERT INTO "${op.collection}" (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)`, [op.row.id, JSON.stringify(op.row), op.row.created_at, op.row.updated_at]);
      }
      const result = await sql.unsafe(`UPDATE "${op.collection}" SET data = $2::jsonb, updated_at = $3 WHERE id = $1 AND updated_at = $4`, [op.row.id, JSON.stringify(op.row), op.row.updated_at, op.expectedUpdatedAt]);
      if (result.count !== 1) throw new Error('Concurrent update rejected for ' + op.collection + '/' + op.row.id + '.');
      return result;
    },
    async transaction(ops) {
      const self = this;
      await database.connect().begin(async tx => { for (const op of ops) await self.apply(op, tx); });
    },
    async health() { return { ...(await database.health()), backend: 'postgresql' }; }
  };
}

async function initialize(options) {
  if (initialized && !(options && options.force)) return;
  adapter = (options && options.adapter) || (database.enabled() ? postgresAdapter() : jsonAdapter());
  await adapter.initialize();
  const loaded = await adapter.loadAll();
  for (const col of COLLECTIONS) cache[col] = clone(loaded[col] || []);
  initialized = true;
  pending = Promise.resolve();
}

function ensureReady() {
  if (!initialized) {
    if (database.enabled()) throw new Error('PostgreSQL store has not been initialized.');
    // Development compatibility: JSON loading is synchronous on first access.
    adapter = jsonAdapter();
    for (const col of COLLECTIONS) {
      try { cache[col] = JSON.parse(fs.readFileSync(jsonFile(col), 'utf8')); } catch { cache[col] = []; }
    }
    initialized = true;
  }
}

function enqueue(op) {
  if (transactionOps) { transactionOps.push(op); return; }
  pending = pending.then(() => adapter.apply(op));
}

async function flush() { await pending; }

function id(prefix) {
  return (prefix || 'row') + '_' + crypto.randomBytes(12).toString('base64url');
}

function create(col, obj, prefix) {
  ensureReady(); assertCollection(col);
  if (transactionLocked && !transactionOps) throw new Error('Store transaction in progress; retry the write.');
  const now = new Date().toISOString();
  const row = { id: id(prefix || col.slice(0, 3)), created_at: now, updated_at: now, ...clone(obj) };
  cache[col].push(row);
  enqueue({ type: 'insert', collection: col, row: clone(row) });
  return clone(row);
}

function update(col, rowId, patch) {
  ensureReady(); assertCollection(col);
  if (transactionLocked && !transactionOps) throw new Error('Store transaction in progress; retry the write.');
  if (col === 'events') throw new Error('Events are immutable.');
  const row = cache[col].find(item => item.id === rowId);
  if (!row) return null;
  const expectedUpdatedAt = row.updated_at;
  Object.assign(row, clone(patch), { updated_at: new Date().toISOString() });
  enqueue({ type: 'update', collection: col, row: clone(row), expectedUpdatedAt });
  return clone(row);
}

function get(col, rowId) {
  ensureReady(); assertCollection(col);
  const row = cache[col].find(item => item.id === rowId);
  return row ? clone(row) : null;
}

function list(col, fn) {
  ensureReady(); assertCollection(col);
  const rows = clone(cache[col]);
  return fn ? rows.filter(fn) : rows;
}

function remove(col, rowId) {
  ensureReady(); assertCollection(col);
  if (transactionLocked && !transactionOps) throw new Error('Store transaction in progress; retry the write.');
  if (col === 'events') throw new Error('Events are immutable.');
  const index = cache[col].findIndex(item => item.id === rowId);
  if (index === -1) return false;
  cache[col].splice(index, 1);
  enqueue({ type: 'delete', collection: col, id: rowId });
  return true;
}

function importRows(col, rows) {
  ensureReady(); assertCollection(col);
  if (transactionLocked && !transactionOps) throw new Error('Store transaction in progress; retry the write.');
  let imported = 0;
  for (const input of rows || []) {
    if (!input || !input.id || cache[col].some(row => row.id === input.id)) continue;
    const now = new Date().toISOString();
    const row = { ...clone(input), created_at: input.created_at || now, updated_at: input.updated_at || input.created_at || now };
    cache[col].push(row);
    enqueue({ type: 'insert', collection: col, row: clone(row) });
    imported++;
  }
  return imported;
}

async function transaction(fn) {
  ensureReady();
  await flush();
  if (transactionLocked || transactionOps) throw new Error('Another store transaction is already in progress.');
  const snapshot = clone(cache);
  transactionLocked = true;
  transactionOps = [];
  try {
    const result = await fn();
    const ops = transactionOps;
    transactionOps = null;
    await adapter.transaction(ops);
    transactionLocked = false;
    return result;
  } catch (error) {
    transactionOps = null;
    transactionLocked = false;
    for (const col of COLLECTIONS) cache[col] = snapshot[col];
    throw error;
  }
}

async function health() { ensureReady(); await flush(); return adapter.health(); }
function backend() { return adapter ? adapter.kind : (database.enabled() ? 'postgresql-uninitialized' : 'json-development-fallback'); }
function resetForTests() { initialized = false; adapter = null; pending = Promise.resolve(); transactionOps = null; transactionLocked = false; for (const col of COLLECTIONS) delete cache[col]; }

module.exports = { COLLECTIONS, DATA_DIR, backend, create, flush, get, health, id, importRows, initialize, list, remove, resetForTests, transaction, update };
