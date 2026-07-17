const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { PublicError, securityLog } = require('./security');

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata', 'instance-data']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function blockedIpv4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
}

function blockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return blockedIpv4(ip);
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)) return true;
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

function allowedHost(hostname) {
  const configured = String(process.env.VIDEO_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return !configured.length || configured.some(host => hostname === host || hostname.endsWith('.' + host));
}

async function lookupAddresses(hostname, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

async function validateRemoteUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new PublicError('Invalid remote video URL.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new PublicError('Only credential-free HTTP(S) video URLs are allowed.', 400);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !allowedHost(hostname)) {
    throw new PublicError('Remote video host is not allowed.', 400);
  }
  const dnsTimeout = Number(process.env.VIDEO_CONNECT_TIMEOUT_MS || 15000);
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookupAddresses(hostname, dnsTimeout);
  if (!addresses.length) throw new PublicError('Remote video host could not be resolved.', 400);
  if (addresses.some(item => blockedIp(item.address))) throw new PublicError('Remote video host resolves to a private or reserved network.', 400);
  return url;
}

async function fetchFollowingSafeRedirects(input, headers) {
  let url = await validateRemoteUrl(input);
  const connectTimeout = Number(process.env.VIDEO_CONNECT_TIMEOUT_MS || 15000);
  const totalTimeout = Number(process.env.VIDEO_DOWNLOAD_TIMEOUT_MS || 900000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), connectTimeout);
    let response;
    try { response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal }); }
    catch (error) { clearTimeout(connectTimer); throw new PublicError(error.name === 'AbortError' ? 'Remote video connection timed out.' : 'Remote video connection failed.', 502); }
    clearTimeout(connectTimer);
    if (REDIRECT_CODES.has(response.status)) {
      controller.abort();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new PublicError('Remote video exceeded the redirect limit.', 400);
      url = await validateRemoteUrl(new URL(location, url).toString());
      continue;
    }
    const totalTimer = setTimeout(() => controller.abort(), totalTimeout);
    return { response, controller, totalTimer, url };
  }
  throw new PublicError('Remote video exceeded the redirect limit.', 400);
}

async function downloadToFile(input, destination, options) {
  const opts = options || {};
  const maxBytes = Number(process.env.VIDEO_MAX_BYTES || 2 * 1024 * 1024 * 1024);
  const allowedTypes = opts.allowedTypes || ['video/'];
  const partial = destination + '.part-' + process.pid + '-' + Date.now();
  let transfer;
  try {
    if (fs.existsSync(destination)) throw new PublicError('Download destination already exists.', 409);
    transfer = await fetchFollowingSafeRedirects(input, opts.headers || {});
    const { response } = transfer;
    if (!response.ok) throw new PublicError('Remote download failed with status ' + response.status + '.', 502);
    const type = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0];
    if (!allowedTypes.some(allowed => allowed.endsWith('/') ? type.startsWith(allowed) : type === allowed)) throw new PublicError('Remote file has an unsupported content type.', 415);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new PublicError('Remote file exceeds the maximum allowed size.', 413);
    if (!response.body) throw new PublicError('Remote response had no body.', 502);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new PublicError('Remote file exceeds the maximum allowed size.', 413) : null, chunk);
    }});
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(partial, { flags: 'wx' }));
    fs.renameSync(partial, destination);
    securityLog('remote_download_completed', { host: transfer.url.hostname, bytes });
    return bytes;
  } catch (error) {
    try { fs.rmSync(partial, { force: true }); } catch { /* best effort */ }
    securityLog('remote_download_failed', { host: transfer && transfer.url && transfer.url.hostname, error_name: error.name });
    throw error;
  } finally {
    if (transfer) { clearTimeout(transfer.totalTimer); transfer.controller.abort(); }
  }
}

module.exports = { blockedIp, downloadToFile, fetchFollowingSafeRedirects, validateRemoteUrl };
