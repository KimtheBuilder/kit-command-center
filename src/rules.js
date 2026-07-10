// Rules engine: benchmark comparison, priority scoring, webinar cadence,
// hard truths, delegation logic, scale readiness. This is KIT's operator brain.
const store = require('./store');

const DEFAULT_BENCHMARKS = [
  { metric: 'leads_weekly',                 label: 'New leads / week',            target: 25,   scale_at: 50,   direction: 'higher', unit: 'count' },
  { metric: 'booked_calls_weekly',          label: 'Booked calls / week',         target: 5,    scale_at: 12,   direction: 'higher', unit: 'count' },
  { metric: 'show_up_rate',                 label: 'Call show-up rate',           target: 0.60, scale_at: 0.75, direction: 'higher', unit: 'rate' },
  { metric: 'close_rate',                   label: 'Close rate',                  target: 0.20, scale_at: 0.30, direction: 'higher', unit: 'rate' },
  { metric: 'cost_per_lead',                label: 'Cost per lead',               target: 8,    scale_at: 5,    direction: 'lower',  unit: 'usd' },
  { metric: 'cost_per_acquisition',         label: 'Cost per acquisition',        target: 300,  scale_at: 200,  direction: 'lower',  unit: 'usd' },
  { metric: 'webinar_registration_rate',    label: 'Webinar registration rate',   target: 0.30, scale_at: 0.45, direction: 'higher', unit: 'rate' },
  { metric: 'webinar_attendance_rate',      label: 'Webinar attendance rate',     target: 0.40, scale_at: 0.55, direction: 'higher', unit: 'rate' },
  { metric: 'webinar_cta_conversion_rate',  label: 'Webinar CTA conversion',      target: 0.10, scale_at: 0.15, direction: 'higher', unit: 'rate' },
  { metric: 'nurture_open_rate',            label: 'Nurture email open rate',     target: 0.35, scale_at: 0.45, direction: 'higher', unit: 'rate' },
  { metric: 'nurture_click_rate',           label: 'Nurture email click rate',    target: 0.03, scale_at: 0.06, direction: 'higher', unit: 'rate' },
  { metric: 'content_pieces_weekly',        label: 'Content pieces / week',       target: 5,    scale_at: 8,    direction: 'higher', unit: 'count' },
  { metric: 'masterclass_registrations',    label: 'Masterclass registrations',   target: 60,   scale_at: 120,  direction: 'higher', unit: 'count' },
  { metric: 'revenue_weekly',               label: 'Revenue / week',              target: 5000, scale_at: 10000,direction: 'higher', unit: 'usd' }
];

function benchmarks() {
  const rows = store.list('benchmarks');
  return rows.length ? rows : DEFAULT_BENCHMARKS.map(b => ({ id: 'bm_' + b.metric, ...b }));
}

function latestKpi(metric) {
  const rows = store.list('kpis', k => k.metric === metric)
    .sort((a, b) => (a.period || a.created_at) < (b.period || b.created_at) ? -1 : 1);
  return rows[rows.length - 1] || null;
}

function kpiHistory(metric, n) {
  return store.list('kpis', k => k.metric === metric)
    .sort((a, b) => (a.period || a.created_at) < (b.period || b.created_at) ? -1 : 1)
    .slice(-1 * (n || 8));
}

// Returns: no_data | underperforming | on_track | strong | ready_to_scale
function scoreMetric(metric) {
  const bm = benchmarks().find(b => b.metric === metric);
  const kpi = latestKpi(metric);
  if (!bm) return { metric, status: 'no_benchmark', value: kpi ? kpi.value : null };
  if (!kpi) return { metric, label: bm.label, status: 'no_data', value: null, target: bm.target };
  const v = Number(kpi.value);
  let status;
  if (bm.direction === 'lower') {
    if (v <= bm.scale_at) status = 'ready_to_scale';
    else if (v <= bm.target) status = 'strong';
    else if (v <= bm.target * 1.25) status = 'on_track';
    else status = 'underperforming';
  } else {
    if (v >= bm.scale_at) status = 'ready_to_scale';
    else if (v >= bm.target * 1.1) status = 'strong';
    else if (v >= bm.target * 0.8) status = 'on_track';
    else status = 'underperforming';
  }
  // trend from last 3 readings
  const hist = kpiHistory(metric, 3).map(k => Number(k.value));
  let trend = 'flat';
  if (hist.length >= 2) {
    const delta = hist[hist.length - 1] - hist[0];
    const dir = bm.direction === 'lower' ? -1 : 1;
    if (delta * dir > 0) trend = 'improving';
    else if (delta * dir < 0) trend = 'declining';
  }
  return { metric, label: bm.label, status, value: v, target: bm.target, scale_at: bm.scale_at, direction: bm.direction, unit: bm.unit, trend, period: kpi.period || null };
}

function kpiHealthBoard() {
  return benchmarks().map(b => scoreMetric(b.metric));
}

