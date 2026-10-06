// @vercel/blob, per newsroom: same functions, but paths are filed under the
// current newsroom (_site.js blobPath). InsideMDSports' paths are unchanged.
var blob = require('@vercel/blob');
var Site = require('./_site');

function P(p) { return Site.blobPath(p); }
function strip(p) { var pre = 'sites/' + Site.slug() + '/'; return Site.isDefault() || typeof p !== 'string' || p.indexOf(pre) !== 0 ? p : p.slice(pre.length); }

module.exports = Object.assign({}, blob, {
  get: function (p, o) { return blob.get(P(p), o); },
  put: function (p, b, o) { return blob.put(P(p), b, o); },
  head: function (p, o) { return blob.head(P(p), o); },
  del: function (p, o) { return blob.del(Array.isArray(p) ? p.map(P) : P(p), o); },
  list: async function (o) {
    o = Object.assign({}, o || {});
    if (!Site.isDefault()) o.prefix = P(o.prefix || '');
    var r = await blob.list(o);
    if (!Site.isDefault() && r && r.blobs) r.blobs = r.blobs.map(function (b) { return Object.assign({}, b, { pathname: strip(b.pathname) }); });
    // InsideMDSports' listings never include other newsrooms' files.
    if (Site.isDefault() && r && r.blobs) r.blobs = r.blobs.filter(function (b) { return String(b.pathname || '').indexOf('sites/') !== 0; });
    return r;
  }
});
