// GoHighLevel integration — leads and pipeline data flow into KIT's dashboards.
// Env: GHL_API_KEY (Private Integration Token), GHL_LOCATION_ID (Settings → Business Profile).
// Auto-sync runs every 12h from server.js; manual sync via POST /api/ghl/sync or the ghl_sync MCP tool.
const store = require('./store');
const events = require('./events');

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function enabled() { return !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID); }

async function api(path, opts) {
  const res = await fetch(BASE + path, {
    ...(opts || {}),
    headers: {
      Authorization: 'Bearer ' + process.env.GHL_API_KEY,
      Version: VERSION,
      'Content-Type': 'application/json',
      ...((opts && opts.headers) || {})
    }
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('GHL API ' + res.status + ' on ' + path + (t ? ' — ' + t.slice(0, 160) : ''));
  }
  return res.json();
}

// New contacts created in the last N days = raw lead count.
async function newLeads(days) {
  const loc = process.env.GHL_LOCATION_ID;
  const since = new Date(Date.now() - (days || 7) * 86400000).toISOString();
  const body = {
    locationId: loc,
    pageLimit: 100,
    filters: [{ field: 'dateAdded', operator: 'gte', value: since }]
  };
  const d = await api('/contacts/search', { method: 'POST', body: JSON.stringify(body) });
  return { count: d.total != null ? d.total : (d.contacts || []).length, since };
}

// Pipelines with open opportunity counts + monetary value per stage.
async function pipelineSnapshot() {
  const loc = process.env.GHL_LOCATION_ID;
  const pl = await api('/opportunities/pipelines?locationId=' + encodeURIComponent(loc));
  const pipelines = pl.pipelines || [];
  const out = [];
  for (const p of pipelines.slice(0, 5)) {
    const opps = await api('/opportunities/search?location_id=' + encodeURIComponent(loc) + '&pipeline_id=' + encodeURIComponent(p.id) + '&status=open&limit=100');
    const list = opps.opportunities || [];
    out.push({
      pipeline: p.name,
      open_opportunities: opps.meta && opps.meta.total != null ? opps.meta.total : list.length,
      open_value: list.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0)
    });
  }
  return out;
}

// Pull from GHL → record into KIT KPIs + snapshot store. The automation Kim asked for.
async function sync(actor) {
  if (!enabled()) throw new Error('GHL not connected. Set GHL_API_KEY and GHL_LOCATION_ID in Render → Environment.');
  const result = { synced_at: new Date().toISOString() };
  const leads = await newLeads(7);
  result.leads_last_7_days = leads.count;
  store.create('kpis', { metric: 'leads_weekly', value: leads.count, period: new Date().toISOString().slice(0, 10), source: 'ghl_auto' }, 'kpi');
  try { result.pipelines = await pipelineSnapshot(); } catch (e) { result.pipelines_error = e.message; }
  store.create('assets', { kind: 'ghl_snapshot', data: result }, 'ghl');
  events.log(actor || 'ghl_sync', 'ghl.synced', 'ghl', null, leads.count + ' leads / 7d');
  return result;
}

function lastSnapshot() {
  const rows = store.list('assets', a => a.kind === 'ghl_snapshot');
  return rows.length ? rows[rows.length - 1].data : null;
}

async function status() {
  if (!enabled()) return { connected: false, hint: 'Set GHL_API_KEY and GHL_LOCATION_ID in Render → Environment.' };
  try {
    const leads = await newLeads(7);
    return { connected: true, reachable: true, leads_last_7_days: leads.count, last_sync: (lastSnapshot() || {}).synced_at || null };
  } catch (e) {
    return { connected: true, reachable: false, error: e.message };
  }
}

// Every 12 hours, dashboards feed themselves.
function startAutoSync() {
  if (!enabled()) return false;
  setTimeout(() => sync('ghl_auto').catch(() => {}), 20000); // first pull shortly after boot
  setInterval(() => sync('ghl_auto').catch(() => {}), 12 * 3600 * 1000);
  return true;
}

module.exports = { enabled, sync, status, newLeads, pipelineSnapshot, lastSnapshot, startAutoSync };