function priorityScore(task) {
  const impact = Number(task.impact || 3);       // 1-5
  const urgency = Number(task.urgency || 3);     // 1-5
  const effort = Number(task.effort || 3);       // 1-5 (higher = heavier)
  const revenueLinked = task.revenue_linked ? 3 : 0;
  return impact * 2 + urgency + revenueLinked - Math.floor(effort / 2);
}

// founder | automate | delegate_va
function delegationRecommendation(task) {
  const t = ((task.title || '') + ' ' + (task.description || '')).toLowerCase();
  const automate = ['report', 'reporting', 'schedule', 'scheduling', 'post', 'posting', 'email sequence', 'nurture', 'reminder', 'follow-up', 'follow up', 'tag', 'workflow', 'data entry', 'export', 'sync'];
  const va = ['edit', 'editing', 'upload', 'caption', 'clip', 'format', 'research', 'transcribe', 'organize', 'inbox', 'graphics', 'thumbnail'];
  const founder = ['teach', 'live', 'sales call', 'close', 'record', 'speak', 'podcast', 'approve', 'strategy', 'pricing', 'offer design', 'mentorship call'];
  if (founder.some(k => t.includes(k))) return { owner: 'founder', reason: 'Requires Kim\u2019s authority, voice, or a decision only the owner can make.' };
  if (automate.some(k => t.includes(k))) return { owner: 'automate', reason: 'Repeatable and rules-based \u2014 the system or GHL should own this, not a person.' };
  if (va.some(k => t.includes(k))) return { owner: 'delegate_va', reason: 'Skilled but non-founder work \u2014 a VA can own this with a clear SOP.' };
  return { owner: 'review', reason: 'Not clearly founder-only, automatable, or VA-ready \u2014 classify it in the task record.' };
}

function scaleReadiness() {
  const board = kpiHealthBoard();
  const critical = ['webinar_cta_conversion_rate', 'show_up_rate', 'close_rate', 'nurture_click_rate', 'leads_weekly'];
  const missing = critical.filter(m => board.find(b => b.metric === m && b.status === 'no_data'));
  const weak = board.filter(b => critical.includes(b.metric) && b.status === 'underperforming');
  const strong = board.filter(b => critical.includes(b.metric) && ['strong', 'ready_to_scale'].includes(b.status));
  let verdict, reason;
  if (missing.length >= 3) {
    verdict = 'not_ready';
    reason = 'You are flying blind: ' + missing.length + ' of the 5 scale-critical metrics have no data. Instrument before you spend.';
  } else if (weak.length >= 2) {
    verdict = 'fix_first';
    reason = 'Two or more scale-critical metrics are underperforming (' + weak.map(w => w.label).join(', ') + '). Pouring more traffic on a leaking funnel multiplies the leak.';
  } else if (strong.length >= 4) {
    verdict = 'ready_to_scale';
    reason = 'Conversion mechanics are strong across the funnel. More volume should compound, not break.';
  } else {
    verdict = 'conditionally_ready';
    reason = 'Core mechanics hold at current volume. Scale one channel at a time and watch CTA conversion and show-up rate for degradation.';
  }
  return { verdict, reason, missing_data: missing, weak: weak.map(w => w.metric), strong: strong.map(s => s.metric) };
}

function webinarCadenceRecommendation() {
  const reg = scoreMetric('webinar_registration_rate');
  const att = scoreMetric('webinar_attendance_rate');
  const cta = scoreMetric('webinar_cta_conversion_rate');
  const leads = scoreMetric('leads_weekly');
  const content = scoreMetric('content_pieces_weekly');
  const nurture = scoreMetric('nurture_click_rate');

  const noData = [reg, att, cta].filter(m => m.status === 'no_data');
  if (noData.length >= 2) {
    return {
      cadence: 'monthly_baseline',
      recommendation: 'Run ONE masterclass this month and instrument it fully before deciding cadence.',
      reasoning: 'There is no reliable registration, attendance, or CTA conversion data yet. Cadence decisions without conversion data are guesses. Run one, measure everything, then decide.',
      blockers: noData.map(m => m.metric)
    };
  }
  if (cta.status === 'underperforming' || att.status === 'underperforming') {
    return {
      cadence: 'hold_and_fix',
      recommendation: 'Do NOT add webinars. Fix the ' + (cta.status === 'underperforming' ? 'pitch/CTA conversion' : 'show-up and reminder sequence') + ' first.',
      reasoning: 'More webinars with a weak ' + (cta.status === 'underperforming' ? 'close' : 'attendance funnel') + ' burns audience trust and founder time for the same revenue. Fix conversion, then add volume.',
      fix_first: [cta.status === 'underperforming' ? 'webinar_cta_conversion_rate' : null, att.status === 'underperforming' ? 'webinar_attendance_rate' : null].filter(Boolean)
    };
  }
  if (['strong', 'ready_to_scale'].includes(cta.status) && ['strong', 'ready_to_scale'].includes(reg.status) && ['strong', 'on_track', 'ready_to_scale'].includes(leads.status)) {
    const contentOk = ['on_track', 'strong', 'ready_to_scale'].includes(content.status);
    return {
      cadence: contentOk ? 'biweekly' : 'monthly_plus_prep',
      recommendation: contentOk
        ? 'Move to every-two-weeks masterclasses. Conversion supports it and lead flow can refill the room.'
        : 'Conversion supports more webinars, but content output is too low to refill the room. Raise content volume first, then go biweekly.',
      reasoning: 'Registration and CTA conversion are at or above benchmark. The limiting factor is ' + (contentOk ? 'nothing structural \u2014 operational readiness only.' : 'top-of-funnel content volume feeding registrations.')
    };
  }
  return {
    cadence: 'monthly',
    recommendation: 'Hold monthly cadence. Metrics are adequate but not strong enough to justify more founder hours on stage.',
    reasoning: 'Registration/attendance/CTA are on track but not strong. The higher-leverage move is improving nurture (' + nurture.status + ') and lead flow (' + leads.status + ') so each webinar converts a bigger, warmer room.'
  };
}

