// KIT Command Center — dashboard logic
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let ADMIN_KEY = localStorage.getItem('kit_admin_key') || '';

async function api(path, method, body) {
  const res = await fetch('/api' + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    ADMIN_KEY = prompt('Enter your KIT admin key (ADMIN_KEY env var):') || '';
    localStorage.setItem('kit_admin_key', ADMIN_KEY);
    if (ADMIN_KEY) return api(path, method, body);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtVal = (k) => k.unit === 'rate' ? (k.value * 100).toFixed(1) + '%' : k.unit === 'usd' ? '$' + Number(k.value).toLocaleString() : Number(k.value).toLocaleString();

// ---------- navigation ----------
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + btn.dataset.view).classList.remove('hidden');
  loaders[btn.dataset.view] && loaders[btn.dataset.view]();
}));

// ---------- command console ----------
async function sendCommand() {
  const text = $('#commandInput').value.trim();
  if (!text) return;
  $('#commandSend').textContent = '…';
  if (typeof setArc === 'function') setArc('thinking', 'Working…');
  try {
    const r = await api('/command', 'POST', { text });
    $('#replyAnswer').textContent = r.answer || '';
    $('#replyDetail').textContent = r.detail || '';
    $('#replyRec').textContent = r.recommendation || '';
    $('#replyNext').textContent = r.next_action || '';
    $('#consoleReply').classList.remove('hidden');
    loadOverview();
    speak(r.answer + (r.recommendation ? ' ' + r.recommendation : ''));
  } catch (e) { toast(e.message); if (typeof setArc === 'function') setArc('idle', 'KIT online.'); }
  $('#commandSend').textContent = 'Ask';
  $('#commandInput').value = '';
}
$('#commandSend').addEventListener('click', sendCommand);
$('#commandInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendCommand(); });

// ---------- JARVIS layer: voice in, voice out, arc status ----------
const arc = $('#arcRing'), kitStatus = $('#kitStatus');
let voiceEnabled = false, elAvailable = false;
function setArc(state, msg) { // idle | listening | thinking | speaking
  arc.className = 'arc ' + state;
  if (msg) kitStatus.textContent = msg;
}
(async () => {
  try { const s = await api('/voice/status'); elAvailable = s.enabled; } catch (e) { elAvailable = false; }
  let line = elAvailable ? 'KIT online. Voice ready.' : 'KIT online. Voice: set ELEVENLABS_API_KEY to enable KIT’s voice (browser fallback active).';
  try {
    const st = await api('/stack/status');
    if (st.configured) line += st.reachable ? ' Agent Stack linked — ' + st.tools + ' tools.' : ' Agent Stack UNREACHABLE: ' + (st.hint || st.error);
  } catch (e) { /* diagnostics never block boot */ }
  kitStatus.textContent = line;
})();
$('#voiceToggle').addEventListener('change', e => { voiceEnabled = e.target.checked; });

async function speak(text) {
  if (!voiceEnabled || !text) return;
  setArc('speaking', 'KIT speaking…');
  try {
    if (elAvailable) {
      const r = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {}) },
        body: JSON.stringify({ text })
      });
      if (r.ok) {
        const blob = await r.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        await audio.play();
        await new Promise(res => { audio.onended = res; audio.onerror = res; });
        setArc('idle', 'KIT online.');
        return;
      }
    }
    // Browser fallback so the loop still works before ElevenLabs is configured
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; speechSynthesis.speak(u);
    await new Promise(res => { u.onend = res; u.onerror = res; });
  } catch (e) { /* silent — voice is a layer, never a blocker */ }
  setArc('idle', 'KIT online.');
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
  let listening = false;
  $('#micBtn').addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    listening = true; $('#micBtn').classList.add('live');
    setArc('listening', 'Listening…');
    $('#voiceToggle').checked = true; voiceEnabled = true; // spoken in → spoken out
    rec.start();
  });
  rec.onresult = e => {
    const txt = Array.from(e.results).map(r => r[0].transcript).join('');
    $('#commandInput').value = txt;
    if (e.results[e.results.length - 1].isFinal) rec.stop();
  };
  rec.onend = () => {
    listening = false; $('#micBtn').classList.remove('live');
    if ($('#commandInput').value.trim()) sendCommand();
    else setArc('idle', 'KIT online.');
  };
  rec.onerror = () => { listening = false; $('#micBtn').classList.remove('live'); setArc('idle', 'Mic unavailable — type instead.'); };
} else {
  $('#micBtn').title = 'Voice input needs Chrome/Edge/Safari';
  $('#micBtn').style.opacity = 0.35;
}

