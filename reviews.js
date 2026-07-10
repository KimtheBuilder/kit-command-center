// Business Review Engine — weekly operator, monthly growth, bottleneck,
// scale-readiness, campaign, funnel health, founder workload.
const store = require('./store');
const events = require('./events');
const rules = require('./rules');
const cc = require('./modules/commandCenter');
const growth = require('./modules/growthAudit');

const REVIEW_TYPES = ['weekly_operator', 'monthly_growth', 'bottleneck', 'scale_readiness', 'campaign', 'funnel_health', 'founder_workload'];

function build(type) {
  const board = rules.kpiHealthBoard();
  const truths = rules.hardTruths();
  const summary = cc.summary();
  const sections = { type, generated_at: new Date().toISOString() };

  if (type === 'weekly_operator' || type === 'monthly_growth') {
    sections.headline = truths[0] ? truths[0].truth : 'No red flags in logged data.';
    sections.kpi_board = board;
    sections.hard_truths = truths;
    sections.what_matters = growth.whatMattersThisWeek();
    sections.webinar_cadence = rules.webinarCadenceRecommendation();
    sections.scale_readiness = rules.scaleReadiness();
    sections.execution = {
      open_tasks: summary.open_tasks, blocked: summary.blocked,
      awaiting_approval: summary.awaiting_approval, founder_owned_pct: summary.founder_owned_pct
    };
    sections.next_best_actions = summary.next_best_actions;
  }
  if (type === 'bottleneck') {
    const pending = store.list('approvals', a => a.status === 'pending');
    const blocked = store.list('tasks', t => t.status === 'blocked');
    sections.waiting_on_owner = pending.map(p => ({ id: p.id, title: p.title, age_days: Math.floor((Date.now() - new Date(p.created_at)) / 86400000) }));
    sections.blocked_tasks = blocked.map(t => ({ id: t.id, title: t.title, blocker: t.blocker }));
    sections.verdict = pending.length > blocked.length
      ? 'Primary bottleneck: owner approvals. The system is waiting on you.'
      : blocked.length ? 'Primary bottleneck: blocked tasks. Unblock or kill them.' : 'No structural bottleneck in logged work.';
  }
  if (type === 'scale_readiness') {
    sections.readiness = rules.scaleReadiness();
    sections.kpi_board = board.filter(b => ['leads_weekly','show_up_rate','close_rate','webinar_cta_conversion_rate','nurture_click_rate','cost_per_lead'].includes(b.metric));
    sections.webinar_cadence = rules.webinarCadenceRecommendation();
  }
  if (type === 'campaign') {
    sections.campaigns = store.list('campaigns');
    sections.energy_vs_return = sections.campaigns.map(c => ({
      campaign: c.name,
      verdict: (c.revenue || 0) === 0 && (c.effort_hours || 0) > 10
        ? 'Consuming effort without return \u2014 cut or overhaul'
        : (c.revenue || 0) / Math.max(1, c.effort_hours || 1) > 200 ? 'Strong return per hour \u2014 candidate to scale' : 'Monitor'
    }));
  }
  if (type === 'funnel_health') {
    sections.open_findings = store.list('findings', f => f.status === 'open');
    sections.critical = sections.open_findings.filter(f => f.severity === 'critical');
    sections.by_property = {};
    growth.PROPERTIES.forEach(p => sections.by_property[p.key] = sections.open_findings.filter(f => f.property === p.key).length);
  }
  if (type === 'founder_workload') {
    const open = store.list('tasks', t => t.status !== 'completed');
    sections.founder_tasks = open.filter(t => t.owner_type === 'founder');
    sections.should_automate = open.filter(t => t.owner_type === 'automate');
    sections.should_delegate = open.filter(t => t.owner_type === 'delegate_va');
    sections.verdict = sections.founder_tasks.length > (sections.should_automate.length + sections.should_delegate.length)
      ? 'Founder load is too high relative to system-owned work. Reassign before adding new projects.'
      : 'Workload distribution is reasonable \u2014 keep founder time on teaching, selling, deciding.';
  }
  return sections;
}

function run(type, actor) {
  if (!REVIEW_TYPES.includes(type)) throw new Error('Unknown review type. Use: ' + REVIEW_TYPES.join(', '));
  const content = build(type);
  const review = store.create('reviews', { type, content }, 'rev');
  events.log(actor, 'review.generated', 'review', review.id, type);
  return review;
}

module.exports = { REVIEW_TYPES, build, run };
