// /api/analytics-connections — manage per-site audience analytics connections.
//
//   GET                              -> { connections: [{source, connectedAt, meta}] }  (any member)
//   POST { source, ...fields }       -> connect/update a source (publisher only)
//   POST { action:'disconnect', source } -> remove a source (publisher only)
//
// Secrets (API keys) are encrypted before storage (api/_crypto.js) and never
// echoed back — GET only ever returns non-secret fields (e.g. a host/domain).

var S = require('./_supabase');
var Crypto = require('./_crypto');
var Store = require('./_analytics-store');

// What each source needs to connect, and which fields are secret. Kept here
// (rather than trusting the client) so the API validates before encrypting.
var SOURCES = {
  chartbeat: { required: ['apiKey', 'host'] },
  parsely: { required: ['apiSecret', 'siteId'] }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  var sb = ctx.supabase, siteId = ctx.site.id;

  if (req.method === 'GET') {
    try {
      var connections = await Store.listConnections(sb, siteId);
      return res.status(200).json({ connections: connections });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  if (ctx.membership.role !== 'publisher') {
    return res.status(403).json({ error: 'Only the publisher can manage analytics connections.' });
  }

  var body = req.body || {};
  var source = body.source;
  if (!source || !SOURCES[source]) return res.status(400).json({ error: 'Unknown source.' });

  if (body.action === 'disconnect') {
    try {
      await Store.deleteConnection(sb, siteId, source);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  var missing = SOURCES[source].required.filter(function(k) { return !body[k] || !String(body[k]).trim(); });
  if (missing.length) return res.status(400).json({ error: 'Missing: ' + missing.join(', ') });

  if (!Crypto.isConfigured()) {
    return res.status(503).json({ error: 'Analytics encryption key not set up yet (ANALYTICS_ENCRYPTION_KEY) — tell Claude to walk through generating one.' });
  }

  var fields = {};
  SOURCES[source].required.forEach(function(k) { fields[k] = String(body[k]).trim(); });

  try {
    await Store.saveConnection(sb, siteId, source, fields, ctx.user.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
