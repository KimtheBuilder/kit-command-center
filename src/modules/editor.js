// KIT Editor — Kim's own video editor, inside her JARVIS.
// Pipeline per job: download (Zoom or direct URL) → parse transcript →
// select clips (Claude, Kim's protocol) → cut with ffmpeg:
//   • horizontal master clips (stream copy — fast, no quality loss)
//   • vertical 9:16 shorts with burned-in captions (re-encoded)
// Files land in DATA_DIR/media/<jobId>/ and are served at /media/<jobId>/<file>.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./../store');
const events = require('./../events');
const zoom = require('./../zoom');
const vtt = require('./../vtt');
const media = require('./../media');

let FFMPEG = 'ffmpeg';
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) { /* system ffmpeg fallback */ }

const MEDIA_ROOT = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'media');
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const MAX_SHORT_SECONDS = 120; // verticals only for true shorts
const KEEP_JOBS = 6;           // disk hygiene: keep newest N job folders

function ff(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs || 15 * 60000);
    p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-400))); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

function setStatus(id, status, extra) {
  const j = store.update('edit_jobs', id, { status, ...(extra || {}) });
  events.log('kit_editor', 'editor.' + status, 'edit_job', id, (extra && extra.note) || '');
  return j;
}

// ---- Clip selection: Kim's protocol, executed by Claude ----
async function selectClips(markedTranscript) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) throw new Error('Clip selection needs ANTHROPIC_API_KEY (the KIT Brain).');
  const sys = `You select video clips from Kim the Builder's teaching recordings (AI + Credit + Funding for Entrepreneurs).
Select: exactly 1 long-form clip (300-720 seconds, a complete teaching arc) and 3-5 short clips (20-75 seconds, one idea each, hook in the first 3 seconds).
Prioritize: authority moments, clarity, lead-generation potential, clean self-contained segments.
Reject: rambling, housekeeping, attendee-heavy dialogue, private/client-identifying context.
Score hook_strength 1-10; only include shorts scoring 7+.
Timestamps [m:ss] appear in the transcript. Respond ONLY with JSON:
{"clips":[{"kind":"long"|"short","start_seconds":N,"end_seconds":N,"hook":"opening line","title":"3-6 word Title Case hook","why":"one line","hook_strength":N}]}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: 'Transcript with [m:ss] markers:\n' + markedTranscript }] })
  });
  if (!res.ok) throw new Error('Clip selection failed: Claude API ' + res.status);
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  const clips = (parsed.clips || []).filter(c => c.end_seconds > c.start_seconds);
  if (!clips.length) throw new Error('No qualifying clips found in this transcript.');
  return clips;
}

// ---- Cutting ----
async function cutClip(srcPath, dir, idx, clip, cues) {
  const base = 'clip' + (idx + 1) + '-' + String(clip.title || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const dur = clip.end_seconds - clip.start_seconds;
  const out = { files: [] };
  // 1) Horizontal master — stream copy (no re-encode, fast, lossless)
  const hName = base + '.mp4';
  await ff(['-ss', String(clip.start_seconds), '-to', String(clip.end_seconds), '-i', srcPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', path.join(dir, hName)]);
  out.files.push({ kind: 'horizontal', file: hName });
  // 2) Vertical 9:16 with burned captions — shorts only
  if (clip.kind === 'short' && dur <= MAX_SHORT_SECONDS) {
    const clipCues = vtt.sliceRange(cues, clip.start_seconds, clip.end_seconds);
    let vf = "crop=ih*9/16:ih,scale=1080:1920";
    const srtPath = path.join(dir, base + '.srt');
    if (clipCues.length) {
      fs.writeFileSync(srtPath, vtt.toSrt(clipCues));
      const esc = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      vf += ",subtitles='" + esc + "':force_style='FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,Outline=2,Bold=1,Alignment=2,MarginV=60'";
    }
    const vName = base + '-vertical.mp4';
    await ff(['-ss', String(clip.start_seconds), '-to', String(clip.end_seconds), '-i', srcPath,
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k',
      path.join(dir, vName)], 20 * 60000);
    out.files.push({ kind: 'vertical_captioned', file: vName });
  }
  return out;
}

function cleanupOldJobs() {
  try {
    const dirs = fs.readdirSync(MEDIA_ROOT).map(d => ({ d, t: fs.statSync(path.join(MEDIA_ROOT, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { d } of dirs.slice(KEEP_JOBS)) fs.rmSync(path.join(MEDIA_ROOT, d), { recursive: true, force: true });
  } catch (e) { /* hygiene is best-effort */ }
}

// ---- Job orchestration ----
async function runJob(id) {
  const job = store.get('edit_jobs', id);
  const dir = path.join(MEDIA_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'source.mp4');
  try {
    // 1. Resolve source + transcript
    setStatus(id, 'downloading', { note: job.topic || job.video_url || job.meeting_id });
    let vttText = job.transcript_vtt || null;
    if (job.source === 'zoom') {
      const assets = await zoom.recordingAssets(job.meeting_id);
      store.update('edit_jobs', id, { topic: assets.topic, size_mb: assets.size_mb });
      await zoom.downloadToFile(assets.mp4_url, src, true);
      if (!vttText && assets.vtt_url) {
        const tPath = path.join(dir, 'transcript.vtt');
        await zoom.downloadToFile(assets.vtt_url, tPath, true);
        vttText = fs.readFileSync(tPath, 'utf8');
      }
    } else {
      await zoom.downloadToFile(job.video_url, src, false);
    }
    if (!vttText) throw new Error('No transcript available. Enable audio transcript in Zoom recording settings, or paste a VTT transcript when creating the job.');

    // 2. Parse + select
    setStatus(id, 'selecting_clips');
    const cues = vtt.parse(vttText);
    if (!cues.length) throw new Error('Transcript could not be parsed (expected WebVTT).');
    const clips = job.clips && job.clips.length ? job.clips : await selectClips(vtt.toMarkedText(cues));
    store.update('edit_jobs', id, { clips });

    // 3. Cut
    setStatus(id, 'cutting', { note: clips.length + ' clips' });
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const r = await cutClip(src, dir, i, clips[i], cues);
      results.push({ ...clips[i], files: r.files.map(f => ({ ...f, url: '/media/' + id + '/' + f.file })) });
      store.update('edit_jobs', id, { results: results.slice() });
    }

    // 4. Finish — remove the big source file, keep the clips
    try { fs.rmSync(src, { force: true }); } catch (e) { }
    cleanupOldJobs();
    setStatus(id, 'done', { note: results.length + ' clips ready' });
  } catch (e) {
    setStatus(id, 'failed', { error: e.message, note: e.message.slice(0, 120) });
  }
}

function createJob(input) {
  const { source, meeting_id, video_url, transcript_vtt, clips, topic, actor } = input || {};
  if (source === 'zoom') {
    if (!zoom.enabled()) throw new Error('Zoom is not connected. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in Render.');
    if (!meeting_id) throw new Error('meeting_id required for a Zoom job.');
  } else if (source === 'url') {
    if (!video_url || !/^https?:\/\//.test(video_url)) throw new Error('A direct, downloadable video URL is required.');
  } else throw new Error("source must be 'zoom' or 'url'");
  const job = store.create('edit_jobs', {
    source, meeting_id: meeting_id || null, video_url: video_url || null,
    transcript_vtt: transcript_vtt || null, clips: Array.isArray(clips) && clips.length ? clips : null,
    topic: topic || null, status: 'queued', results: [], error: null
  }, 'edit');
  events.log(actor || 'owner', 'editor.job_created', 'edit_job', job.id, topic || meeting_id || video_url);
  setImmediate(() => runJob(job.id));
  // strip the bulky transcript from the returned object
  const { transcript_vtt: _t, ...lean } = job;
  return lean;
}

function listJobs() {
  return store.list('edit_jobs').reverse().slice(0, 12).map(publicJob);
}
function getJob(id) {
  const j = store.get('edit_jobs', id);
  if (!j) throw new Error('Job not found');
  return publicJob(j);
}

function publicJob(j) {
  const { transcript_vtt, ...lean } = j;
  if (Array.isArray(lean.results)) lean.results = lean.results.map(result => ({
    ...result,
    files: (result.files || []).map(file => ({ ...file, url: media.signedUrl(j.id, file.file) }))
  }));
  return lean;
}

module.exports = { createJob, listJobs, getJob, MEDIA_ROOT, selectClips };
