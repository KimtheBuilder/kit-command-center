const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { PublicError, securityLog } = require('./security');

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata', 'instance-data']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

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

function configuredHosts() {
  return String(process.env.VIDEO_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
}

function allowedHost(hostname) {
  const configured = configuredHosts();
  return !configured.length || configured.some(host => hostname === host || hostname.endsWith('.' + host));
}

function explicitlyAllowedHost(hostname) {
  const configured = configuredHosts();
  return configured.length > 0 && configured.some(host => hostname === host || hostname.endsWith('.' + host));
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

async function resolveRemoteTarget(input) {
  let url;
  try { url = new URL(input); } catch { throw new PublicError('Invalid remote video URL.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new PublicError('Only credential-free HTTP(S) video URLs are allowed.', 400);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !allowedHost(hostname)) {
    throw new PublicError('Remote video host is not allowed.', 400);
  }
  const dnsTimeout = Number(process.env.VIDEO_CONNECT_TIMEOUT_MS || 15000);
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookupAddresses(hostname, dnsTimeout);
  if (!addresses.length) throw new PublicError('Remote video host could not be resolved.', 400);
  if (addresses.some(item => blockedIp(item.address))) throw new PublicError('Remote video host resolves to a private or reserved network.', 400);
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family || net.isIP(selected.address) };
}

async function validateRemoteUrl(input) {
  return (await resolveRemoteTarget(input)).url;
}

function pinnedRequestOptions(target, headers, signal) {
  return {
    method: 'GET', headers, signal, autoSelectFamily: false,
    // Keep the URL hostname for Host and TLS SNI, but never resolve it again.
    lookup(hostname, options, callback) {
      callback(null, target.address, target.family);
    }
  };
}

function pinnedRequest(target, headers, signal) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    const request = transport.request(target.url, pinnedRequestOptions(target, headers, signal), response => resolve({
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      headers: { get(name) { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value || null; } },
      body: response
    }));
    request.on('error', reject);
    request.end();
  });
}

function hasSensitiveHeaders(headers) {
  return Object.keys(headers || {}).some(name => SENSITIVE_HEADERS.has(name.toLowerCase()) || /(?:^|-)api-key$|(?:^|-)token$/i.test(name));
}

async function fetchFollowingSafeRedirects(input, headers, requestImpl) {
  let target = await resolveRemoteTarget(input);
  const initialOrigin = target.url.origin;
  const request = requestImpl || pinnedRequest;
  const connectTimeout = Number(process.env.VIDEO_CONNECT_TIMEOUT_MS || 15000);
  const totalTimeout = Number(process.env.VIDEO_DOWNLOAD_TIMEOUT_MS || 900000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), connectTimeout);
    let response;
    try { response = await request(target, headers || {}, controller.signal); }
    catch (error) { clearTimeout(connectTimer); throw new PublicError(error.name === 'AbortError' ? 'Remote video connection timed out.' : 'Remote video connection failed.', 502); }
    clearTimeout(connectTimer);
    if (REDIRECT_CODES.has(response.status)) {
      controller.abort();
      if (response.body && response.body.destroy) response.body.destroy();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new PublicError('Remote video exceeded the redirect limit.', 400);
      const next = await resolveRemoteTarget(new URL(location, target.url).toString());
      if (next.url.origin !== initialOrigin && hasSensitiveHeaders(headers)) throw new PublicError('Authenticated downloads may not redirect to a different origin.', 400);
      target = next;
      continue;
    }
    const totalTimer = setTimeout(() => controller.abort(), totalTimeout);
    return { response, controller, totalTimer, url: target.url };
  }
  throw new PublicError('Remote video exceeded the redirect limit.', 400);
}

function validDownloadedFile(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.vtt' || ext === '.txt') return buffer.toString('utf8').replace(/^\uFEFF/, '').startsWith('WEBVTT');
  const videoBrands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  ']);
  const mp4 = buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && videoBrands.has(buffer.subarray(8, 12).toString('ascii'));
  const webm = buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return mp4 || webm;
}

async function downloadToFile(input, destination, options) {
  const opts = options || {};
  const maxBytes = Number(process.env.VIDEO_MAX_BYTES || 2 * 1024 * 1024 * 1024);
  const allowedTypes = opts.allowedTypes || ['video/'];
  const partial = destination + '.part-' + process.pid + '-' + Date.now();
  let transfer;
  try {
    if (fs.existsSync(destination)) throw new PublicError('Download destination already exists.', 409);
    transfer = await fetchFollowingSafeRedirects(input, opts.headers || {}, opts.requestImpl);
    const { response } = transfer;
    if (!response.ok) throw new PublicError('Remote download failed with status ' + response.status + '.', 502);
    const type = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0];
    const octet = type === 'application/octet-stream';
    if (octet && !explicitlyAllowedHost(transfer.url.hostname)) throw new PublicError('Generic binary downloads require an explicitly allowed host.', 415);
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
    await pipeline(response.body, limiter, fs.createWriteStream(partial, { flags: 'wx' }));
    const handle = fs.openSync(partial, 'r');
    const signature = Buffer.alloc(16);
    const signatureBytes = fs.readSync(handle, signature, 0, signature.length, 0);
    fs.closeSync(handle);
    if (!validDownloadedFile(destination, signature.subarray(0, signatureBytes))) throw new PublicError('Downloaded file signature is not recognized as supported media.', 415);
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

module.exports = { blockedIp, downloadToFile, fetchFollowingSafeRedirects, pinnedRequest, pinnedRequestOptions, resolveRemoteTarget, validateRemoteUrl, validDownloadedFile };
