// Conversational command router — voice-ready responses:
// { answer, detail, recommendation, next_action }. Concise first, depth optional.
const rules = require('./rules');
const cc = require('./modules/commandCenter');
const growth = require('./modules/growthAudit');
const reviews = require('./reviews');
const store = require('./store');
const events = require('./events');
const brain = require('./brain');

function respond(answer, detail, recommendation, next_action, data) {
  return { answer, detail: detail || null, recommendation: recommendation || null, next_action: next_action || null, data: data || null };
}

async function handle(text, actor) {
  const t = (text || '').toLowerCase();
  events.log(actor || 'owner', 'command.received', 'command', null, text);

  if (t.includes('weekly operator') || (t.includes('weekly') && t.includes('summary'))) {
    const r = reviews.run('weekly_operator', actor);
    const c = r.content;
    return respond(
      c.headline,
      'Open tasks: ' + c.execution.open_tasks + '. Blocked: ' + c.execution.blocked + '. Awaiting your approval: ' + c.execution.awaiting_approval + '. Founder-owned: ' + c.execution.founder_owned_pct + '%.',
      c.next_best_actions[0] ? c.next_best_actions[0].action : null,
      'Full review saved as ' + r.id, c);
  }
  if (t.includes('hard truth')) {
    const truths = rules.hardTruths();
    return respond(truths[0].truth, truths.slice(1).map(x => x.truth).join(' '), truths[0].action, 'Say "weekly operator summary" for the full picture.', truths);
  }
  if (t.includes('webinar')) {
    const w = rules.webinarCadenceRecommendation();
    return respond(w.recommendation, w.reasoning, 'Cadence: ' + w.cadence.replace(/_/g, ' '), 'Log webinar KPIs after every session to keep this recommendation honest.', w);
  }
  if (t.includes('scale')) {
    const s = rules.scaleReadiness();
    const board = rules.kpiHealthBoard().filter(b => b.status === 'ready_to_scale');
    return respond(
      s.verdict === 'ready_to_scale' ? 'You are clear to scale.' : s.verdict === 'fix_first' ? 'Do not scale yet \u2014 fix conversion first.' : s.verdict === 'not_ready' ? 'Not ready \u2014 you are missing the data to scale safely.' : 'Conditionally ready \u2014 scale one channel, watch the numbers.',
      s.reason,
      board.length ? 'Ready to scale now: ' + board.map(b => b.label).join(', ') : 'Nothing is at scale-ready benchmark yet.',
      'Run a scale-readiness review for the breakdown.', s);
  }
  if (t.includes('stop doing') || t.includes('not producing') || t.includes('cut')) {
    const r = reviews.build('campaign');
    const cuts = (r.energy_vs_return || []).filter(c => c.verdict.startsWith('Consuming'));
    return respond(
      cuts.length ? 'Cut candidates: ' + cuts.map(c => c.campaign).join(', ') + '.' : 'No logged campaign is clearly burning effort without return \u2014 but only ' + (r.campaigns || []).length + ' campaign(s) are being tracked.',
      'Anything with 10+ hours of effort and zero attributed revenue is a cut-or-overhaul candidate.',
      'Track effort hours and revenue per campaign so this answer gets sharper.',
      'Log campaigns via the API or MCP tool log_campaign.', r);
  }
  if (t.includes('delegate') || t.includes('automate') || t.includes('keep')) {
    const r = reviews.build('founder_workload');
    return respond(
      r.verdict,
      'Automate: ' + r.should_automate.length + ' task(s). Delegate to VA: ' + r.should_delegate.length + '. Founder-only: ' + r.founder_tasks.length + '.',
      r.should_automate[0] ? 'Start by automating: ' + r.should_automate[0].title : 'Add tasks so the delegation engine has something to classify.',
      'Run founder_workload review for the full split.', r);
  }
  if (t.includes('bottleneck') || t.includes('waiting on me')) {
    const r = reviews.build('bottleneck');
    return respond(
      r.verdict,
      r.waiting_on_owner.length ? 'Waiting on you: ' + r.waiting_on_owner.map(w => w.title + ' (' + w.age_days + 'd)').join('; ') : 'Nothing in the approval queue.',
      r.blocked_tasks.length ? 'Blocked: ' + r.blocked_tasks.map(b => b.title).join('; ') : null,
      'Clear approvals first \u2014 they gate everything downstream.', r);
  }
  if (t.includes('what should i scale') || t.includes('what should matter') || t.includes('this week')) {
    const w = growth.whatMattersThisWeek();
    return respond(
      w.fix.length ? 'Fix first: ' + w.fix[0].item : 'No high-severity fixes \u2014 go on offense.',
      w.channels[0] ? 'Channel priority: ' + w.channels[0].channel + ' \u2014 ' + w.channels[0].why : null,
      w.pursue[0] ? 'Top opportunity: ' + w.pursue[0].item : 'Run a growth audit to load the opportunity board.',
      'Say "weekly operator summary" for the full board.', w);
  }
  if (t.includes('audit') && t.includes('growth')) {
    const audit = growth.createAudit({ property: 'main_site', type: 'growth_stack', actor });
    return respond('Growth stack audit opened: ' + audit.id + '.', 'Checklist loaded with 8 growth areas across offer clarity, lead capture, bridges, authority, follow-up, content alignment, traffic, and tracking.', null, 'Add findings as you (or Claude via MCP) work through each property.', audit);
  }
  // Explicit capture language always creates a task.
  const wantsCapture = /\b(add a task|add task|new task|remind me|capture|to-?do)\b/.test(t);

  // Otherwise: if the Claude brain is configured, answer intelligently from live state.
  if (!wantsCapture && brain.enabled()) {
    const smart = await brain.ask(text, actor);
    if (smart) {
      events.log('kit_brain', 'command.answered', 'command', null, smart.answer.slice(0, 140));
      return smart;
    }
  }

  // Fallback: create a task from the command so nothing spoken gets lost.
  const task = cc.createTask({ title: text.slice(0, 120), description: 'Captured from command console.', actor });
  return respond(
    'Captured as a task: "' + task.title + '" (' + task.id + ').',
    'Delegation read: ' + task.owner_type + ' \u2014 ' + task.delegation_note,
    null, 'Set impact/urgency on the task to move it up the priority board.', task);
}

module.exports = { handle };
