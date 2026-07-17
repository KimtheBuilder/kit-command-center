const store = require('./store');
const { seed } = require('./seed');
const { assertStartupSecurity } = require('./security');

async function prepare() {
  assertStartupSecurity();
  await store.initialize();
  seed();
  await store.flush();
  return store.health();
}

module.exports = { prepare };
