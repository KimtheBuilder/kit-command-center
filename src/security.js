const crypto = require('crypto');

class PublicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PublicError';
    this.status = status || 400;
    this.expose = true;
  }
}

function insecureDevelopmentMode() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_DEV_AUTH === 'true';
}

function assertStartupSecurity() {
  if (process.env.NODE_ENV === 'production' && String(process.env.ADMIN_KEY || '').trim().length < 32) {
    throw new Error('Refusing to start: ADMIN_KEY must be at least 32 characters when NODE_ENV=production.');
  }
  if (process.env.NODE_ENV === 'production' && !String(process.env.VIDEO_ALLOWED_HOSTS || '').trim()) {
    throw new Error('Refusing to start: VIDEO_ALLOWED_HOSTS is required when NODE_ENV=production.');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error('Refusing to start: DATABASE_URL is required when NODE_ENV=production.');
  }
  if (!process.env.ADMIN_KEY && !insecureDevelopmentMode()) {
    throw new Error('Refusing to start without ADMIN_KEY. For local-only development, explicitly set ALLOW_INSECURE_DEV_AUTH=true.');
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function securityLog(event, fields) {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (/key|token|secret|authorization/i.test(key)) continue;
    safe[key] = value;
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'security', event, ...safe }));
}

function apiAuthentication(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (configured && safeEqual(req.get('x-admin-key'), configured)) {
    req.authenticatedOwner = true;
    req.securityActor = 'owner';
    return next();
  }
  if (!configured && insecureDevelopmentMode()) {
    req.authenticatedOwner = false;
    req.securityActor = 'development_user';
    return next();
  }
  securityLog('authentication_failed', { method: req.method, path: req.originalUrl, ip: req.ip });
  return res.status(configured ? 401 : 503).json({ ok: false, error: configured ? 'Authentication required.' : 'Server authentication is not configured.' });
}

function errorResponse(res, error, context) {
  const status = error && error.expose ? error.status : 500;
  securityLog('request_error', {
    method: context && context.method,
    path: context && context.path,
    status,
    error_name: error && error.name
  });
  return res.status(status).json({ ok: false, error: error && error.expose ? error.message : 'Request failed.' });
}

module.exports = { PublicError, apiAuthentication, assertStartupSecurity, errorResponse, insecureDevelopmentMode, safeEqual, securityLog };