// ---------- overview ----------
async function loadOverview() {
  try {
    const s = await api('/summary');
    $('#hardTruths').innerHTML = s.hard_truths.map(t =>
      `<div class="truth ${t.severity}"><div class="truth-area">${esc(t.area)}</div><div class="truth-text">${esc(t.truth)}</div><div class="truth-action">${esc(t.action)}</div></div>`).join('');
    $('#nextActions').innerHTML = s.next_best_actions.map((a, i) =>
      `<div class="action"><span class="action-n">0${i + 1}</span><span class="action-t">${esc(a.action)}</span><span class="action-w">${esc(a.why)}</span></div>`).join('');
    const sr = s.scale_readiness;
    $('#scaleVerdict').textContent = sr.verdict.replace(/_/g, ' ');
    $('#scaleReason').textContent = sr.reason;
    const w = s.webinar_cadence;
    $('#webinarVerdict').textContent = w.cadence.replace(/_/g, ' ');
    $('#webinarReason').textContent = w.recommendation;
    $('#pulse').innerHTML = [
      ['Open tasks', s.open_tasks], ['Blocked', s.blocked],
      ['Awaiting approval', s.awaiting_approval], ['Founder-owned', s.founder_owned_pct + '%']
    ].map(([l, v]) => `<div class="pulse-item"><div class="pulse-num">${v}</div><div class="pulse-label">${l}</div></div>`).join('');
    $('#kpiFlags').innerHTML =
      (s.kpi_underperforming.length ? `<div class="mini-item"><span class="sev high">under</span>${s.kpi_underperforming.map(esc).join(', ')}</div>` : '') +
      (s.kpi_ready_to_scale.length ? `<div class="mini-item"><span class="sev low">scale</span>${s.kpi_ready_to_scale.map(esc).join(', ')}</div>` : '') ||
      '<div class="mini-item dim">No KPI flags — log data to activate.</div>';
    $('#recentDecisions').innerHTML = s.recent_decisions.length
      ? s.recent_decisions.map(d => `<div class="mini-item"><b>${esc(d.decision || '')}</b> — ${esc(d.subject)}<div class="dim">${esc(d.note || '')}</div></div>`).join('')
      : '<div class="mini-item dim">No decisions logged yet.</div>';
    $('#approvalBadge').textContent = s.awaiting_approval || '';
  } catch (e) { console.error(e); }
}

// ---------- tasks ----------
async function loadTasks() {
  const board = await api('/tasks');
  const nice = { draft: 'Draft', in_progress: 'In progress', blocked: 'Blocked', awaiting_approval: 'Awaiting approval', completed: 'Completed' };
  $('#taskBoard').innerHTML = Object.keys(nice).map(st => `
    <div class="col"><div class="col-title">${nice[st]}<span>${board[st].length}</span></div>
    ${board[st].map(t => `
      <div class="card ${st === 'blocked' ? 'blocked' : ''}">
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta"><span class="owner-chip">${esc(t.owner_type || '')}</span><span>P${t.priority_score}</span><span>${esc(t.agent)}</span></div>
        <div class="card-actions">
          ${st !== 'in_progress' && st !== 'completed' ? `<button class="btn small" onclick="moveTask('${t.id}','in_progress')">Start</button>` : ''}
          ${st === 'in_progress' ? `<button class="btn small" onclick="moveTask('${t.id}','completed')">Done</button><button class="btn small" onclick="moveTask('${t.id}','blocked')">Block</button>` : ''}
          ${st === 'blocked' ? `<button class="btn small" onclick="moveTask('${t.id}','in_progress')">Unblock</button>` : ''}
        </div>
      </div>`).join('')}
    </div>`).join('');
}
window.moveTask = async (id, status) => { await api('/tasks/' + id, 'PATCH', { status }); toast('Task ' + status.replace('_', ' ')); loadTasks(); };
$('#taskCreate').addEventListener('click', async () => {
  const title = $('#taskTitle').value.trim(); if (!title) return toast('Give the task a title');
  await api('/tasks', 'POST', { title, agent: $('#taskAgent').value, impact: +$('#taskImpact').value, urgency: +$('#taskUrgency').value, revenue_linked: $('#taskRevenue').checked });
  $('#taskTitle').value = ''; toast('Task created'); loadTasks();
});

