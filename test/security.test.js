const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-security-test-'));
process.env.NODE_ENV = 'test';
process.env.ADMIN_KEY = 'test-admin-key-that-is-long';
process.env.MCP_PATH_TOKEN = 'test-mcp-token';
process.env.DATA_DIR = DATA_DIR;
process.env.API_RATE_LIMIT = '100';

const { assertStartupSecurity, securityLog } = require('../src/security');
const { createApp } = require('../server');
const media = require('../src/media');
const editor = require('../src/modules/editor');
const remote = require('../src/remoteDownload');

let server;
let base;

async function request(route, options) {
  return fetch(base + route, options);
}

function auth(body, method) {
  return { method: method || 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY }, body: JSON.stringify(body || {}) };
}

test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('production refuses to start without ADMIN_KEY and dev bypass is explicit', () => {
  const oldEnv = process.env.NODE_ENV;
  const oldKey = process.env.ADMIN_KEY;
  const oldBypass = process.env.ALLOW_INSECURE_DEV_AUTH;
  process.env.NODE_ENV = 'production'; delete process.env.ADMIN_KEY;
  assert.throws(assertStartupSecurity, /ADMIN_KEY is required/);
  process.env.NODE_ENV = 'development'; delete process.env.ALLOW_INSECURE_DEV_AUTH;
  assert.throws(assertStartupSecurity, /explicitly set/);
  process.env.ALLOW_INSECURE_DEV_AUTH = 'true';
  assert.doesNotThrow(assertStartupSecurity);
  process.env.NODE_ENV = oldEnv; process.env.ADMIN_KEY = oldKey;
  if (oldBypass === undefined) delete process.env.ALLOW_INSECURE_DEV_AUTH; else process.env.ALLOW_INSECURE_DEV_AUTH = oldBypass;
});

test('health is minimal, API is authenticated, and security headers are present', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.ok(health.headers.get('content-security-policy'));
  const body = await health.json();
  assert.deepEqual(body, { ok: true, service: 'kit-command-center' });
  assert.doesNotMatch(JSON.stringify(body), /data_dir|admin_key|mcp_configured/i);

  assert.equal((await request('/api/summary')).status, 401);
  const summary = await request('/api/summary', { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
  assert.equal(summary.status, 200);
  assert.ok(summary.headers.get('ratelimit'));
  assert.equal((await request('/api/diagnostics')).status, 401);
  assert.equal((await request('/api/diagnostics', { headers: { 'x-admin-key': process.env.ADMIN_KEY } })).status, 200);
});

test('frontend contains no inline script handlers blocked by the CSP', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /\sonclick=/i);
  assert.match(source, /data-action=/);
});

test('API rate limiting enforces configured request ceilings', async () => {
  process.env.API_RATE_LIMIT = '1';
  const limitedServer = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => limitedServer.once('listening', resolve));
  const limitedBase = 'http://127.0.0.1:' + limitedServer.address().port;
  const headers = { 'x-admin-key': process.env.ADMIN_KEY };
  assert.equal((await fetch(limitedBase + '/api/summary', { headers })).status, 200);
  assert.equal((await fetch(limitedBase + '/api/summary', { headers })).status, 429);
  await new Promise(resolve => limitedServer.close(resolve));
  process.env.API_RATE_LIMIT = '100';
});

test('structured security logs redact secret-like fields', () => {
  const original = console.log;
  let line = '';
  console.log = value => { line = value; };
  try { securityLog('test_event', { token: 'do-not-log', api_key: 'secret', path: '/safe' }); }
  finally { console.log = original; }
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'test_event');
  assert.equal(parsed.path, '/safe');
  assert.equal(parsed.token, undefined);
  assert.equal(parsed.api_key, undefined);
});

test('mutation bodies require JSON objects and required fields', async () => {
  const wrongType = await request('/api/tasks', { method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY, 'content-type': 'text/plain' }, body: 'hello' });
  assert.equal(wrongType.status, 415);
  const missing = await request('/api/tasks', auth({}));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /title/);
  const invalid = await request('/api/tasks', { method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY, 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, error: 'Invalid JSON body.' });
});

test('unexpected internal errors are sanitized', async () => {
  const response = await request('/api/reviews/not-a-real-review', auth({}));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'Request failed.' });
});

