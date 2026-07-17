const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeEqual, securityLog } = require('./security');

function signingKey() {
  return process.env.ADMIN_KEY || (process.env.NODE_ENV !== 'production' ? 'insecure-development-media-key' : '');
}

function canonical(jobId, filename, expires) {
  return [jobId, filename, expires].join('\n');
}

function signature(jobId, filename, expires) {
  return crypto.createHmac('sha256', signingKey()).update(canonical(jobId, filename, expires)).digest('hex');
}

function signedUrl(jobId, filename, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + (ttlSeconds || 300);
  return '/media/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(filename) + '?expires=' + expires + '&sig=' + signature(jobId, filename, expires);
}

function safeMediaPath(root, jobId, filename) {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId) || path.basename(filename) !== filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) return null;
  const target = path.resolve(root, jobId, filename);
  const expectedRoot = path.resolve(root) + path.sep;
  return target.startsWith(expectedRoot) ? target : null;
}

function mountMedia(app, root) {
  app.get('/media/:jobId/:filename', (req, res) => {
    const { jobId, filename } = req.params;
    const expires = Number(req.query.expires);
    const sig = String(req.query.sig || '');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + 900 || !safeEqual(sig, signature(jobId, filename, expires))) {
      securityLog('media_access_denied', { job_id: jobId, filename, ip: req.ip });
      return res.status(401).json({ error: 'Invalid or expired media link.' });
    }
    const target = safeMediaPath(root, jobId, filename);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'Media not found.' });
    const realRoot = fs.realpathSync(root) + path.sep;
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(realRoot)) return res.status(404).json({ error: 'Media not found.' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(target);
  });
}

module.exports = { mountMedia, safeMediaPath, signedUrl };