// ---------- approvals ----------
async function loadApprovals() {
  const rows = await api('/approvals');
  $('#approvalList').innerHTML = rows.length ? rows.map(a => `
    <div class="approval ${a.status}">
      <div class="approval-title">${esc(a.title)}</div>
      <div class="approval-meta">${esc(a.category)} · ${a.status} · ${new Date(a.created_at).toLocaleDateString()}${a.decision_note ? ' · “' + esc(a.decision_note) + '”' : ''}</div>
      ${a.status === 'pending' ? `
        <div class="form-row">
          <button class="btn small approve" onclick="decide('${a.id}','approved')">Approve</button>
          <button class="btn small reject" onclick="decide('${a.id}','rejected')">Reject</button>
        </div>` : ''}
    </div>`).join('') : '<div class="mini-item dim">Queue is clear. Nothing is waiting on you.</div>';
}
window.decide = async (id, decision) => {
  const note = prompt(decision === 'approved' ? 'Approval note (optional):' : 'Why rejecting? (optional)') || '';
  await api('/approvals/' + id + '/decide', 'POST', { decision, note });
  toast(decision === 'approved' ? 'Approved ✓' : 'Rejected'); loadApprovals(); loadOverview();
};

// ---------- kpis ----------
async function loadKpis() {
  const board = await api('/kpis/health');
  const sel = $('#kpiMetric');
  if (!sel.options.length) sel.innerHTML = board.map(b => `<option value="${b.metric}">${esc(b.label || b.metric)}</option>`).join('');
  $('#kpiBoard').innerHTML = board.map(k => `
    <div class="kpi">
      <div class="kpi-label">${esc(k.label || k.metric)}</div>
      <div class="kpi-val">${k.value == null ? '—' : fmtVal(k)}</div>
      <div class="kpi-meta">target ${k.unit === 'rate' ? (k.target * 100) + '%' : k.target}${k.scale_at ? ' · scale at ' + (k.unit === 'rate' ? (k.scale_at * 100) + '%' : k.scale_at) : ''}</div>
      <span class="status ${k.status}">${k.status.replace(/_/g, ' ')}</span>
      ${k.trend && k.trend !== 'flat' ? `<span class="trend ${k.trend}">${k.trend === 'improving' ? '▲' : '▼'} ${k.trend}</span>` : ''}
    </div>`).join('');
}
$('#kpiLog').addEventListener('click', async () => {
  const v = $('#kpiValue').value; if (v === '') return toast('Enter a value');
  await api('/kpis', 'POST', { metric: $('#kpiMetric').value, value: +v, period: $('#kpiPeriod').value || undefined });
  $('#kpiValue').value = ''; toast('KPI recorded'); loadKpis(); loadOverview();
});

// ---------- growth ----------
async function loadGrowth() {
  const props = await api('/growth/properties');
  const sel = $('#growthProperty');
  if (!sel.options.length) sel.innerHTML = props.map(p => `<option value="${p.key}">${esc(p.label)}</option>`).join('');
  const audits = await api('/audits?module=growth');
  $('#growthAudits').innerHTML = audits.length ? audits.map(a =>
    `<div class="mini-item"><span class="id">${a.id}</span> ${esc(a.property_label || a.property)} <span class="dim">· ${a.status} · ${new Date(a.created_at).toLocaleDateString()}</span></div>`).join('')
    : '<div class="mini-item dim">No growth audits yet.</div>';
  const opps = await api('/growth/opportunities');
  $('#opportunities').innerHTML = opps.length ? opps.map(o =>
    `<div class="mini-item"><span class="sev ${o.severity}">${o.severity}</span><b>${o.opportunity_score}/10</b> ${esc(o.title)}<div class="dim">${esc(o.recommendation || '')}</div></div>`).join('')
    : '<div class="mini-item dim">No findings logged. Open an audit and add findings.</div>';
}
$('#growthAuditCreate').addEventListener('click', async () => {
  const a = await api('/growth/audits', 'POST', { property: $('#growthProperty').value });
  toast('Audit opened: ' + a.id); loadGrowth();
});
$('#whatMattersBtn').addEventListener('click', async () => {
  const w = await api('/intel/what-matters');
  const el = $('#whatMatters'); el.classList.remove('hidden');
  el.innerHTML =
    '<b>Fix:</b> ' + (w.fix.length ? w.fix.map(f => esc(f.item)).join(' · ') : 'nothing critical') +
    '<br><b>Pursue:</b> ' + (w.pursue.length ? w.pursue.map(p => esc(p.item)).join(' · ') : 'run an audit to load opportunities') +
    '<br><b>Channel priority:</b> ' + w.channels.map(c => esc(c.channel)).join(' → ');
});
$('#findingAdd').addEventListener('click', async () => {
  try {
    await api('/findings', 'POST', { audit_id: $('#findingAudit').value.trim(), title: $('#findingTitle').value.trim(), severity: $('#findingSeverity').value, opportunity_score: +$('#findingScore').value || 5 });
    toast('Finding added'); $('#findingTitle').value = ''; loadGrowth();
  } catch (e) { toast(e.message); }
});

