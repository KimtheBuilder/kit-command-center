// KIT Command Center — secured Node.js + Express entrypoint.
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const api = require('./src/api');
const mcp = require('./src/mcp');
const { seed } = require('./src/seed');
const { assertStartupSecurity, errorResponse, securityLog } = require('./src/security');
const editor = require('./src/modules/editor');
const { mountMedia } = require('./src/media');
const store = require('./src/store');
const { prepare } = require('./src/startup');

function createApp() {
  assertStartupSecurity();
  const app = express();
  const proxyHops = process.env.TRUST_PROXY_HOPS === undefined ? (process.env.NODE_ENV === 'production' ? 1 : 0) : Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 2) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 2.');
  app.set('trust proxy', proxyHops);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      }
    }
  }));
  app.use(express.json({ limit: '2mb', strict: true }));

  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.API_RATE_LIMIT || 300), standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/mcp', rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.MCP_RATE_LIMIT || 120), standardHeaders: 'draft-7', legacyHeaders: false }));

  mcp.mount(app);
  app.use('/api', api);
  mountMedia(app, editor.MEDIA_ROOT);
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (req, res) => res.json({ ok: true, service: 'kit-command-center' }));
  app.get('/ready', async (req, res) => {
    try { await store.health(); return res.json({ ok: true, service: 'kit-command-center', ready: true }); }
    catch { return res.status(503).json({ ok: false, service: 'kit-command-center', ready: false }); }
  });
  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      error.expose = true; error.status = 400; error.message = 'Invalid JSON body.';
    }
    return errorResponse(res, error, { method: req.method, path: req.originalUrl });
  });

  if (!process.env.DATABASE_URL) seed();
  return app;
}

async function start() {
  await prepare();
  const app = createApp();
  if (require('./src/ghl').startAutoSync()) console.log('GHL auto-sync ON — leads & pipeline every 12h');
  const port = Number(process.env.PORT || 3000);
  return app.listen(port, () => {
    console.log('KIT Command Center running on port ' + port);
    securityLog('server_started', { port, environment: process.env.NODE_ENV || 'development' });
  });
}

if (require.main === module) start().catch(error => { console.error('Startup failed: ' + error.message); process.exitCode = 1; });
module.exports = { createApp, start };
