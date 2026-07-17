const fs = require('fs');
const path = require('path');
const store = require('../src/store');

const inputDir = path.resolve(process.env.JSON_IMPORT_DIR || path.join(__dirname, '..', 'data'));

async function importDirectory(directory) {
  const totals = {};
  await store.transaction(() => {
    for (const collection of store.COLLECTIONS.filter(name => name !== 'providers')) {
      const file = path.join(directory, collection + '.json');
      if (!fs.existsSync(file)) continue;
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error(file + ' must contain a JSON array.');
      if (collection === 'assets') {
        totals.providers = store.importRows('providers', rows.filter(row => row.record_type === 'provider'));
        totals.assets = store.importRows('assets', rows.filter(row => row.record_type !== 'provider'));
      } else {
        totals[collection] = store.importRows(collection, rows);
      }
    }
  });
  return totals;
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. JSON files are never modified by this importer.');
  await store.initialize();
  const totals = await importDirectory(inputDir);
  console.log(JSON.stringify({ input_dir: inputDir, imported: totals }, null, 2));
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { importDirectory, run };