// ---------- governance ----------
async function loadGovernance() {
  const revs = await api('/governance/revisions');
  $('#revisions').innerHTML = revs.length ? revs.map(r =>
    `<div class="mini-item"><span class="id">${r.id}</span> <b>${esc(r.section)}</b> ${esc(r.url || '')} <span class="dim">· ${r.status}</span><div class="dim">“${esc((r.proposed_copy || '').slice(0, 140))}”</div></div>`).join('')
    : '<div class="mini-item dim">No draft revisions. Nothing publishes without your approval.</div>';
}
$('#govAuditCreate').addEventListener('click', async () => {
  const a = await api('/governance/audits', 'POST', { url: $('#govUrl').value.trim(), funnel_stage: $('#govStage').value });
  toast('Page audit opened: ' + a.id);
});
$('#revDraft').addEventListener('click', async () => {
  const copy = $('#revCopy').value.trim(); if (!copy) return toast('Add proposed copy');
  await api('/governance/revisions', 'POST', { url: $('#revUrl').value.trim(), section: $('#revSection').value.trim() || 'body', proposed_copy: copy });
  $('#revCopy').value = ''; toast('Revision drafted'); loadGovernance();
});

// ---------- cinematic ----------
async function loadCinematic() {
  const projects = await api('/cinematic/projects');
  $('#cinProjects').innerHTML = projects.length ? projects.map(p =>
    `<div class="mini-item"><span class="id">${p.id}</span> <b>${esc(p.title)}</b> <span class="dim">· ${esc(p.offer || '')} · ${p.status} · ${(p.channels || []).join(', ')}</span>
     ${p.status === 'brief' ? `<div class="card-actions"><button class="btn small" onclick="genBrief('${p.id}')">Generate brief</button></div>` : ''}
    </div>`).join('') : '<div class="mini-item dim">No cinematic projects yet.</div>';
}
window.genBrief = async id => { await api('/cinematic/projects/' + id + '/brief', 'POST', {}); toast('Brief generated — moved to storyboard'); loadCinematic(); };
$('#cinCreate').addEventListener('click', async () => {
  const title = $('#cinTitle').value.trim(); if (!title) return toast('Give the project a title');
  await api('/cinematic/projects', 'POST', { title, offer: $('#cinOffer').value.trim(), channels: [$('#cinChannel').value] });
  $('#cinTitle').value = ''; toast('Project created'); loadCinematic();
});

// ---------- nurture ----------
async function loadNurture() {
  const inv = await api('/nurture/inventory');
  $('#wfInventory').innerHTML = inv.live_workflows.length ? inv.live_workflows.map(w =>
    `<div class="mini-item"><span class="id">${w.id}</span> <b>${esc(w.name)}</b> <span class="dim">· ${esc(w.funnel_stage)} · ${w.email_count || 0} emails · ${w.status}</span></div>`).join('')
    : '<div class="mini-item dim">Register your GHL workflows to build the inventory.</div>';
  $('#wfAudits').innerHTML = inv.open_qa_audits.length ? inv.open_qa_audits.map(a =>
    `<div class="mini-item"><span class="id">${a.id}</span> QA audit <span class="dim">· ${(a.checks || []).filter(c => c.result).length}/${(a.checks || []).length} checks recorded</span></div>`).join('')
    : '<div class="mini-item dim">No open QA audits.</div>';
}
$('#wfRegister').addEventListener('click', async () => {
  const name = $('#wfName').value.trim(); if (!name) return toast('Name the workflow');
  await api('/nurture/workflows', 'POST', { name, trigger: $('#wfTrigger').value.trim(), funnel_stage: $('#wfStage').value });
  $('#wfName').value = ''; toast('Workflow registered'); loadNurture();
});
$('#wfAudit').addEventListener('click', async () => {
  const a = await api('/nurture/audits', 'POST', {});
  toast('QA audit opened: ' + a.id); loadNurture();
});

