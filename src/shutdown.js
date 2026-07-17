const database = require('./database');
const ghl = require('./ghl');
const store = require('./store');
const { securityLog } = require('./security');

let shutdownPromise;

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function gracefulShutdown(server, signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    securityLog('server_shutdown_started', { signal });
    ghl.stopAutoSync();
    const closing = closeServer(server);
    const results = await Promise.allSettled([store.flush(), closing]);
    await database.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    securityLog('server_shutdown_completed', { signal });
  })();
  return shutdownPromise;
}

function installSignalHandlers(server) {
  const handler = signal => {
    gracefulShutdown(server, signal)
      .then(() => { process.exitCode = 0; })
      .catch(error => {
        securityLog('server_shutdown_failed', { signal, error_name: error.name });
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
  return handler;
}

function resetForTests() { shutdownPromise = null; }

module.exports = { gracefulShutdown, installSignalHandlers, resetForTests };
