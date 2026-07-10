// KTB Agent Stack bridge — makes the six business agents live INSIDE KIT.
// KIT calls the Agent Stack's MCP endpoint server-to-server (JSON-RPC over HTTP).
// Configure with env: KTB_STACK_MCP_URL = https://ktb-agent-stack.onrender.com/mcp/<token>
// Handles both plain-JSON and SSE-style (streamable HTTP) MCP servers,
// with automatic initialize + session handling if the server requires it.
const STACK_URL = (process.env.KTB_STACK_MCP_URL || '').trim().replace(/\/$/, '');

let _tools = null;
let _id = 0;
let _sessionId = null;
let _initialized = false;

function enabled() { return !!STACK_URL; }

function parseBody(text, contentType) {
  // SSE-style response: pull the last data: line. Otherwise plain JSON.
  if ((contentType || '').includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    if (!lines.length) throw new Error('SSE response contained no data');
    return JSON.parse(lines[lines.length - 1].slice(5).trim());
  }
  return JSON.parse(text);
}

async function rawRpc(method, params, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (_sessionId) headers['Mcp-Session-Id'] = _sessionId;
    const res = await fetch(STACK_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params: params || {} }),
      signal: ctl.signal
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) _sessionId = sid;
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 200);
      const err = new Error('HTTP ' + res.status + (snippet ? ' — ' + snippet : ''));
      err.status = res.status;
      throw err;
    }
    const data = parseBody(text, res.headers.get('content-type'));
    if (data.error) {
      const err = new Error(data.error.message || 'Agent Stack JSON-RPC error');
      err.rpc = true;
      throw err;
    }
    return data.result;
  } finally { clearTimeout(t); }
}

async function ensureInit() {
  if (_initialized) return;
  try {
    await rawRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'kit-command-center', version: '1.0.0' }
    });
    try { await rawRpc('notifications/initialized', {}); } catch (e) { /* some servers skip this */ }
    _initialized = true;
  } catch (e) {
    // Hand-rolled servers often don't need initialize at all — carry on.
    _initialized = true;
  }
}

async function rpc(method, params, timeoutMs) {
  try {
    return await rawRpc(method, params, timeoutMs);
  } catch (e) {
    if (e.status === 429) throw e; // rate-limited: retrying makes it worse
    // Retry once after a fresh initialize — covers session-required servers
    // and Render free-tier cold starts.
    _initialized = false; _sessionId = null;
    await ensureInit();
    return await rawRpc(method, params, timeoutMs);
  }
}

async function listTools() {
  if (_tools) return _tools;
  const r = await rpc('tools/list');
  _tools = (r && r.tools) || [];
  return _tools;
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const text = ((r && r.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Diagnostic: one call that reports exactly what is or isn't working.
let _statusCache = null, _statusAt = 0;
async function status() {
  if (!enabled()) return { configured: false, hint: 'Set KTB_STACK_MCP_URL in Render → Environment.' };
  if (_statusCache && Date.now() - _statusAt < 60000) return _statusCache;
  const report = { configured: true, url_host: STACK_URL.replace(/^https?:\/\//, '').split('/')[0], reachable: false, tools: 0, error: null, hint: null };
  try {
    const tools = await listTools();
    report.reachable = true;
    report.tools = tools.length;
    report.tool_names = tools.slice(0, 30).map(t => t.name);
  } catch (e) {
    report.error = e.message;
    if (e.status === 401 || e.status === 403) report.hint = 'The token in KTB_STACK_MCP_URL is wrong. Copy the exact connector URL you used in Claude.ai.';
    else if (e.status === 404) report.hint = 'URL path is wrong — it must end with /mcp/YOUR-TOKEN, no trailing slash.';
    else if (String(e.message).includes('abort')) report.hint = 'Timed out — the Agent Stack may be asleep on Render free tier. Open its dashboard URL to wake it, wait 60s, retry.';
    else if (e.status === 429) report.hint = 'The Agent Stack is rate-limiting requests. It recovers on its own — wait about a minute and refresh.';
    else report.hint = 'Check the full URL for typos, then retry once the Agent Stack is awake.';
  }
  _statusCache = report; _statusAt = Date.now();
  return report;
}

async function ceoDashboard() { return callTool('get_ceo_dashboard_metrics', {}); }
async function weeklySummary() { return callTool('get_weekly_operator_summary', {}); }
async function contentCalendar() { return callTool('list_content_calendar', {}); }
async function sops() { return callTool('list_sops', {}); }
async function websiteStatus() { return callTool('list_website_status', {}); }

module.exports = { enabled, listTools, callTool, status, ceoDashboard, weeklySummary, contentCalendar, sops, websiteStatus };