// ---------- editor ----------
async function loadEditor() {
  try {
    const z = await api('/editor/zoom-status');
    $('#zoomState').textContent = z.connected ? 'Zoom connected — load your recordings below.' : 'Zoom not connected yet. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in Render, or use a direct video URL below.';
  } catch (e) { $('#zoomState').textContent = e.message; }
  loadEditJobs();
}
async function loadEditJobs() {
  try {
    const jobs = await api('/editor/jobs');
    $('#editJobs').innerHTML = jobs.length ? jobs.map(j => `
      <div class="mini-item">
        <b>${esc(j.topic || j.meeting_id || j.video_url || j.id)}</b>
        <span class="sev ${j.status === 'done' ? 'low' : j.status === 'failed' ? 'high' : 'medium'}">${j.status.replace(/_/g,' ')}</span>
        ${j.error ? `<div class="dim">${esc(j.error)}</div>` : ''}
        ${(j.results || []).map(r => `
          <div style="margin-top:6px"><b>${esc(r.title)}</b> <span class="dim">(${Math.round(r.end_seconds - r.start_seconds)}s · hook ${r.hook_strength}/10)</span><br>
          ${r.files.map(f => `<a class="gold-link" href="${f.url}" download>⬇ ${f.kind.replace(/_/g,' ')}</a>`).join(' · ')}</div>`).join('')}
      </div>`).join('') : '<div class="mini-item dim">No edit jobs yet. Load a Zoom recording or paste a video URL above.</div>';
    if (jobs.some(j => ['queued','downloading','selecting_clips','cutting'].includes(j.status))) setTimeout(loadEditJobs, 5000);
  } catch (e) { console.error(e); }
}
$('#loadRecordings').addEventListener('click', async () => {
  $('#recordingList').innerHTML = '<div class="mini-item dim">Loading…</div>';
  try {
    const recs = await api('/editor/recordings');
    $('#recordingList').innerHTML = recs.length ? recs.map(r => `
      <div class="mini-item"><b>${esc(r.topic)}</b> <span class="dim">· ${new Date(r.start_time).toLocaleDateString()} · ${r.duration_min} min</span>
      <div class="card-actions"><button class="btn small" onclick="cutZoom('${r.meeting_id}', this)">Cut clips</button></div></div>`).join('')
      : '<div class="mini-item dim">No cloud recordings in the last 30 days.</div>';
  } catch (e) { $('#recordingList').innerHTML = '<div class="mini-item dim">' + esc(e.message) + '</div>'; }
});
window.cutZoom = async (meetingId, btn) => {
  btn.textContent = 'Starting…'; btn.disabled = true;
  try { await api('/editor/jobs', 'POST', { source: 'zoom', meeting_id: meetingId }); toast('Edit job started — KIT is on it.'); loadEditJobs(); }
  catch (e) { toast(e.message); btn.textContent = 'Cut clips'; btn.disabled = false; }
};
$('#edCreateUrl').addEventListener('click', async () => {
  const video_url = $('#edUrl').value.trim(); if (!video_url) return toast('Paste a direct video URL');
  const transcript_vtt = $('#edVtt').value.trim();
  if (!transcript_vtt) return toast('URL jobs need the transcript pasted (WebVTT)');
  try { await api('/editor/jobs', 'POST', { source: 'url', video_url, transcript_vtt }); toast('Edit job started'); $('#edUrl').value=''; $('#edVtt').value=''; loadEditJobs(); }
  catch (e) { toast(e.message); }
});

// ---------- reviews ----------
const REVIEW_TYPES = ['weekly_operator', 'monthly_growth', 'bottleneck', 'scale_readiness', 'campaign', 'funnel_health', 'founder_workload'];
function loadReviews() {
  $('#reviewButtons').innerHTML = REVIEW_TYPES.map(t => `<button class="btn" onclick="runReview('${t}')">${t.replace(/_/g, ' ')}</button>`).join('');
}
window.runReview = async t => {
  const r = await api('/reviews/' + t, 'POST', {});
  $('#reviewOutput').textContent = JSON.stringify(r.content, null, 2);
  toast('Review saved: ' + r.id);
};

// ---------- activity ----------
async function loadActivity() {
  const rows = await api('/events?limit=60');
  $('#activityLog').innerHTML = rows.map(e =>
    `<div class="mini-item"><span class="id">${new Date(e.created_at).toLocaleString()}</span> <b>${esc(e.actor)}</b> ${esc(e.action)} <span class="dim">${esc(e.detail || '')}</span></div>`).join('');
}

const loaders = { overview: loadOverview, editor: loadEditor, tasks: loadTasks, approvals: loadApprovals, kpis: loadKpis, growth: loadGrowth, governance: loadGovernance, cinematic: loadCinematic, nurture: loadNurture, reviews: loadReviews, activity: loadActivity };
loadOverview();