function hardTruths() {
  const truths = [];
  const now = Date.now();
  const tasks = store.list('tasks');
  const approvals = store.list('approvals', a => a.status === 'pending');
  const board = kpiHealthBoard();
  const goals = store.list('goals', g => g.status !== 'completed');
  const findings = store.list('findings', f => f.status === 'open' && f.severity === 'critical');

  const staleApprovals = approvals.filter(a => now - new Date(a.created_at).getTime() > 3 * 86400000);
  if (staleApprovals.length) truths.push({
    severity: 'high', area: 'bottleneck',
    truth: staleApprovals.length + ' approval(s) have been waiting on you for 3+ days. The system is not the bottleneck right now \u2014 you are.',
    action: 'Clear the approval queue today. Approve, reject, or kill each one \u2014 do not let drafts age.'
  });

  const blocked = tasks.filter(t => t.status === 'blocked');
  if (blocked.length >= 3) truths.push({
    severity: 'high', area: 'execution',
    truth: blocked.length + ' tasks are blocked. Blocked work is invisible revenue leakage.',
    action: 'Review blockers in the task board \u2014 unblock, reassign, or delete.'
  });

  const founderTasks = tasks.filter(t => t.status !== 'completed' && (t.owner_type === 'founder' || !t.owner_type));
  const openTasks = tasks.filter(t => t.status !== 'completed');
  if (openTasks.length >= 5 && founderTasks.length / openTasks.length > 0.6) truths.push({
    severity: 'medium', area: 'founder_load',
    truth: Math.round(founderTasks.length / openTasks.length * 100) + '% of open work is founder-owned. That ceiling is your calendar, not your market.',
    action: 'Run delegation review: reassign anything that is not teaching, selling, or deciding.'
  });

  const under = board.filter(b => b.status === 'underperforming');
  if (under.length) truths.push({
    severity: 'high', area: 'kpi',
    truth: 'Underperforming vs benchmark: ' + under.map(u => u.label).join(', ') + '.',
    action: 'These are this week\u2019s priorities. Everything else is noise until these move.'
  });

  const noData = board.filter(b => b.status === 'no_data');
  if (noData.length >= 5) truths.push({
    severity: 'medium', area: 'instrumentation',
    truth: noData.length + ' KPIs have no data. You cannot manage what you refuse to measure.',
    action: 'Log last week\u2019s numbers for leads, calls, show-up, close, and content output \u2014 5 minutes, do it now.'
  });

  const content = scoreMetric('content_pieces_weekly');
  if (content.status === 'underperforming') truths.push({
    severity: 'high', area: 'content',
    truth: 'Content output is below the level that supports your lead-flow goal. The archive strategy only works if it ships.',
    action: 'Pull 2 segments from the Coffee & Credit archive this week \u2014 repackage before creating anything new.'
  });

  if (goals.length && goals.some(g => !tasks.find(t => t.goal_id === g.id))) truths.push({
    severity: 'medium', area: 'planning',
    truth: 'You have goals with zero tasks attached. A goal without tasks is a wish.',
    action: 'Break each goal into its first 3 tasks in the command center.'
  });

  if (findings.length) truths.push({
    severity: 'high', area: 'funnel',
    truth: findings.length + ' critical funnel/site finding(s) are open and unfixed.',
    action: 'Fix critical findings before spending a dollar or an hour driving traffic to those pages.'
  });

  if (!truths.length) truths.push({
    severity: 'low', area: 'status',
    truth: 'No structural red flags in the data currently logged. Either things are healthy or the data is thin \u2014 verify KPIs are current.',
    action: 'Log this week\u2019s KPIs to keep the picture honest.'
  });
  return truths;
}

module.exports = { DEFAULT_BENCHMARKS, benchmarks, latestKpi, kpiHistory, scoreMetric, kpiHealthBoard, priorityScore, delegationRecommendation, scaleReadiness, webinarCadenceRecommendation, hardTruths };
