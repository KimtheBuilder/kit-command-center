// REST API layer — one namespace per module. If ADMIN_KEY is set, all /api
// routes require header x-admin-key. The MCP layer authenticates separately.
const express = require('express');
const store = require('./store');
const events = require('./events');
const rules = require('./rules');
const reviews = require('./reviews');
const command = require('./command');
const cc = require('./modules/commandCenter');
const growth = require('./modules/growthAudit');
const governance = require('./modules/governance');
const cinematic = require('./modules/cinematic');
const nurture = require('./modules/nurture');

const voice = require('./voice');
const { apiAuthentication, errorResponse, PublicError, securityLog } = require('./security');
const { requireFields, validateMutationBody } = require('./validation');

const router = express.Router();

router.use(apiAuthentication);
router.use(validateMutationBody);

voice.mount(router); // behind the admin key — TTS spends ElevenLabs credits

const ok = (res, data) => res.json({ ok: true, data });
const wrap = fn => async (req, res) => { try { const data = await fn(req); await store.flush(); ok(res, data); } catch (e) { errorResponse(res, e, { method: req.method, path: req.originalUrl }); } };

// ---- KTB Brand Kit (complete design system, machine-readable)
const brandKit = require('./brandKit');
router.get('/brand', (req, res) => res.json({ ok: true, data: brandKit.BRAND }));

// ---- KTB Agent Stack bridge diagnostics
const stackBridge = require('./stackBridge');
router.get('/stack/status', async (req, res) => { res.json({ ok: true, data: await stackBridge.status() }); });
router.get('/diagnostics', wrap(async () => ({
  service: 'kit-command-center',
  environment: process.env.NODE_ENV || 'development',
  persistence: await store.health(),
  integrations: {
    brain: require('./brain').enabled(), voice: require('./voice').enabled(),
    agent_stack: require('./stackBridge').enabled(), zoom: require('./zoom').enabled(), ghl: require('./ghl').enabled()
  }
})));

// ---- Command Center
router.get('/summary', wrap(() => cc.summary()));
router.post('/command', requireFields('text'), wrap(req => command.handle(req.body.text, req.securityActor)));
router.get('/goals', wrap(() => store.list('goals')));
router.post('/goals', requireFields('title'), wrap(req => cc.createGoal({ ...req.body, actor: req.securityActor })));
router.get('/tasks', wrap(() => cc.taskBoard()));
router.post('/tasks', requireFields('title'), wrap(req => cc.createTask({ ...req.body, actor: req.securityActor })));
router.patch('/tasks/:id', wrap(req => cc.updateTask(req.params.id, req.body, req.securityActor)));
router.get('/approvals', wrap(() => store.list('approvals').reverse()));
router.post('/approvals', requireFields('title'), wrap(req => cc.requestApproval({ ...req.body, actor: req.securityActor })));
router.post('/approvals/:id/decide', async (req, res) => {
  const id = req.params.id;
  const decision = req.body.decision;
  events.log(req.securityActor, 'approval.attempted', 'approval', id, decision || 'missing_decision');
  securityLog('approval_attempt', { approval_id: id, decision, authenticated_owner: req.authenticatedOwner, ip: req.ip });
  try {
    await store.flush();
    if (!req.authenticatedOwner) throw new PublicError('Only the authenticated owner can decide approvals.', 403);
    ok(res, await store.transaction(() => cc.decideApproval(id, decision, req.body.note, req.securityActor)));
  } catch (error) {
    events.log(req.securityActor, 'approval.attempt_failed', 'approval', id, error.message);
    await store.flush().catch(() => {});
    errorResponse(res, error, { method: req.method, path: req.originalUrl });
  }
});
router.get('/agents', wrap(() => store.list('agents')));
router.post('/agents', requireFields('name'), wrap(req => cc.registerAgent({ ...req.body, actor: req.securityActor })));
router.get('/events', wrap(req => events.recent(Number(req.query.limit || 40))));
router.get('/decisions', wrap(() => store.list('decisions').reverse()));

// ---- KPIs & benchmarks
router.get('/kpis/health', wrap(() => rules.kpiHealthBoard()));
router.get('/kpis/:metric/history', wrap(req => rules.kpiHistory(req.params.metric, 12)));
router.post('/kpis', wrap(req => {
  const { metric, value, period, source } = req.body;
  if (!metric || value === undefined) throw new Error('metric and value required');
  const kpi = store.create('kpis', { metric, value: Number(value), period: period || new Date().toISOString().slice(0, 10), source: source || 'manual' }, 'kpi');
  events.log(req.securityActor, 'kpi.recorded', 'kpi', kpi.id, metric + '=' + value);
  return kpi;
}));
router.get('/benchmarks', wrap(() => rules.benchmarks()));
router.post('/benchmarks', wrap(req => {
  const b = store.create('benchmarks', req.body, 'bm');
  events.log(req.securityActor, 'benchmark.set', 'benchmark', b.id, b.metric);
  return b;
}));

