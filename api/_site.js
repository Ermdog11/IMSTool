// Which newsroom a request belongs to (Jeff, 2026-10-06: real separate
// newsrooms, so a tester or customer can sign up and set up their own beat).
//
// Every route is wrapped (Site.wrap) so each request carries a small "current
// newsroom" holder through all of its async work (AsyncLocalStorage). Signing
// in fills it in (_supabase.requireUser picks the user's newsroom). Code that
// needs the newsroom asks Site.slug() / Site.siteId(sb) instead of a
// hard-coded 'insidemdsports'.
//
// Anything with no signed-in user (scheduled jobs, tests, a script) gets the
// original newsroom, InsideMDSports, so it behaves exactly as before. Its data
// also stays where it always was: only other newsrooms' stored files get a
// "sites/<slug>/" prefix (Site.blobPath, used by _site-blob.js).
var { AsyncLocalStorage } = require('async_hooks');
var als = new AsyncLocalStorage();
var DEFAULT = 'insidemdsports';

function current() { return als.getStore() || null; }
function slug() { var s = current(); return (s && s.slug) || DEFAULT; }
function isDefault() { return slug() === DEFAULT; }

// Called once the request's newsroom is known (requireUser, or a cron that
// works on one newsroom at a time).
function set(site) {
  var s = current();
  if (s && site) { s.slug = site.slug || s.slug; s.id = site.id || s.id; s.name = site.name || s.name; }
}

// Run fn as one newsroom (crons looping over newsrooms).
function runAs(site, fn) { return als.run({ slug: site.slug, id: site.id || null, name: site.name || null }, fn); }

// Route wrapper. A route called in-process by another route keeps the
// caller's newsroom.
function wrap(handler) {
  var wrapped = function (req, res) {
    if (als.getStore()) return handler(req, res);
    return als.run({ slug: null, id: null, name: null }, function () { return handler(req, res); });
  };
  Object.keys(handler).forEach(function (k) { wrapped[k] = handler[k]; });
  return wrapped;
}

// The newsroom's sites.id, cached per slug.
var idCache = {};
async function siteId(sb) {
  var s = current();
  if (s && s.id) return s.id;
  var key = slug();
  if (idCache[key]) return idCache[key];
  var r = await sb.from('sites').select('id').eq('slug', key).single();
  if (r.error || !r.data) throw new Error('Newsroom "' + key + '" not found (run db/schema.sql)');
  idCache[key] = r.data.id;
  return r.data.id;
}

// Stored-file path for this newsroom. InsideMDSports keeps its original paths.
function blobPath(p) {
  p = String(p || '');
  if (isDefault() || /^https?:\/\//.test(p) || p.indexOf('sites/') === 0) return p;
  return 'sites/' + slug() + '/' + p;
}

// Every newsroom (for crons). Best-effort: [] without Supabase.
async function all(sb) {
  try {
    var r = await sb.from('sites').select('id, slug, name').order('created_at', { ascending: true });
    return r.data || [];
  } catch (e) { return []; }
}

module.exports = { DEFAULT: DEFAULT, current: current, slug: slug, isDefault: isDefault, set: set, runAs: runAs, wrap: wrap, siteId: siteId, blobPath: blobPath, all: all };
