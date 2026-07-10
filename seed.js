// First-boot seed: agent registry only. No fake KPIs — the system stays honest.
const store = require('./store');
const cc = require('./modules/commandCenter');

const AGENTS = [
  { key: 'command_center',     name: 'Command Center',                 role: 'Goal intake, task routing, approvals, operator summaries, hard truths.' },
  { key: 'growth_audit',       name: 'Platform Audit & Growth Agent',  role: 'Audits offers, platforms, funnels; scores growth opportunities; channel priority.' },
  { key: 'governance',         name: 'Website & Funnel Governance',    role: 'Page audits, CTA/trust/friction checks, draft revisions. Never publishes.' },
  { key: 'cinematic_studio',   name: 'Cinematic Studio',               role: 'Creative briefs, storyboards, render pipeline, campaign assets.' },
  { key: 'nurture_automation', name: 'Workflow & Nurture Automation',  role: 'GHL workflow inventory, QA audits, sequence drafts.' }
];

// Cinematic providers Kim already uses. Both connect as MCP connectors in
// Claude.ai — no API keys are stored here. KIT tracks briefs, storyboards,
// and render jobs; Claude executes generation through the connectors.
const PROVIDERS = [
  { name: 'Higgsfield', kind: 'video', base_url: 'https://mcp.higgsfield.ai/mcp',
    notes: 'Connected as a Claude.ai MCP connector. Images, video, 3D, motion control, upscaling. Claude calls it directly; KIT holds the brief + storyboard.' },
  { name: 'Kling AI', kind: 'video', base_url: null,
    notes: 'Connect via Kling MCP in Claude.ai connectors. Cinematic video generation for Studio scenes. Paste each scene prompt from the storyboard.' }
];

function seed() {
  if (store.list('agents').length) return;
  AGENTS.forEach(a => cc.registerAgent({ ...a, actor: 'system' }));
  const cinematic = require('./modules/cinematic');
  PROVIDERS.forEach(p => cinematic.registerProvider({ ...p, actor: 'system' }));
}

module.exports = { seed };