// ---- Reviews & intelligence
router.get('/reviews', wrap(() => store.list('reviews').reverse().slice(0, 20)));
router.post('/reviews/:type', wrap(req => reviews.run(req.params.type, req.securityActor)));
router.get('/intel/hard-truths', wrap(() => rules.hardTruths()));
router.get('/intel/webinar-cadence', wrap(() => rules.webinarCadenceRecommendation()));
router.get('/intel/scale-readiness', wrap(() => rules.scaleReadiness()));
router.get('/intel/what-matters', wrap(() => growth.whatMattersThisWeek()));

// ---- Growth audit agent
router.get('/growth/properties', wrap(() => growth.PROPERTIES));
router.post('/growth/audits', wrap(req => growth.createAudit({ ...req.body, actor: req.securityActor })));
router.get('/audits', wrap(req => store.list('audits', a => !req.query.module || a.module === req.query.module).reverse()));
router.post('/findings', wrap(req => growth.addFinding({ ...req.body, actor: req.securityActor })));
router.get('/findings', wrap(() => store.list('findings').reverse()));
router.patch('/findings/:id', wrap(req => { const f = store.update('findings', req.params.id, req.body); if (!f) throw new Error('not found'); return f; }));
router.get('/growth/opportunities', wrap(() => growth.growthOpportunities()));

// ---- Governance agent
router.post('/governance/audits', wrap(req => governance.createPageAudit({ ...req.body, actor: req.securityActor })));
router.post('/governance/audits/:id/check', wrap(req => governance.recordCheck(req.params.id, req.body.check, req.body.result, req.body.note, req.securityActor)));
router.post('/governance/revisions', wrap(req => governance.draftRevision({ ...req.body, actor: req.securityActor })));
router.get('/governance/revisions', wrap(() => store.list('workflows', w => w.kind === 'page_revision').reverse()));

// ---- Cinematic studio
router.get('/cinematic/projects', wrap(() => store.list('cinematic_projects').reverse()));
router.post('/cinematic/projects', wrap(req => cinematic.createProject({ ...req.body, actor: req.securityActor })));
router.post('/cinematic/projects/:id/brief', wrap(req => cinematic.generateBrief(req.params.id, req.securityActor)));
router.get('/cinematic/projects/:id', wrap(req => cinematic.projectStatus(req.params.id)));
router.post('/cinematic/scenes', wrap(req => cinematic.addScene({ ...req.body, actor: req.securityActor })));
router.post('/cinematic/providers', wrap(req => cinematic.registerProvider({ ...req.body, actor: req.securityActor })));
router.post('/cinematic/render', wrap(req => cinematic.queueRender({ ...req.body, actor: req.securityActor })));
router.patch('/cinematic/assets/:id', wrap(req => cinematic.updateAsset(req.params.id, req.body, req.securityActor)));

// ---- Nurture agent
router.get('/nurture/inventory', wrap(() => nurture.inventory()));
router.post('/nurture/workflows', wrap(req => nurture.registerWorkflow({ ...req.body, actor: req.securityActor })));
router.post('/nurture/audits', wrap(req => nurture.createWorkflowAudit({ ...req.body, actor: req.securityActor })));
router.post('/nurture/audits/:id/check', wrap(req => nurture.recordQaResult(req.params.id, req.body.check, req.body.result, req.body.note, req.securityActor)));
router.post('/nurture/sequences', wrap(req => nurture.draftSequence({ ...req.body, actor: req.securityActor })));

// ---- Editor (Kim's own video editor)
const editor = require('./modules/editor');
const zoomApi = require('./zoom');
router.get('/editor/zoom-status', wrap(() => ({ connected: zoomApi.enabled() })));
router.get('/editor/recordings', wrap(async req => { if (!zoomApi.enabled()) throw new Error('Zoom not connected — set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.'); return zoomApi.listRecordings(Number(req.query.days || 30)); }));
router.get('/editor/jobs', wrap(() => editor.listJobs()));
router.get('/editor/jobs/:id', wrap(req => editor.getJob(req.params.id)));
router.post('/editor/jobs', wrap(req => editor.createJob({ ...req.body, actor: req.securityActor })));

// ---- GoHighLevel (leads + pipeline feed KIT automatically)
const ghl = require('./ghl');
router.get('/ghl/status', wrap(() => ghl.status()));
router.post('/ghl/sync', wrap(req => ghl.sync(req.securityActor)));
router.get('/ghl/snapshot', wrap(() => ghl.lastSnapshot()));

// ---- Campaigns (outcome tracking)
router.get('/campaigns', wrap(() => store.list('campaigns').reverse()));
router.post('/campaigns', wrap(req => {
  const c = store.create('campaigns', { name: req.body.name, offer: req.body.offer || null, effort_hours: Number(req.body.effort_hours || 0), spend: Number(req.body.spend || 0), revenue: Number(req.body.revenue || 0), leads: Number(req.body.leads || 0), status: req.body.status || 'active' }, 'cmp');
  events.log(req.securityActor, 'campaign.logged', 'campaign', c.id, c.name);
  return c;
}));
router.patch('/campaigns/:id', wrap(req => { const c = store.update('campaigns', req.params.id, req.body); if (!c) throw new Error('not found'); return c; }));

module.exports = router;
