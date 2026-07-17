// Module 1: Command Center — goals, tasks, approvals, agent registry, summaries.
const store = require('../store');
const events = require('../events');
const rules = require('../rules');
const { PublicError } = require('../security');

const TASK_STATES = ['draft', 'in_progress', 'blocked', 'awaiting_approval', 'completed'];

function registerAgent(a) {
  const agent = store.create('agents', { status: 'active', ...a }, 'agt');
  events.log(a.actor || 'system', 'agent.registered', 'agent', agent.id, agent.name);
  return agent;
}

function createGoal({ title, description, target_metric, target_value, due_date, actor }) {
  const goal = store.create('goals', { title, description: description || '', target_metric: target_metric || null, target_value: target_value || null, due_date: due_date || null, status: 'active' }, 'goal');
  events.log(actor, 'goal.created', 'goal', goal.id, title);
  return goal;
}

function createTask(input) {
  const t = {
    title: input.title,
    description: input.description || '',
    goal_id: input.goal_id || null,
    agent: input.agent || 'command_center',
    status: input.status && TASK_STATES.includes(input.status) ? input.status : 'draft',
    impact: input.impact || 3, urgency: input.urgency || 3, effort: input.effort || 3,
    revenue_linked: !!input.revenue_linked,
    owner_type: input.owner_type || null,   // founder | automate | delegate_va
    due_date: input.due_date || null,
    blocker: null, result: null
  };
  const delegation = rules.delegationRecommendation(t);
  if (!t.owner_type) t.owner_type = delegation.owner === 'review' ? 'founder' : delegation.owner;
  const task = store.create('tasks', { ...t, priority_score: rules.priorityScore(t), delegation_note: delegation.reason }, 'task');
  events.log(input.actor, 'task.created', 'task', task.id, task.title);
  return task;
}

function updateTask(id, patch, actor) {
  if (patch.status && !TASK_STATES.includes(patch.status)) throw new Error('Invalid status. Use: ' + TASK_STATES.join(', '));
  const existing = store.get('tasks', id);
  if (!existing) throw new Error('Task not found: ' + id);
  const merged = { ...existing, ...patch };
  patch.priority_score = rules.priorityScore(merged);
  const task = store.update('tasks', id, patch);
  events.log(actor, 'task.updated', 'task', id, patch.status || 'edited');
  return task;
}

function requestApproval({ title, description, task_id, payload, category, actor }) {
  const ap = store.create('approvals', {
    title, description: description || '', task_id: task_id || null,
    category: category || 'general',   // publish_content | site_change | workflow_change | spend | general
    payload: payload || null, status: 'pending', decided_at: null, decision_note: null
  }, 'apr');
  if (task_id) store.update('tasks', task_id, { status: 'awaiting_approval' });
  events.log(actor, 'approval.requested', 'approval', ap.id, title);
  return ap;
}

function decideApproval(id, decision, note, actor) {
  if (!['approved', 'rejected'].includes(decision)) throw new PublicError('decision must be approved or rejected', 400);
  if (actor !== 'owner') throw new PublicError('Only the authenticated owner can decide approvals.', 403);
  const existing = store.get('approvals', id);
  if (!existing) throw new PublicError('Approval not found.', 404);
  if (existing.status !== 'pending') throw new PublicError('Approval has already been decided.', 409);
  const ap = store.update('approvals', id, { status: decision, decision_note: note || null, decided_at: new Date().toISOString(), decided_by: actor || 'owner' });
  if (ap.task_id) store.update('tasks', ap.task_id, { status: decision === 'approved' ? 'in_progress' : 'draft' });
  events.log('owner', 'approval.' + decision, 'approval', id, note || '');
  const dec = store.create('decisions', { subject: ap.title, decision, note: note || null, approval_id: id }, 'dec');
  return { approval: ap, decision: dec };
}

function taskBoard() {
  const tasks = store.list('tasks').sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
  const byStatus = {};
  TASK_STATES.forEach(s => byStatus[s] = tasks.filter(t => t.status === s));
  return byStatus;
}

function summary() {
  const tasks = store.list('tasks');
  const open = tasks.filter(t => t.status !== 'completed');
  const approvals = store.list('approvals', a => a.status === 'pending');
  const board = rules.kpiHealthBoard();
  const founderOwned = open.filter(t => t.owner_type === 'founder').length;
  return {
    open_tasks: open.length,
    completed_tasks: tasks.length - open.length,
    blocked: open.filter(t => t.status === 'blocked').length,
    awaiting_approval: approvals.length,
    founder_owned_pct: open.length ? Math.round(founderOwned / open.length * 100) : 0,
    kpi_underperforming: board.filter(b => b.status === 'underperforming').map(b => b.label),
    kpi_ready_to_scale: board.filter(b => b.status === 'ready_to_scale').map(b => b.label),
    scale_readiness: rules.scaleReadiness(),
    webinar_cadence: rules.webinarCadenceRecommendation(),
    hard_truths: rules.hardTruths(),
    next_best_actions: nextBestActions(),
    recent_decisions: store.list('decisions').slice(-5).reverse()
  };
}

function nextBestActions() {
  const actions = [];
  const approvals = store.list('approvals', a => a.status === 'pending');
  if (approvals.length) actions.push({ action: 'Clear ' + approvals.length + ' pending approval(s)', why: 'Approvals gate everything downstream.', link: 'approvals' });
  const board = rules.kpiHealthBoard();
  const under = board.filter(b => b.status === 'underperforming');
  under.slice(0, 2).forEach(u => actions.push({ action: 'Move ' + u.label + ' (' + u.value + ' vs target ' + u.target + ')', why: 'Underperforming vs benchmark.', link: 'kpis' }));
  const top = store.list('tasks', t => t.status === 'in_progress').sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))[0];
  if (top) actions.push({ action: 'Finish: ' + top.title, why: 'Highest-priority task in progress.', link: 'tasks' });
  if (!actions.length) actions.push({ action: 'Log this week\u2019s KPIs and set a goal', why: 'The system runs on current data.', link: 'kpis' });
  return actions.slice(0, 4);
}

module.exports = { TASK_STATES, registerAgent, createGoal, createTask, updateTask, requestApproval, decideApproval, taskBoard, summary, nextBestActions };
