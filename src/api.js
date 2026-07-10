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

const router = express.Router();

router.use((req, res, next) => {
  const key = process.env.ADMIN_KEY;
  if (key && req.get('x-admin-key') !== key) return res.status(401).json({ error: 'Missing or invalid x-admin-key header.' });
  next();
});

voice.mount(router); // behind the admin key — TTS spends ElevenLabs credits

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, err) => res.status(400).json({ ok: false, error: err.message || String(err) });
const wrap = fn => async (req, res) => { try { ok(res, await fn(req)); } catch (e) { fail(res, e); } };

// ---- KTB Brand Kit (complete design system, machine-readable)
const brandKit = require('./brandKit');
router.get('/brand', (req, res) => res.json({ ok: true, data: brandKit.BRAND }));

// ---- KTB Agent Stack bridge diagnostics
const stackBridge = require('./stackBridge');
router.get('/stack/status', async (req, res) => { res.json({ ok: true, data: await stackBridge.status() }); });

// ---- Command Center
router.get('/summary', wrap(() => cc.summary()));
router.post('/command', wrap(req => command.handle(req.body.text, req.body.actor || 'owner')));
router.get('/goals', wrap(() => store.list('goals')));
router.post('/goals', wrap(req => cc.createGoal(req.body)));
router.get('/tasks', wrap(() => cc.taskBoard()));
router.post('/tasks', wrap(req => cc.createTask(req.body)));
router.patch('/tasks/:id', wrap(req => cc.updateTask(req.params.id, req.body, req.body.actor)));
router.get('/approvals', wrap(() => store.list('approvals').reverse()));
router.post('/approvals', wrap(req => cc.requestApproval(req.body)));
router.post('/approvals/:id/decide', wrap(req => cc.decideApproval(req.params.id, req.body.decision, req.body.note, req.body.actor || 'owner')));
router.get('/agents', wrap(() => store.list('agents')));
router.post('/agents', wrap(req => cc.registerAgent(req.body)));
router.get('/events', wrap(req => events.recent(Number(req.query.limit || 40))));
router.get('/decisions', wrap(() => store.list('decisions').reverse()));

// ---- KPIs & benchmarks
router.get('/kpis/health', wrap(() => rules.kpiHealthBoard()));
router.get('/kpis/:metric/history', wrap(req => rules.kpiHistory(req.params.metric, 12)));
router.post('/kpis', wrap(req => {
  const { metric, value, period, source } = req.body;
  if (!metric || value === undefined) throw new Error('metric and value required');
  const kpi = store.create('kpis', { metric, value: Number(value), period: period || new Date().toISOString().slice(0, 10), source: source || 'manual' }, 'kpi');
  events.log(req.body.actor, 'kpi.recorded', 'kpi', kpi.id, metric + '=' + value);
  return kpi;
}));
router.get('/benchmarks', wrap(() => rules.benchmarks()));
router.post('/benchmarks', wrap(req => {
  const b = store.create('benchmarks', req.body, 'bm');
  events.log(req.body.actor, 'benchmark.set', 'benchmark', b.id, b.metric);
  return b;
}));

// ---- Reviews & intelligence
router.get('/reviews', wrap(() => store.list('reviews').reverse().slice(0, 20)));
router.post('/reviews/:type', wrap(req => reviews.run(req.params.type, req.body.actor)));
router.get('/intel/hard-truths', wrap(() => rules.hardTruths()));
router.get('/intel/webinar-cadence', wrap(() => rules.webinarCadenceRecommendation()));
router.get('/intel/scale-readiness', wrap(() => rules.scaleReadiness()));
router.get('/intel/what-matters', wrap(() => growth.whatMattersThisWeek()));

// ---- Growth audit agent
router.get('/growth/properties', wrap(() => growth.PROPERTIES));
router.post('/growth/audits', wrap(req => growth.createAudit(req.body)));
router.get('/audits', wrap(req => store.list('audits', a => !req.query.module || a.module === req.query.module).reverse()));
router.post('/findings', wrap(req => growth.addFinding(req.body)));
router.get('/findings', wrap(() => store.list('findings').reverse()));
router.patch('/findings/:id', wrap(req => { const f = store.update('findings', req.params.id, req.body); if (!f) throw new Error('not found'); return f; }));
router.get('/growth/opportunities', wrap(() => growth.growthOpportunities()));

// ---- Governance agent
router.post('/governance/audits', wrap(req => governance.createPageAudit(req.body)));
router.post('/governance/audits/:id/check', wrap(req => governance.recordCheck(req.params.id, req.body.check, req.body.result, req.body.note, req.body.actor)));
router.post('/governance/revisions', wrap(req => governance.draftRevision(req.body)));
router.get('/governance/revisions', wrap(() => store.list('workflows', w => w.kind === 'page_revision').reverse()));

// ---- Cinematic studio
router.get('/cinematic/projects', wrap(() => store.list('cinematic_projects').reverse()));
router.post('/cinematic/projects', wrap(req => cinematic.createProject(req.body)));
router.post('/cinematic/projects/:id/brief', wrap(req => cinematic.generateBrief(req.params.id, req.body.actor)));
router.get('/cinematic/projects/:id', wrap(req => cinematic.projectStatus(req.params.id)));
router.post('/cinematic/scenes', wrap(req => cinematic.addScene(req.body)));
router.post('/cinematic/providers', wrap(req => cinematic.registerProvider(req.body)));
router.post('/cinematic/render', wrap(req => cinematic.queueRender(req.body)));
router.patch('/cinematic/assets/:id', wrap(req => cinematic.updateAsset(req.params.id, req.body, req.body.actor)));

// ---- Nurture agent
router.get('/nurture/inventory', wrap(() => nurture.inventory()));
router.post('/nurture/workflows', wrap(req => nurture.registerWorkflow(req.body)));
router.post('/nurture/audits', wrap(req => nurture.createWorkflowAudit(req.body)));
router.post('/nurture/audits/:id/check', wrap(req => nurture.recordQaResult(req.params.id, req.body.check, req.body.result, req.body.note, req.body.actor)));
router.post('/nurture/sequences', wrap(req => nurture.draftSequence(req.body)));

// ---- Campaigns (outcome tracking)
router.get('/campaigns', wrap(() => store.list('campaigns').reverse()));
router.post('/campaigns', wrap(req => {
  const c = store.create('campaigns', { name: req.body.name, offer: req.body.offer || null, effort_hours: Number(req.body.effort_hours || 0), spend: Number(req.body.spend || 0), revenue: Number(req.body.revenue || 0), leads: Number(req.body.leads || 0), status: req.body.status || 'active' }, 'cmp');
  events.log(req.body.actor, 'campaign.logged', 'campaign', c.id, c.name);
  return c;
}));
router.patch('/campaigns/:id', wrap(req => { const c = store.update('campaigns', req.params.id, req.body); if (!c) throw new Error('not found'); return c; }));

module.exports = router;
