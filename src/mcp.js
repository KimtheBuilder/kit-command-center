// Remote MCP server — Streamable HTTP, JSON-RPC 2.0, path-segment token auth.
// Claude.ai custom connector URL:  https://<host>/mcp/<MCP_PATH_TOKEN>
// This matches the pattern already proven with Kim's KTB Agent Stack connector.
const express = require('express');
const store = require('./store');
const rules = require('./rules');
const reviews = require('./reviews');
const command = require('./command');
const cc = require('./modules/commandCenter');
const growth = require('./modules/growthAudit');
const governance = require('./modules/governance');
const cinematic = require('./modules/cinematic');
const nurture = require('./modules/nurture');
const events = require('./events');

const ACTOR = 'claude_mcp';

const TOOLS = [
  { name: 'get_command_center_summary', description: 'Full operator snapshot: open/blocked tasks, approvals, KPI health, hard truths, scale readiness, webinar cadence recommendation, next best actions, recent decisions.', schema: { type: 'object', properties: {} },
    run: () => cc.summary() },

  { name: 'ask_operator', description: 'Conversational command. Send natural language like "give me my weekly operator summary", "tell me the hard truth about what is slowing growth", "should I run more webinars or fix the funnel first", "what is the bottleneck", "what should I delegate, automate, or keep", "what are we waiting on me for". Returns a voice-ready answer with recommendation and next action.', schema: { type: 'object', properties: { text: { type: 'string', description: 'The question or command' } }, required: ['text'] },
    run: a => command.handle(a.text, ACTOR) },

  { name: 'create_goal', description: 'Create a business goal the command center will track and break into tasks.', schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, target_metric: { type: 'string' }, target_value: { type: 'number' }, due_date: { type: 'string' } }, required: ['title'] },
    run: a => cc.createGoal({ ...a, actor: ACTOR }) },

  { name: 'create_task', description: 'Create a task and route it to an agent. Agents: command_center, growth_audit, governance, cinematic_studio, nurture_automation. Delegation (founder/automate/VA) is auto-classified. impact/urgency/effort are 1-5.', schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, agent: { type: 'string' }, goal_id: { type: 'string' }, impact: { type: 'number' }, urgency: { type: 'number' }, effort: { type: 'number' }, revenue_linked: { type: 'boolean' }, due_date: { type: 'string' } }, required: ['title'] },
    run: a => cc.createTask({ ...a, actor: ACTOR }) },

  { name: 'list_tasks', description: 'Task board grouped by status (draft, in_progress, blocked, awaiting_approval, completed), sorted by priority score.', schema: { type: 'object', properties: {} },
    run: () => cc.taskBoard() },

  { name: 'update_task', description: 'Update a task: status, blocker, result, owner_type (founder|automate|delegate_va), impact/urgency/effort.', schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, blocker: { type: 'string' }, result: { type: 'string' }, owner_type: { type: 'string' }, impact: { type: 'number' }, urgency: { type: 'number' }, effort: { type: 'number' } }, required: ['id'] },
    run: a => { const { id, ...patch } = a; return cc.updateTask(id, patch, ACTOR); } },

  { name: 'request_approval', description: 'Create an approval request for a sensitive action (publish_content, site_change, workflow_change, spend). ONLY the owner can approve — this tool cannot approve anything.', schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, task_id: { type: 'string' }, payload: { type: 'string' } }, required: ['title'] },
    run: a => cc.requestApproval({ ...a, actor: ACTOR }) },

  { name: 'list_approvals', description: 'List approval requests and their status. Pending items are waiting on the owner.', schema: { type: 'object', properties: {} },
    run: () => store.list('approvals').reverse() },

  { name: 'record_kpi', description: 'Record a KPI reading. Metrics: leads_weekly, booked_calls_weekly, show_up_rate, close_rate, cost_per_lead, cost_per_acquisition, webinar_registration_rate, webinar_attendance_rate, webinar_cta_conversion_rate, nurture_open_rate, nurture_click_rate, content_pieces_weekly, masterclass_registrations, revenue_weekly. Rates as decimals (0.35 = 35%). period = YYYY-MM-DD.', schema: { type: 'object', properties: { metric: { type: 'string' }, value: { type: 'number' }, period: { type: 'string' }, source: { type: 'string' } }, required: ['metric', 'value'] },
    run: a => { const kpi = store.create('kpis', { metric: a.metric, value: Number(a.value), period: a.period || new Date().toISOString().slice(0, 10), source: a.source || 'mcp' }, 'kpi'); events.log(ACTOR, 'kpi.recorded', 'kpi', kpi.id, a.metric + '=' + a.value); return kpi; } },

  { name: 'get_kpi_health', description: 'Score every KPI against benchmarks: underperforming | on_track | strong | ready_to_scale | no_data, with trend.', schema: { type: 'object', properties: {} },
    run: () => rules.kpiHealthBoard() },

  { name: 'set_benchmark', description: 'Set or override a benchmark. direction: higher|lower. target = on-track threshold, scale_at = ready-to-scale threshold.', schema: { type: 'object', properties: { metric: { type: 'string' }, label: { type: 'string' }, target: { type: 'number' }, scale_at: { type: 'number' }, direction: { type: 'string' }, unit: { type: 'string' } }, required: ['metric', 'target', 'scale_at'] },
    run: a => store.create('benchmarks', a, 'bm') },

  { name: 'run_business_review', description: 'Generate and store a business review. Types: weekly_operator, monthly_growth, bottleneck, scale_readiness, campaign, funnel_health, founder_workload.', schema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
    run: a => reviews.run(a.type, ACTOR) },

  { name: 'get_hard_truths', description: 'The hard-truth panel: honest, severity-ranked statements about what is slowing growth, with actions.', schema: { type: 'object', properties: {} },
    run: () => rules.hardTruths() },

  { name: 'get_webinar_cadence_recommendation', description: 'KPI-driven webinar/masterclass cadence recommendation with reasoning (more, fewer, hold, or fix-first).', schema: { type: 'object', properties: {} },
    run: () => rules.webinarCadenceRecommendation() },

  { name: 'get_scale_readiness', description: 'Verdict on whether the business is ready to scale traffic/spend, based on scale-critical KPIs.', schema: { type: 'object', properties: {} },
    run: () => rules.scaleReadiness() },

  { name: 'create_growth_audit', description: 'Open a growth audit for a property: main_site, legacy_builders, legacy_academy, dm_bootcamp, coffee_credit_daypass. Returns audit with an 8-point growth checklist.', schema: { type: 'object', properties: { property: { type: 'string' }, notes: { type: 'string' } }, required: ['property'] },
    run: a => growth.createAudit({ ...a, actor: ACTOR }) },

  { name: 'add_audit_finding', description: 'Add a finding to any audit. severity: critical|high|medium|low. opportunity_score 1-10 = likely business impact.', schema: { type: 'object', properties: { audit_id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string' }, opportunity_score: { type: 'number' }, recommendation: { type: 'string' } }, required: ['audit_id', 'title'] },
    run: a => growth.addFinding({ ...a, actor: ACTOR }) },

  { name: 'list_audits', description: 'List audits, optionally filtered by module: growth, governance, nurture.', schema: { type: 'object', properties: { module: { type: 'string' } } },
    run: a => store.list('audits', x => !a.module || x.module === a.module).reverse() },

  { name: 'create_page_audit', description: 'Governance: open a page/funnel audit with 8 conversion checks (headline, CTA, trust, bridge, staleness, brand, friction, positioning). funnel_stage: traffic|optin|nurture|sales|checkout|thankyou.', schema: { type: 'object', properties: { url: { type: 'string' }, property: { type: 'string' }, funnel_stage: { type: 'string' } } },
    run: a => governance.createPageAudit({ ...a, actor: ACTOR }) },

  { name: 'draft_page_revision', description: 'Governance: draft a copy/section change for a page. NEVER publishes — goes to the draft revision queue for owner approval.', schema: { type: 'object', properties: { audit_id: { type: 'string' }, url: { type: 'string' }, section: { type: 'string' }, current_copy: { type: 'string' }, proposed_copy: { type: 'string' }, rationale: { type: 'string' }, severity: { type: 'string' } }, required: ['proposed_copy'] },
    run: a => governance.draftRevision({ ...a, actor: ACTOR }) },

  { name: 'create_cinematic_project', description: 'Cinematic Studio: create a premium promo asset project. channels: instagram_reel, instagram_story, youtube_long, youtube_short, website_hero, webinar_promo.', schema: { type: 'object', properties: { title: { type: 'string' }, offer: { type: 'string' }, campaign_goal: { type: 'string' }, channels: { type: 'array', items: { type: 'string' } } }, required: ['title'] },
    run: a => cinematic.createProject({ ...a, actor: ACTOR }) },

  { name: 'generate_creative_brief', description: 'Cinematic Studio: generate the KTB-branded creative brief for a project (audience, promise, tone, structure, channel specs) and advance it to storyboard.', schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    run: a => cinematic.generateBrief(a.project_id, ACTOR) },

  { name: 'add_storyboard_scene', description: 'Cinematic Studio: add a scene (hook, visual direction, caption, CTA, generation prompt) to a project storyboard.', schema: { type: 'object', properties: { project_id: { type: 'string' }, order: { type: 'number' }, hook: { type: 'string' }, visual_direction: { type: 'string' }, caption: { type: 'string' }, cta: { type: 'string' }, prompt: { type: 'string' } }, required: ['project_id'] },
    run: a => cinematic.addScene({ ...a, actor: ACTOR }) },

  { name: 'get_cinematic_project', description: 'Cinematic Studio: project status with scenes and render jobs.', schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
    run: a => cinematic.projectStatus(a.project_id) },

  { name: 'register_ghl_workflow', description: 'Nurture agent: register a GoHighLevel workflow in the inventory (name, trigger, funnel_stage, email_count, status).', schema: { type: 'object', properties: { name: { type: 'string' }, ghl_id: { type: 'string' }, trigger: { type: 'string' }, funnel_stage: { type: 'string' }, email_count: { type: 'number' }, status: { type: 'string' } }, required: ['name'] },
    run: a => nurture.registerWorkflow({ ...a, actor: ACTOR }) },

  { name: 'create_workflow_audit', description: 'Nurture agent: open a QA audit with 8 checks (broken logic, duplicate triggers, dead ends, outdated assets, tag consistency, orphan opt-ins, timing gaps, CTA alignment).', schema: { type: 'object', properties: { workflow_id: { type: 'string' }, scope: { type: 'string' } } },
    run: a => nurture.createWorkflowAudit({ ...a, actor: ACTOR }) },

  { name: 'record_workflow_qa_result', description: 'Nurture agent: record a QA check result on a workflow audit. result: pass|fail|na.', schema: { type: 'object', properties: { audit_id: { type: 'string' }, check: { type: 'string' }, result: { type: 'string' }, note: { type: 'string' } }, required: ['audit_id', 'check', 'result'] },
    run: a => nurture.recordQaResult(a.audit_id, a.check, a.result, a.note, ACTOR) },

  { name: 'draft_nurture_sequence', description: 'Nurture agent: store a drafted email sequence (emails: [{day, subject, purpose, cta}]) for owner review before it goes into GHL.', schema: { type: 'object', properties: { name: { type: 'string' }, funnel_stage: { type: 'string' }, emails: { type: 'array', items: { type: 'object', properties: { day: { type: 'number' }, subject: { type: 'string' }, purpose: { type: 'string' }, cta: { type: 'string' } } } } }, required: ['name'] },
    run: a => nurture.draftSequence({ ...a, actor: ACTOR }) },

  { name: 'log_campaign', description: 'Outcome tracking: log or update a campaign with effort_hours, spend, revenue, leads — feeds energy-vs-return analysis.', schema: { type: 'object', properties: { name: { type: 'string' }, offer: { type: 'string' }, effort_hours: { type: 'number' }, spend: { type: 'number' }, revenue: { type: 'number' }, leads: { type: 'number' }, status: { type: 'string' } }, required: ['name'] },
    run: a => { const c = store.create('campaigns', { name: a.name, offer: a.offer || null, effort_hours: Number(a.effort_hours || 0), spend: Number(a.spend || 0), revenue: Number(a.revenue || 0), leads: Number(a.leads || 0), status: a.status || 'active' }, 'cmp'); events.log(ACTOR, 'campaign.logged', 'campaign', c.id, a.name); return c; } },

  { name: 'log_decision', description: 'Record a business decision in the decision log (subject, decision, note).', schema: { type: 'object', properties: { subject: { type: 'string' }, decision: { type: 'string' }, note: { type: 'string' } }, required: ['subject', 'decision'] },
    run: a => store.create('decisions', a, 'dec') },

  { name: 'editor_list_zoom_recordings', description: 'List Kim\'s recent Zoom cloud recordings available to the KIT editor (topic, date, duration, meeting_id).', schema: { type: 'object', properties: { days: { type: 'number', description: 'Look back N days (default 30)' } } },
    run: async a => require('./zoom').listRecordings((a && a.days) || 30) },
  { name: 'editor_create_job', description: 'Start a KIT edit job: downloads the Zoom recording (by meeting_id) or a direct video URL, selects the best clips using Kim\'s protocol, and cuts horizontal master clips plus vertical 9:16 captioned shorts. Returns the job; poll editor_job_status for progress and download URLs.', schema: { type: 'object', properties: { source: { type: 'string', enum: ['zoom', 'url'] }, meeting_id: { type: 'string' }, video_url: { type: 'string' }, transcript_vtt: { type: 'string', description: 'WebVTT transcript (required for url jobs)' } }, required: ['source'] },
    run: a => require('./modules/editor').createJob({ ...a, actor: ACTOR }) },
  { name: 'editor_job_status', description: 'Get one edit job: status (queued/downloading/selecting_clips/cutting/done/failed), selected clips, and download URLs for finished video files.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: a => require('./modules/editor').getJob(a.id) },
  { name: 'editor_list_jobs', description: 'List recent KIT edit jobs with statuses and finished clip download URLs.', schema: { type: 'object', properties: {} },
    run: () => require('./modules/editor').listJobs() },
  { name: 'get_activity_log', description: 'Recent system events — full audit trail of who did what.', schema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: a => events.recent(a.limit || 40) }
];

function toolResult(id, data) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'kit-command-center', version: '1.0.0' },
      instructions: 'KIT is Kim the Builder\u2019s business operating system. Start with get_command_center_summary or ask_operator. Sensitive actions are approval-gated: use request_approval; only the owner approves in the dashboard.'
    } };
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return null; // no response to notifications
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) } };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === (params && params.name));
    if (!tool) return rpcError(id, -32602, 'Unknown tool: ' + (params && params.name));
    try {
      const data = await tool.run((params && params.arguments) || {});
      await store.flush();
      return toolResult(id, data);
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }] } };
    }
  }
  if (id === undefined) return null;
  return rpcError(id, -32601, 'Method not found: ' + method);
}

function mount(app) {
  const token = process.env.MCP_PATH_TOKEN;
  app.post('/mcp/:pathToken', express.json({ limit: '2mb' }), async (req, res) => {
    if (!token || req.params.pathToken !== token) return res.status(401).json(rpcError(null, -32000, 'Invalid connector token.'));
    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map(handleRpc))).filter(r => r !== null);
    if (!responses.length) return res.status(202).end();
    res.setHeader('Content-Type', 'application/json');
    return res.json(Array.isArray(body) ? responses : responses[0]);
  });
  app.get('/mcp/:pathToken', (req, res) => {
    if (!token || req.params.pathToken !== token) return res.status(401).end();
    // No server-initiated stream in V1; clients using Streamable HTTP treat 405 as "POST only".
    res.status(405).json({ error: 'SSE stream not enabled; POST JSON-RPC to this URL.' });
  });
  app.delete('/mcp/:pathToken', (req, res) => {
    if (!token || req.params.pathToken !== token) return res.status(401).end();
    return res.status(200).end();
  });
}

module.exports = { mount, TOOLS };
