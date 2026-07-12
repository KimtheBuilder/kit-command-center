// KIT Command Center — Kim the Builder's business operating system.
// Plain Node.js + Express. No build step. Start: node server.js
const express = require('express');
const path = require('path');
const api = require('./src/api');
const mcp = require('./src/mcp');
const { seed } = require('./src/seed');
const store = require('./src/store');

const app = express();
app.use(express.json({ limit: '2mb' }));

mcp.mount(app);                       // /mcp/:pathToken  (Claude custom connector)
app.use('/api', api);                 // REST API for the dashboard + integrations
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(require('./src/modules/editor').MEDIA_ROOT, { maxAge: '1h' }));
if (require('./src/ghl').startAutoSync()) console.log('GHL auto-sync ON — leads & pipeline every 12h');
app.get('/health', (req, res) => res.json({ ok: true, service: 'kit-command-center', data_dir: store.DATA_DIR, mcp_configured: !!process.env.MCP_PATH_TOKEN, admin_key_set: !!process.env.ADMIN_KEY }));

seed();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('KIT Command Center running on port ' + PORT);
  console.log('Data dir: ' + store.DATA_DIR);
  console.log('MCP token ' + (process.env.MCP_PATH_TOKEN ? 'SET \u2014 connector URL: /mcp/<token>' : 'NOT SET \u2014 set MCP_PATH_TOKEN env var'));
});
