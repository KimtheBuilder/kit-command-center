// Persistent JSON data store. Zero native dependencies — deploys anywhere.
// Set DATA_DIR to a Render persistent disk mount for durable storage.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'local');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const COLLECTIONS = [
  'agents','goals','tasks','approvals','campaigns','audits','findings',
  'recommendations','workflows','assets','kpis','benchmarks','reviews',
  'scorecards','decisions','events','cinematic_projects','scenes','edit_jobs'
];

const cache = {};

function file(col) { return path.join(DATA_DIR, col + '.json'); }

function load(col) {
  if (cache[col]) return cache[col];
  try { cache[col] = JSON.parse(fs.readFileSync(file(col), 'utf8')); }
  catch { cache[col] = []; }
  return cache[col];
}

function persist(col) {
  fs.writeFileSync(file(col), JSON.stringify(cache[col] || [], null, 2));
}

function id(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function create(col, obj, prefix) {
  const rows = load(col);
  const row = { id: id(prefix || col.slice(0, 3)), created_at: new Date().toISOString(), ...obj };
  rows.push(row);
  persist(col);
  return row;
}

function update(col, rowId, patch) {
  const rows = load(col);
  const row = rows.find(r => r.id === rowId);
  if (!row) return null;
  Object.assign(row, patch, { updated_at: new Date().toISOString() });
  persist(col);
  return row;
}

function get(col, rowId) { return load(col).find(r => r.id === rowId) || null; }
function list(col, fn) { const rows = load(col); return fn ? rows.filter(fn) : rows.slice(); }
function remove(col, rowId) {
  const rows = load(col);
  const i = rows.findIndex(r => r.id === rowId);
  if (i === -1) return false;
  rows.splice(i, 1); persist(col); return true;
}

module.exports = { COLLECTIONS, DATA_DIR, create, update, get, list, remove, id };
