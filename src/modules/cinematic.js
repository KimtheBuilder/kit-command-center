// Module 4: Cinematic Studio — creative production engine for premium promo assets.
// Provider layer is real and pluggable: register providers, attach them to render jobs.
const store = require('../store');
const events = require('../events');

const CHANNEL_SPECS = {
  instagram_reel:  { ratio: '9:16',  duration_s: 30, note: 'Hook in first 2s; captions always on' },
  instagram_story: { ratio: '9:16',  duration_s: 15, note: 'Single idea; tap-forward pacing' },
  youtube_long:    { ratio: '16:9',  duration_s: 600, note: 'Chapters; end-screen CTA to lead magnet' },
  youtube_short:   { ratio: '9:16',  duration_s: 45, note: 'Pulled from long-form peak moment' },
  website_hero:    { ratio: '16:9',  duration_s: 12, note: 'Loopable, no audio dependency' },
  webinar_promo:   { ratio: '1:1',   duration_s: 30, note: 'Date, time, single registration CTA' }
};

function createProject({ title, offer, campaign_goal, channels, actor }) {
  const project = store.create('cinematic_projects', {
    title, offer: offer || null, campaign_goal: campaign_goal || '',
    channels: channels || ['instagram_reel'],
    status: 'brief',   // brief -> storyboard -> production -> review -> ready
    brief: null
  }, 'cin');
  events.log(actor, 'cinematic.project_created', 'cinematic_project', project.id, title);
  return project;
}

function generateBrief(project_id, actor) {
  const p = store.get('cinematic_projects', project_id);
  if (!p) throw new Error('Project not found');
  const brief = {
    audience: 'The Fundable Entrepreneur \u2014 wants funding, knows credit matters, responds to "fundable/funding" language',
    core_promise: p.campaign_goal || 'Become fundable',
    tone: 'Premium, warm authority. Favorite-aunt energy, never corny.',
    brand: { colors: ['#06392F Tiber Green', '#B7A25E Husk', '#F7F4EF Cream'], type: 'Playfair Display / DM Sans', mark: 'Hammer \uD83D\uDEE0\uFE0F' },
    structure: ['HOOK (0-2s): pattern interrupt tied to funding pain', 'PROOF (2-10s): authority moment \u2014 live teaching clip or result', 'SHIFT (10-20s): the reframe (fundable, not fixed)', 'CTA (final): one action, one link'],
    channels: (p.channels || []).map(c => ({ channel: c, spec: CHANNEL_SPECS[c] || null }))
  };
  const updated = store.update('cinematic_projects', project_id, { brief, status: 'storyboard' });
  events.log(actor, 'cinematic.brief_generated', 'cinematic_project', project_id);
  return updated;
}

function addScene({ project_id, order, hook, visual_direction, caption, cta, prompt, actor }) {
  const p = store.get('cinematic_projects', project_id);
  if (!p) throw new Error('Project not found');
  const scene = store.create('scenes', {
    project_id, order: Number(order || 1),
    hook: hook || '', visual_direction: visual_direction || '',
    caption: caption || '', cta: cta || '',
    prompt: prompt || '',      // generation prompt for the attached provider
    status: 'storyboard',      // storyboard -> queued -> generated -> approved
    asset_id: null
  }, 'scn');
  events.log(actor, 'cinematic.scene_added', 'scene', scene.id, 'project ' + project_id);
  return scene;
}

// Provider registry: real extension point, not a fake integration.
// Providers are config records; render jobs reference them. Actual API calls are
// made by the worker/connector holding that provider's key (never stored here in V1).
function registerProvider({ name, kind, base_url, notes, actor }) {
  const prov = store.create('providers', {
    record_type: 'provider', name, kind: kind || 'video',  // video | image | audio
    base_url: base_url || null, notes: notes || '', status: 'configured_no_key'
  }, 'prv');
  events.log(actor, 'cinematic.provider_registered', 'provider', prov.id, name);
  return prov;
}

function queueRender({ project_id, scene_id, provider_id, actor }) {
  const job = store.create('assets', {
    record_type: 'render_job', project_id, scene_id: scene_id || null,
    provider_id: provider_id || null,
    status: 'queued',           // queued -> generating -> ready -> failed
    output_url: null
  }, 'rnd');
  if (scene_id) store.update('scenes', scene_id, { status: 'queued' });
  events.log(actor, 'cinematic.render_queued', 'render_job', job.id);
  return job;
}

function updateAsset(asset_id, patch, actor) {
  const a = store.update('assets', asset_id, patch);
  if (!a) throw new Error('Asset not found');
  events.log(actor, 'cinematic.asset_updated', 'asset', asset_id, patch.status || 'edited');
  return a;
}

function projectStatus(project_id) {
  const p = store.get('cinematic_projects', project_id);
  if (!p) throw new Error('Project not found');
  const scenes = store.list('scenes', s => s.project_id === project_id).sort((a, b) => a.order - b.order);
  const jobs = store.list('assets', a => a.record_type === 'render_job' && a.project_id === project_id);
  return { project: p, scenes, render_jobs: jobs };
}

module.exports = { CHANNEL_SPECS, createProject, generateBrief, addScene, registerProvider, queueRender, updateAsset, projectStatus };
