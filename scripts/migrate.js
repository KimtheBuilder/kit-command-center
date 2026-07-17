const database = require('../src/database');
const direction = process.argv[2] === 'down' ? 'down' : 'up';
const target = process.env.DB_MIGRATION_TARGET === undefined ? undefined : Number(process.env.DB_MIGRATION_TARGET);
(async () => {
  try {
    await database.migrate(direction, target);
    console.log('Database migration ' + direction + ' completed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
})();
