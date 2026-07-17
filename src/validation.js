const { PublicError } = require('./security');

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function inspect(value, depth) {
  if (depth > 8) throw new PublicError('Request body is too deeply nested.', 400);
  if (Array.isArray(value)) {
    if (value.length > 500) throw new PublicError('Request array is too large.', 400);
    value.forEach(item => inspect(item, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new PublicError('Request contains a forbidden field.', 400);
      inspect(item, depth + 1);
    }
  }
}

function validateMutationBody(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  if (req.method === 'POST' && req.path === '/ghl/sync' && !req.get('content-type')) return next();
  if (!req.is('application/json')) return next(new PublicError('Content-Type must be application/json.', 415));
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') return next(new PublicError('JSON body must be an object.', 400));
  try { inspect(req.body, 0); return next(); } catch (error) { return next(error); }
}

function requireFields(...fields) {
  return (req, res, next) => {
    const missing = fields.filter(field => typeof req.body[field] !== 'string' || !req.body[field].trim());
    return missing.length ? next(new PublicError('Required field(s): ' + missing.join(', ') + '.', 400)) : next();
  };
}

module.exports = { requireFields, validateMutationBody };
