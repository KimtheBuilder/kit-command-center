// Append-style event log. Every mutation in the system is traceable.
const store = require('./store');

function log(actor, action, entity, entityId, detail) {
  return store.create('events', {
    actor: actor || 'system',
    action, entity,
    entity_id: entityId || null,
    detail: detail || null
  }, 'evt');
}

function recent(limit) {
  return store.list('events').slice(-1 * (limit || 40)).reverse();
}

module.exports = { log, recent };
