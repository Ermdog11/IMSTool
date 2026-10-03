// /api/story-ratings — editors rate stories 1-5; the scanner learns from it.
// See api/_story-ratings.js.
//
//   GET ?t=<signed token>&r=1..5   one-tap rating from an email (no login;
//                                  the token is signed) -> small thank-you page
//   GET                            (signed in) -> { ratings: { storyKey: 1-5 } }
//   POST { headline, source, url, ai, rating }   (signed in) -> rates a story

var S = require('./_supabase');
var SR = require('./_story-ratings');

function page(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head>' +
    '<body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#f5f7fb;color:#1a1a1a">' +
    '<div style="background:#0f1b2d;color:#fff;padding:14px 20px;font-weight:700">CoPublisher AI</div>' +
    '<div style="max-width:520px;margin:30px auto;background:#fff;border:1px solid #e2e7ef;border-radius:12px;padding:22px">' + body + '</div></body></html>';
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    var q = req.query || {};
    if (req.method === 'GET' && q.t) {
      var story = SR.readToken(q.t);
      if (!story) { res.setHeader('Content-Type', 'text/html'); return res.status(400).send(page('Link expired', '<p>That rating link isn’t valid.</p>')); }
      var row = await SR.add(Object.assign({}, story, { rating: q.r, by: 'email' }));
      var links = [1, 2, 3, 4, 5].map(function (n) {
        return '<a href="/api/story-ratings?t=' + esc(q.t) + '&r=' + n + '" style="display:inline-block;width:34px;padding:7px 0;margin-right:6px;text-align:center;border-radius:7px;text-decoration:none;font-weight:700;' +
          (n === row.editor ? 'background:#2563eb;color:#fff' : 'border:1px solid #e2e7ef;color:#2563eb') + '">' + n + '</a>';
      }).join('');
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(page('Thanks', '<p style="margin-top:0;font-size:13px;color:#555">You rated</p><p style="font-weight:700;font-size:16px">' + esc(row.headline) + '</p>' +
        '<p style="font-size:14px">' + links + '</p><p style="font-size:13px;color:#555">Thanks. ' + (row.ai && row.ai !== row.editor ? 'CoPublisher rated it a ' + row.ai + '; it will learn from your ' + row.editor + '.' : 'CoPublisher will keep rating stories like this one this way.') + ' Tap another number to change it.</p>'));
    }

    if (S.isConfigured()) {
      try { var ctx = await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    }
    if (req.method === 'GET') return res.status(200).json({ ratings: await SR.byStory() });
    if (req.method === 'POST') {
      var b = req.body || {};
      var who = ctx && ctx.user ? (ctx.user.email || ctx.user.id) : 'editor';
      var saved = await SR.add({ headline: b.headline, source: b.source, url: b.url, ai: b.ai, rating: b.rating, by: who });
      return res.status(200).json({ ok: true, rating: saved.editor });
    }
    return res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
