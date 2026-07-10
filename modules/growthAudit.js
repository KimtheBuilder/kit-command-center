// Module 2: Platform Audit & Growth Agent — audits properties, scores opportunities.
const store = require('../store');
const events = require('../events');
const rules = require('../rules');

const PROPERTIES = [
  { key: 'main_site',        label: 'Main site (iamkimthebuilder.com)' },
  { key: 'legacy_builders',  label: 'Legacy Builders ecosystem' },
  { key: 'legacy_academy',   label: 'Legacy Academy funnel' },
  { key: 'dm_bootcamp',      label: 'Digital Marketing Bootcamp funnel' },
  { key: 'coffee_credit_daypass', label: 'Coffee & Credit Day Pass funnel' }
];

const GROWTH_CHECKLIST = [
  { area: 'offer_clarity',      q: 'Is the transformation and price obvious in 5 seconds?' },
  { area: 'lead_capture',       q: 'Is there a working lead magnet path (AI + Fundability Guide) above the fold?' },
  { area: 'funnel_bridge',      q: 'Does this property bridge cleanly to the next offer tier (low-ticket -> community -> mentorship)?' },
  { area: 'authority_signals',  q: 'Live teaching, testimonials, results, and press visible?' },
  { area: 'follow_up',          q: 'Is every opt-in connected to an active nurture sequence in GHL?' },
  { area: 'content_alignment',  q: 'Does recent content point at THIS offer, or drift?' },
  { area: 'traffic_source',     q: 'Is there a repeatable traffic source feeding this funnel weekly?' },
  { area: 'conversion_data',    q: 'Are conversion numbers actually being tracked for this property?' }
];

function createAudit({ property, type, notes, actor }) {
  const prop = PROPERTIES.find(p => p.key === property);
  const audit = store.create('audits', {
    module: 'growth', type: type || 'growth_stack',
    property: property || 'main_site',
    property_label: prop ? prop.label : property,
    status: 'open', notes: notes || '',
    checklist: GROWTH_CHECKLIST.map(c => ({ ...c, answer: null }))
  }, 'aud');
  events.log(actor, 'audit.created', 'audit', audit.id, audit.property_label);
  return audit;
}

function addFinding({ audit_id, title, detail, severity, opportunity_score, recommendation, actor }) {
  const audit = store.get('audits', audit_id);
  if (!audit) throw new Error('Audit not found: ' + audit_id);
  const f = store.create('findings', {
    audit_id, module: audit.module, property: audit.property,
    title, detail: detail || '',
    severity: severity || 'medium',            // critical | high | medium | low
    opportunity_score: Number(opportunity_score || 5), // 1-10 likely business impact
    recommendation: recommendation || '',
    status: 'open'
  }, 'fnd');
  events.log(actor, 'finding.added', 'finding', f.id, title);
  return f;
}

function growthOpportunities() {
  return store.list('findings', f => f.status === 'open')
    .sort((a, b) => (b.opportunity_score || 0) - (a.opportunity_score || 0))
    .slice(0, 10);
}

function channelPrioritization() {
  // Ties recommendations to Kim's actual funnel: content -> lead magnet -> nurture -> masterclass -> mentorship
  const board = rules.kpiHealthBoard();
  const s = m => (board.find(b => b.metric === m) || {}).status || 'no_data';
  const recs = [];
  if (['underperforming', 'no_data'].includes(s('leads_weekly')))
    recs.push({ channel: 'YouTube long-form (2/wk from archive)', priority: 1, why: 'Top-of-funnel is the stated bottleneck. Archive repackaging is the cheapest lead source you own.' });
  if (['underperforming', 'no_data'].includes(s('nurture_click_rate')))
    recs.push({ channel: 'GHL nurture rebuild', priority: 2, why: 'Leads without follow-up are rented, not owned. Fix nurture before adding volume.' });
  if (['strong', 'ready_to_scale'].includes(s('webinar_cta_conversion_rate')))
    recs.push({ channel: 'Masterclass cadence increase', priority: 2, why: 'CTA conversion supports more stage time.' });
  recs.push({ channel: 'Live authority placements (podcasts, other rooms)', priority: 3, why: 'Kim converts best when seen live in authority \u2014 this feeds high-ticket directly.' });
  return recs;
}

function whatMattersThisWeek() {
  const truths = rules.hardTruths().filter(t => t.severity === 'high');
  const opps = growthOpportunities().slice(0, 3);
  return {
    fix: truths.map(t => ({ item: t.truth, action: t.action })),
    pursue: opps.map(o => ({ item: o.title, score: o.opportunity_score, action: o.recommendation })),
    channels: channelPrioritization()
  };
}

module.exports = { PROPERTIES, GROWTH_CHECKLIST, createAudit, addFinding, growthOpportunities, channelPrioritization, whatMattersThisWeek };
