// Reads a social media post from its link, for "From social"
// (api/write-from-post.js), so a writer can paste just the link instead of a
// screenshot. Best-effort; returns null when the post can't be read.
//
//   X / Twitter status links: the X API (the newsroom's saved X bearer token,
//     the same one the scanner uses; ~half a cent per read). Text, author and
//     the first photo.
//   Everything else: the page's public preview tags (og:/twitter: title,
//     description, image), which is what a link preview shows. Public pages,
//     news sites, YouTube, many Instagram/Threads posts work. Facebook usually
//     answers apps with a login page, which is detected and treated as
//     unreadable (the writer then pastes a screenshot).
var Settings = require('./_settings-store.js');

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function withTimeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; }

function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim();
}

function meta(html, names) {
  for (var i = 0; i < names.length; i++) {
    var n = names[i].replace(/[:.]/g, '\\$&');
    var m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) ||
            html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + n + '["\']', 'i'));
    if (m && m[1]) return decode(m[1]);
  }
  return '';
}

async function fetchImage(url) {
  try {
    var r = await fetch(url, { headers: { 'User-Agent': UA }, signal: withTimeout(8000) });
    var type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    var buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return { data: buf.toString('base64'), mediaType: type };
  } catch (e) { return null; }
}

async function readX(id, sb) {
  var x = sb ? await Settings.getXSearch(sb) : null;
  if (!x || !x.bearerToken) return null;
  var r = await fetch('https://api.x.com/2/tweets/' + id + '?tweet.fields=created_at,note_tweet&expansions=author_id,attachments.media_keys' +
    '&media.fields=url,preview_image_url,type&user.fields=name,username', { headers: { Authorization: 'Bearer ' + x.bearerToken }, signal: withTimeout(8000) });
  var d = await r.json().catch(function () { return null; });
  if (!r.ok || !d || !d.data) return null;
  var user = ((d.includes && d.includes.users) || [])[0] || {};
  var media = ((d.includes && d.includes.media) || []).filter(function (m) { return m.url || m.preview_image_url; })[0];
  return {
    via: 'X',
    author: user.username ? (user.name ? user.name + ' (@' + user.username + ')' : '@' + user.username) + ' on X' : '',
    text: (d.data.note_tweet && d.data.note_tweet.text) || d.data.text || '',
    date: d.data.created_at || '',
    image: media ? await fetchImage(media.url || media.preview_image_url) : null
  };
}

async function readPreview(url) {
  var r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: withTimeout(9000) });
  if (!r.ok) return null;
  var html = (await r.text()).slice(0, 600000);
  var title = meta(html, ['og:title', 'twitter:title']) || decode((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]);
  var desc = meta(html, ['og:description', 'twitter:description', 'description']);
  var img = meta(html, ['og:image', 'twitter:image', 'og:image:url']);
  if (/log ?in|sign ?up|log into|create an account/i.test(title + ' ' + desc) && !/\b(said|says|announc|report)/i.test(desc)) return null;
  if (!title && !desc) return null;
  return { via: 'link preview', author: meta(html, ['og:site_name']), text: [title, desc].filter(Boolean).join('\n'), date: '', image: img ? await fetchImage(img) : null };
}

async function readPostLink(url, sb) {
  try {
    var m = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
    if (m) { var t = await readX(m[1], sb); if (t) return t; }
    return await readPreview(url);
  } catch (e) { return null; }
}

module.exports = { readPostLink: readPostLink };
