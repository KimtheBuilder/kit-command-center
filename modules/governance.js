// Module 3: Website & Funnel Governance Agent — audits pages, drafts changes, never publishes.
const store = require('../store');
const events = require('../events');

const PAGE_CHECKS = [
  { check: 'headline_promise',   label: 'Headline states a concrete outcome for the Fundable Entrepreneur' },
  { check: 'cta_strength',       label: 'Primary CTA is specific, visible, and repeated' },
  { check: 'trust_signals',      label: 'Testimonials, results, credentials, live-teaching proof present' },
  { check: 'funnel_bridge',      label: 'Clear bridge to next tier (day pass -> community -> mentorship)' },
  { check: 'stale_content',      label: 'No outdated dates, dead links, or expired offers' },
  { check: 'brand_consistency',  label: 'KTB brand system applied (Tiber Green / Husk / cream, Playfair + DM Sans)' },
  { check: 'friction',           label: 'Form fields minimal; no dead-end pages; mobile flow clean' },
  { check: 'positioning',        label: '"Fundable/funding" language, not "credit repair" language' }
];

function createPageAudit({ url, property, funnel_stage, actor }) {
  const audit = store.create('audits', {
    module: 'governance', type: 'page_audit',
    url: url || null, property: property || 'main_site',
    funnel_stage: funnel_stage || 'unknown',   // traffic | optin | nurture | sales | checkout | thankyou
    status: 'open',
    checks: PAGE_CHECKS.map(c => ({ ...c, result: null, note: null }))
  }, 'aud');
  events.log(actor, 'audit.created', 'audit', audit.id, 'page audit: ' + (url || property));
  return audit;
}

function recordCheck(audit_id, check, result, note, actor) {
  const audit = store.get('audits', audit_id);
  if (!audit) throw new Error('Audit not found');
  const c = (audit.checks || []).find(x => x.check === check);
  if (!c) throw new Error('Unknown check: ' + check);
  c.result = result; c.note = note || null;
  store.update('audits', audit_id, { checks: audit.checks });
  events.log(actor, 'audit.check_recorded', 'audit', audit_id, check + '=' + result);
  return audit;
}

// Draft changes go into a revision queue; publishing ALWAYS requires an owner approval.
function draftRevision({ audit_id, url, section, current_copy, proposed_copy, rationale, severity, actor }) {
  const rev = store.create('workflows', {
    kind: 'page_revision', audit_id: audit_id || null, url: url || null,
    section: section || 'body', current_copy: current_copy || '', proposed_copy,
    rationale: rationale || '', severity: severity || 'medium',
    status: 'draft'   // draft -> awaiting_approval -> approved (owner publishes manually or via future connector)
  }, 'rev');
  events.log(actor, 'revision.drafted', 'revision', rev.id, section);
  return rev;
}

module.exports = { PAGE_CHECKS, createPageAudit, recordCheck, draftRevision };
