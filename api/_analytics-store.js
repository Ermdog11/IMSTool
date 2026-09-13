// Audience analytics connections: per-site config for each data source
// (Chartbeat, Parse.ly, GA4, ...), stored in Supabase `analytics_connections`.
// Secret fields are AES-256-GCM encrypted (api/_crypto.js) before they're
// written — a raw DB read never yields a usable credential.

var Crypto = require('./_crypto');

// Per-source list of config keys that must be encrypted at rest.
var SECRET_FIELDS = {
  chartbeat: ['apiKey'],
  parsely: ['apiSecret']
};

function encryptFields(source, fields) {
  var secretKeys = SECRET_FIELDS[source] || [];
  var out = {};
  Object.keys(fields || {}).forEach(function(k) {
    out[k] = secretKeys.indexOf(k) !== -1 ? Crypto.encrypt(fields[k]) : fields[k];
  });
  return out;
}

function decryptFields(source, config) {
  var secretKeys = SECRET_FIELDS[source] || [];
  var out = {};
  Object.keys(config || {}).forEach(function(k) {
    out[k] = secretKeys.indexOf(k) !== -1 ? Crypto.decrypt(config[k]) : config[k];
  });
  return out;
}

// Strips secret fields entirely — safe to send to the browser as connection status.
function publicFields(source, config) {
  var secretKeys = SECRET_FIELDS[source] || [];
  var out = {};
  Object.keys(config || {}).forEach(function(k) {
    if (secretKeys.indexOf(k) === -1) out[k] = config[k];
  });
  return out;
}

async function listConnections(sb, siteId) {
  var q = await sb.from('analytics_connections').select('source, config, updated_at').eq('site_id', siteId);
  if (q.error) throw new Error(q.error.message);
  return (q.data || []).map(function(row) {
    return { source: row.source, connectedAt: row.updated_at, meta: publicFields(row.source, row.config) };
  });
}

async function getConnection(sb, siteId, source) {
  var q = await sb.from('analytics_connections').select('config').eq('site_id', siteId).eq('source', source).single();
  if (q.error || !q.data) return null;
  return decryptFields(source, q.data.config);
}

async function saveConnection(sb, siteId, source, fields, userId) {
  var config = encryptFields(source, fields);
  var up = await sb.from('analytics_connections').upsert({
    site_id: siteId, source: source, config: config, connected_by: userId, updated_at: new Date().toISOString()
  }, { onConflict: 'site_id,source' }).select('source').single();
  if (up.error) throw new Error(up.error.message);
  return up.data;
}

async function deleteConnection(sb, siteId, source) {
  var del = await sb.from('analytics_connections').delete().eq('site_id', siteId).eq('source', source);
  if (del.error) throw new Error(del.error.message);
  return { ok: true };
}

module.exports = {
  listConnections: listConnections,
  getConnection: getConnection,
  saveConnection: saveConnection,
  deleteConnection: deleteConnection
};
