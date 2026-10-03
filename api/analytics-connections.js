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
  parsely: { required: ['apiSecret', 'siteId'] },
  // meta is OAuth-based (api/meta-oauth-start.js + meta-oauth-callback.js
  // write the connection directly) — listed here only so GET/disconnect
  // recognize it; the frontend never POSTs a manual paste for it.
  meta: { required: [] },
  // Personal API key from the newsroom's own Buffer account. The key is
  // checked against Buffer before it's saved, and the organization it
  // belongs to is stored alongside it (see the buffer branch below).
  buffer: { required: ['apiKey'] },
  // The newsroom's own X account. No key of its own: it reads through the X
  // credential the news scanner already uses (api/_x-analytics.js).
  x: { required: ['handle'] }
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

  if (source === 'x') {
    try {
      var xCreds = await require('./_settings-store').getXSearch(sb);
      if (!xCreds) return res.status(400).json({ error: 'Connect X first under Settings → X / Twitter search; X analytics reads through that connection.' });
      var xu = await require('./_x-analytics').lookupUser(xCreds.bearerToken, body.handle);
      await Store.saveConnection(sb, siteId, 'x', { handle: '@' + xu.username, username: xu.username, userId: xu.id }, ctx.user.id);
      return res.status(200).json({ ok: true, handle: '@' + xu.username });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (!Crypto.isConfigured()) {
    return res.status(503).json({ error: 'Analytics encryption key not set up yet (ANALYTICS_ENCRYPTION_KEY) — tell Claude to walk through generating one.' });
  }

  var fields = {};
  SOURCES[source].required.forEach(function(k) { fields[k] = String(body[k]).trim(); });

  if (source === 'buffer') {
    try {
      var orgs = await require('./_buffer').getOrganizations(fields.apiKey);
      if (!orgs.length) return res.status(400).json({ error: 'That Buffer key works, but its account has no organization.' });
      var org = (body.organizationId && orgs.filter(function(o) { return o.id === body.organizationId; })[0]) || orgs[0];
      if (orgs.length > 1 && !body.organizationId) {
        return res.status(200).json({ needsOrganization: true, organizations: orgs.map(function(o) { return { id: o.id, name: o.name }; }) });
      }
      fields.organizationId = org.id;
      fields.organizationName = org.name || '';
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  try {
    await Store.saveConnection(sb, siteId, source, fields, ctx.user.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
