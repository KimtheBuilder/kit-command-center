// Zoom Server-to-Server OAuth integration.
// Env: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
// KIT lists Kim's cloud recordings and downloads MP4 + VTT transcript for the editor.
const fs = require('fs');
const remoteDownload = require('./remoteDownload');

let _token = null, _tokenExp = 0;

function enabled() {
  return !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
}

async function token() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const basic = Buffer.from(process.env.ZOOM_CLIENT_ID + ':' + process.env.ZOOM_CLIENT_SECRET).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(process.env.ZOOM_ACCOUNT_ID), {
    method: 'POST', headers: { Authorization: 'Basic ' + basic }
  });
  if (!res.ok) throw new Error('Zoom auth failed (' + res.status + '). Check ZOOM_ACCOUNT_ID / CLIENT_ID / CLIENT_SECRET.');
  const d = await res.json();
  _token = d.access_token; _tokenExp = Date.now() + (d.expires_in || 3600) * 1000;
  return _token;
}

async function api(path) {
  const t = await token();
  const res = await fetch('https://api.zoom.us/v2' + path, { headers: { Authorization: 'Bearer ' + t } });
  if (!res.ok) throw new Error('Zoom API ' + res.status + ' on ' + path);
  return res.json();
}

// List recent cloud recordings (last `days`, default 30).
async function listRecordings(days) {
  const d = days || 30;
  const from = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const data = await api('/users/me/recordings?page_size=30&from=' + from);
  return (data.meetings || []).map(m => ({
    meeting_id: String(m.id),
    uuid: m.uuid,
    topic: m.topic,
    start_time: m.start_time,
    duration_min: m.duration,
    files: (m.recording_files || []).map(f => ({
      type: f.file_type, // MP4, TRANSCRIPT (VTT), M4A, CHAT...
      recording_type: f.recording_type,
      size_mb: f.file_size ? Math.round(f.file_size / 1048576) : null,
      download_url: f.download_url
    }))
  }));
}

// Pick the best MP4 + transcript for a meeting.
async function recordingAssets(meetingId) {
  const data = await api('/meetings/' + encodeURIComponent(meetingId) + '/recordings');
  const files = data.recording_files || [];
  const mp4 = files.filter(f => f.file_type === 'MP4').sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
  const vtt = files.find(f => f.file_type === 'TRANSCRIPT');
  if (!mp4) throw new Error('No MP4 found on that Zoom recording.');
  return { topic: data.topic, mp4_url: mp4.download_url, vtt_url: vtt ? vtt.download_url : null, size_mb: mp4.file_size ? Math.round(mp4.file_size / 1048576) : null };
}

// Download a Zoom-hosted file to disk (auth via bearer). Also works for plain public URLs.
async function downloadToFile(url, destPath, useAuth) {
  const headers = {};
  if (useAuth && enabled()) headers.Authorization = 'Bearer ' + await token();
  const transcript = /\.(vtt|txt)$/i.test(destPath);
  return remoteDownload.downloadToFile(url, destPath, {
    headers,
    allowedTypes: transcript ? ['text/vtt', 'text/plain', 'application/octet-stream'] : ['video/', 'application/octet-stream']
  });
}

module.exports = { enabled, listRecordings, recordingAssets, downloadToFile };
