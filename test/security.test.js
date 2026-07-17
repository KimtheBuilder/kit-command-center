const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

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
  const oldHosts = process.env.VIDEO_ALLOWED_HOSTS;
  process.env.NODE_ENV = 'production'; process.env.VIDEO_ALLOWED_HOSTS = 'video.example.com'; delete process.env.ADMIN_KEY;
  assert.throws(assertStartupSecurity, /ADMIN_KEY must be at least 32 characters/);
  process.env.ADMIN_KEY = 'short';
  assert.throws(assertStartupSecurity, /ADMIN_KEY must be at least 32 characters/);
  process.env.ADMIN_KEY = 'a'.repeat(32); delete process.env.VIDEO_ALLOWED_HOSTS;
  assert.throws(assertStartupSecurity, /VIDEO_ALLOWED_HOSTS is required/);
  process.env.NODE_ENV = 'development'; delete process.env.ADMIN_KEY; delete process.env.ALLOW_INSECURE_DEV_AUTH;
  assert.throws(assertStartupSecurity, /explicitly set/);
  process.env.ALLOW_INSECURE_DEV_AUTH = 'true';
  assert.doesNotThrow(assertStartupSecurity);
  process.env.NODE_ENV = oldEnv; process.env.ADMIN_KEY = oldKey;
  if (oldHosts === undefined) delete process.env.VIDEO_ALLOWED_HOSTS; else process.env.VIDEO_ALLOWED_HOSTS = oldHosts;
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

test('proxy trust is bounded to the direct Render proxy hop', async () => {
  const oldHops = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = '1'; process.env.API_RATE_LIMIT = '1';
  const limitedServer = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => limitedServer.once('listening', resolve));
  const limitedBase = 'http://127.0.0.1:' + limitedServer.address().port;
  const common = { 'x-admin-key': process.env.ADMIN_KEY };
  assert.equal((await fetch(limitedBase + '/api/summary', { headers: { ...common, 'x-forwarded-for': '198.51.100.10, 203.0.113.7' } })).status, 200);
  assert.equal((await fetch(limitedBase + '/api/summary', { headers: { ...common, 'x-forwarded-for': '198.51.100.11, 203.0.113.7' } })).status, 429);
  await new Promise(resolve => limitedServer.close(resolve));
  process.env.API_RATE_LIMIT = '100';
  if (oldHops === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = oldHops;
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

test('bodyless GHL sync reaches the route without a JSON validation error', async () => {
  const response = await request('/api/ghl/sync', { method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY } });
  assert.notEqual(response.status, 415);
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

  const outside = path.join(DATA_DIR, 'outside.mp4');
  fs.writeFileSync(outside, 'secret');
  const link = path.join(dir, 'linked.mp4');
  fs.symlinkSync(outside, link);
  assert.equal((await request(media.signedUrl(job, 'linked.mp4', 60))).status, 404);
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
  process.env.VIDEO_CONNECT_TIMEOUT_MS = '10';
  const stalled = async (target, headers, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  try { await assert.rejects(remote.fetchFollowingSafeRedirects('https://93.184.216.34/video.mp4', {}, stalled), /timed out/); }
  finally { delete process.env.VIDEO_CONNECT_TIMEOUT_MS; }
});

test('total download timeout aborts stalled response bodies and removes partial files', async () => {
  const target = path.join(DATA_DIR, 'timed-out.mp4');
  process.env.VIDEO_DOWNLOAD_TIMEOUT_MS = '10';
  const stalled = async (resolved, headers, signal) => {
    let sent = false;
    const stream = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.from('12')); } } });
    signal.addEventListener('abort', () => stream.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    return { ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'video/mp4' : null }, body: stream };
  };
  try { await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target, { requestImpl: stalled })); }
  finally { delete process.env.VIDEO_DOWNLOAD_TIMEOUT_MS; }
  assert.equal(fs.existsSync(target), false);
});

test('redirect destinations are revalidated', async () => {
  const redirect = async () => ({ status: 302, headers: { get: name => name === 'location' ? 'http://127.0.0.1/private.mp4' : null }, body: null });
  await assert.rejects(remote.fetchFollowingSafeRedirects('https://93.184.216.34/video.mp4', {}, redirect), /private or reserved/);
});

test('authenticated downloads reject cross-origin redirects without forwarding credentials', async () => {
  const calls = [];
  const redirect = async (target, headers) => {
    calls.push({ origin: target.url.origin, headers: { ...headers } });
    return { status: 302, headers: { get: name => name === 'location' ? 'https://93.184.216.35/video.mp4' : null }, body: null };
  };
  await assert.rejects(remote.fetchFollowingSafeRedirects('https://93.184.216.34/video.mp4', {
    Authorization: 'Bearer secret', Cookie: 'session=secret', 'Proxy-Authorization': 'Basic secret'
  }, redirect), /may not redirect/);
  assert.equal(calls.length, 1);
});

test('outbound request uses the validated address through a pinned lookup', async () => {
  const target = await remote.resolveRemoteTarget('https://93.184.216.34/video.mp4');
  assert.equal(target.address, '93.184.216.34');
  const options = remote.pinnedRequestOptions(target, {}, new AbortController().signal);
  let lookupResult;
  options.lookup('attacker-controlled.example', {}, (error, address, family) => { lookupResult = { error, address, family }; });
  assert.deepEqual(lookupResult, { error: null, address: '93.184.216.34', family: 4 });
  assert.equal(options.autoSelectFamily, false);
});

test('download validates content type and size and removes partial files', async () => {
  const target = path.join(DATA_DIR, 'bad-download.mp4');
  process.env.VIDEO_MAX_BYTES = '4';
  const response = (body, type) => async () => ({ ok: true, status: 200, headers: { get: name => name === 'content-type' ? type : null }, body: Readable.from([Buffer.from(body)]) });
  try { await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target, { requestImpl: response('12345', 'video/mp4') }), /maximum allowed size/); }
  finally { delete process.env.VIDEO_MAX_BYTES; }
  assert.equal(fs.existsSync(target), false);

  await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target, { requestImpl: response('html', 'text/html') }), /content type/);
  assert.equal(fs.existsSync(target), false);

  await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target, { requestImpl: response('not video', 'video/mp4') }), /signature/);
  assert.equal(fs.existsSync(target), false);

  await assert.rejects(remote.downloadToFile('https://93.184.216.34/video.mp4', target, { allowedTypes: ['video/', 'application/octet-stream'], requestImpl: response('not video', 'application/octet-stream') }), /explicitly allowed host/);

  process.env.VIDEO_ALLOWED_HOSTS = '93.184.216.34';
  const validMp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)]);
  try {
    await remote.downloadToFile('https://93.184.216.34/video.mp4', target, { allowedTypes: ['video/', 'application/octet-stream'], requestImpl: response(validMp4, 'application/octet-stream') });
    assert.equal(fs.existsSync(target), true);
  } finally {
    delete process.env.VIDEO_ALLOWED_HOSTS;
    fs.rmSync(target, { force: true });
  }
});
