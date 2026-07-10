// Module 5: Workflow & Nurture Automation Agent — GHL workflow inventory, QA audits, sequence drafts.
const store = require('../store');
const events = require('../events');

const QA_CHECKS = [
  { check: 'broken_logic',      label: 'Branches that can never fire / conditions that contradict' },
  { check: 'duplicate_triggers',label: 'Two workflows firing on the same trigger + tag combination' },
  { check: 'dead_end_branch',   label: 'Contacts entering a branch with no next step and no exit' },
  { check: 'outdated_assets',   label: 'Emails referencing expired dates, old prices, or dead links' },
  { check: 'tag_consistency',   label: 'Tags applied/removed consistently across entry and exit' },
  { check: 'orphan_optins',     label: 'Forms or pages capturing leads with NO workflow attached' },
  { check: 'timing_gaps',       label: 'Multi-day silence early in the sequence (first 72h matter most)' },
  { check: 'cta_alignment',     label: 'Every email CTA points at the current funnel stage offer' }
];

function registerWorkflow({ name, ghl_id, trigger, funnel_stage, email_count, status, actor }) {
  const wf = store.create('workflows', {
    kind: 'ghl_workflow', name, ghl_id: ghl_id || null,
    trigger: trigger || '', funnel_stage: funnel_stage || 'nurture',
    email_count: Number(email_count || 0),
    status: status || 'live'    // live | paused | draft
  }, 'wf');
  events.log(actor, 'workflow.registered', 'workflow', wf.id, name);
  return wf;
}

function createWorkflowAudit({ workflow_id, scope, actor }) {
  const audit = store.create('audits', {
    module: 'nurture', type: 'workflow_qa',
    workflow_id: workflow_id || null, scope: scope || 'all',
    status: 'open',
    checks: QA_CHECKS.map(c => ({ ...c, result: null, note: null }))
  }, 'aud');
  events.log(actor, 'audit.created', 'audit', audit.id, 'workflow QA');
  return audit;
}

function recordQaResult(audit_id, check, result, note, actor) {
  const audit = store.get('audits', audit_id);
  if (!audit) throw new Error('Audit not found');
  const c = (audit.checks || []).find(x => x.check === check);
  if (!c) throw new Error('Unknown check: ' + check);
  c.result = result; c.note = note || null;
  store.update('audits', audit_id, { checks: audit.checks });
  events.log(actor, 'audit.qa_recorded', 'audit', audit_id, check + '=' + result);
  return audit;
}

// Sequence drafts are stored, then approval-gated before Kim pastes/pushes to GHL.
function draftSequence({ name, funnel_stage, emails, actor }) {
  const seq = store.create('workflows', {
    kind: 'sequence_draft', name, funnel_stage: funnel_stage || 'nurture',
    emails: emails || [],    // [{day, subject, purpose, cta}]
    status: 'draft'
  }, 'seq');
  events.log(actor, 'sequence.drafted', 'workflow', seq.id, name);
  return seq;
}

function inventory() {
  return {
    live_workflows: store.list('workflows', w => w.kind === 'ghl_workflow'),
    sequence_drafts: store.list('workflows', w => w.kind === 'sequence_draft'),
    page_revisions: store.list('workflows', w => w.kind === 'page_revision'),
    open_qa_audits: store.list('audits', a => a.module === 'nurture' && a.status === 'open')
  };
}

module.exports = { QA_CHECKS, registerWorkflow, createWorkflowAudit, recordQaResult, draftSequence, inventory };
