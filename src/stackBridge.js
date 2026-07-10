// KTB Agent Stack bridge — makes the six business agents live INSIDE KIT.
// KIT calls the Agent Stack's MCP endpoint server-to-server (JSON-RPC).
// Configure with env: KTB_STACK_MCP_URL = https://ktb-agent-stack.onrender.com/mcp/<token>
// No key stored in code; the Agent Stack keeps running untouched.
const STACK_URL = process.env.KTB_STACK_MCP_URL || '';

let _tools = null; // cached tool list
let _id = 0;

function enabled() { return !!STACK_URL; }

async function rpc(method, params, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(STACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params: params || {} }),
      signal: ctl.signal
    });
    if (!res.ok) throw new Error('Agent Stack responded ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Agent Stack error');
    return data.result;
  } finally { clearTimeout(t); }
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

// Best-effort helpers used by the command router and the brain.
// Tool names follow the KTB Agent Stack; failures degrade gracefully.
async function ceoDashboard() { return callTool('get_ceo_dashboard_metrics', {}); }
async function weeklySummary() { return callTool('get_weekly_operator_summary', {}); }
async function contentCalendar() { return callTool('list_content_calendar', {}); }
async function sops() { return callTool('list_sops', {}); }
async function websiteStatus() { return callTool('list_website_status', {}); }

module.exports = { enabled, listTools, callTool, ceoDashboard, weeklySummary, contentCalendar, sops, websiteStatus };