test('approval actor is server-derived, attempts are logged, and decisions are one-time', async () => {
  const createdResponse = await request('/api/approvals', auth({ title: 'Security approval' }));
  const created = (await createdResponse.json()).data;
  const decidedResponse = await request('/api/approvals/' + created.id + '/decide', auth({ decision: 'approved', actor: 'attacker' }));
  assert.equal(decidedResponse.status, 200);
  const decided = (await decidedResponse.json()).data;
  assert.equal(decided.approval.decided_by, 'owner');

  const repeated = await request('/api/approvals/' + created.id + '/decide', auth({ decision: 'rejected' }));
  assert.equal(repeated.status, 409);
  const events = await request('/api/events?limit=100', { headers: { 'x-admin-key': process.env.ADMIN_KEY } }).then(r => r.json());
  const actions = events.data.filter(event => event.entity_id === created.id).map(event => event.action);
  assert.ok(actions.includes('approval.attempted'));
  assert.ok(actions.includes('approval.approved'));
  assert.ok(actions.includes('approval.attempt_failed'));
});

test('media requires a valid unexpired signature and blocks traversal', async () => {
  const job = 'edit_testjob';
  const filename = 'clip.mp4';
  const dir = path.join(editor.MEDIA_ROOT, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), 'video');
  assert.equal(media.safeMediaPath(editor.MEDIA_ROOT, job, '../secret'), null);
  assert.equal((await request('/media/' + job + '/' + filename)).status, 401);
  assert.equal((await request(media.signedUrl(job, filename, -1))).status, 401);
  const signed = media.signedUrl(job, filename, 60);
  const response = await request(signed);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'video');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('MCP DELETE validates the path token', async () => {
  assert.equal((await request('/mcp/wrong', { method: 'DELETE' })).status, 401);
  assert.equal((await request('/mcp/' + process.env.MCP_PATH_TOKEN, { method: 'DELETE' })).status, 200);
});

test('private, loopback, metadata, and reserved addresses are blocked', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1']) {
    const host = ip.includes(':') ? '[' + ip + ']' : ip;
    await assert.rejects(remote.validateRemoteUrl('http://' + host + '/video.mp4'));
  }
  await assert.rejects(remote.validateRemoteUrl('http://metadata.google.internal/video.mp4'), /not allowed/);
  await assert.doesNotReject(remote.validateRemoteUrl('https://93.184.216.34/video.mp4'));
});

test('allowed-host policy is enforced', async () => {
  process.env.VIDEO_ALLOWED_HOSTS = 'videos.example.com';
  try { await assert.rejects(remote.validateRemoteUrl('https://93.184.216.34/video.mp4'), /not allowed/); }
  finally { delete process.env.VIDEO_ALLOWED_HOSTS; }
});

test('connection timeout aborts stalled remote requests', async () => {
  const originalFetch = global.fetch;
  process.env.VIDEO_CONNECT_TIMEOUT_MS = '10';
  global.fetch = async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  try { await assert.rejects(remote.fetchFollowingSafeRedirects('https://93.184.216.34/video.mp4'), /timed out/); }
  finally { global.fetch = originalFetch; delete process.env.VIDEO_CONNECT_TIMEOUT_MS; }
});

test('total download timeout aborts stalled response bodies and removes partial files', async () => {
  const originalFetch = global.fetch;
  const target = path.join(DATA_DIR, 'timed-out.mp4');
  process.env.VIDEO_DOWNLOAD_TIMEOUT_MS = '10';
  global.fetch = async (url, options) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12'));
        options.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  try { await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target)); }
  finally { global.fetch = originalFetch; delete process.env.VIDEO_DOWNLOAD_TIMEOUT_MS; }
  assert.equal(fs.existsSync(target), false);
});

test('redirect destinations are revalidated', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.mp4' } });
  try { await assert.rejects(remote.fetchFollowingSafeRedirects('https://93.184.216.34/video.mp4'), /private or reserved/); }
  finally { global.fetch = originalFetch; }
});

test('download validates content type and size and removes partial files', async () => {
  const originalFetch = global.fetch;
  const target = path.join(DATA_DIR, 'bad-download.mp4');
  process.env.VIDEO_MAX_BYTES = '4';
  global.fetch = async () => new Response('12345', { status: 200, headers: { 'content-type': 'video/mp4' } });
  try { await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target), /maximum allowed size/); }
  finally { global.fetch = originalFetch; delete process.env.VIDEO_MAX_BYTES; }
  assert.equal(fs.existsSync(target), false);

  global.fetch = async () => new Response('html', { status: 200, headers: { 'content-type': 'text/html' } });
  try { await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target), /content type/); }
  finally { global.fetch = originalFetch; }
  assert.equal(fs.existsSync(target), false);
});
