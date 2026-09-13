// /api/social-promo-check — cron (every 30 min): the Bluesky promo bot.
// Checks our OWN recent Bluesky posts for engagement crossing a threshold,
// and replies under any newly-hot one with a short, Claude-written
// call-to-action — so a post that's taking off gets a nudge toward more
// engagement/follows without anyone having to notice and do it by hand.
//
// Off by default (api/social-promo-settings.js) — a publisher has to turn
// it on. Only ever replies under our own posts (getOwnPosts only returns
// posts authored by our own account), never under anyone else's, and never
// replies to the same post twice (api/_social-promo-state.js).

var S = require('./_supabase');
var Bluesky = require('./_bluesky');
var State = require('./_social-promo-state');

var THRESHOLD = parseInt(process.env.BLUESKY_PROMO_THRESHOLD || '10', 10);
var LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // ignore anything older than 2 weeks

async function writeCTA(key, post) {
  var sys = 'You write a short, natural follow-up reply for InsideMDSports\' own Bluesky account (Maryland ' +
    'Terrapins sports coverage), posted as a reply under one of its own posts that is performing well right ' +
    'now. Sound like a real social media editor, not an ad: no hashtag-stuffing, no "check out our website!" ' +
    'cliché. In one short sentence, naturally encourage people to read more coverage or follow the account. ' +
    'Do not invent a specific link or article — keep it general. Under 220 characters. ' +
    'Reply with ONLY the text to post, nothing else — no quotes around it.';
  var user = 'Our post that\'s doing well:\n"' + post.text + '"\n(' + post.likeCount + ' likes, ' + post.repostCount + ' reposts)\n\nWrite the reply.';

  var cr = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, system: sys, messages: [{ role: 'user', content: user }] })
  });
  var cd = await cr.json();
  if (cd.error) throw new Error('Claude error: ' + JSON.stringify(cd.error));
  var text = (cd.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n').trim();
  if (!text) throw new Error('No usable CTA text generated.');
  return text.replace(/^["']|["']$/g, '').slice(0, 280);
}

module.exports = async function handler(req, res) {
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var sb = S.admin();
  var report = [];

  var sitesRes = await sb.from('sites').select('id, slug');
  if (sitesRes.error) return res.status(500).json({ error: sitesRes.error.message });

  for (var i = 0; i < (sitesRes.data || []).length; i++) {
    var site = sitesRes.data[i];
    try {
      var enabled = await State.isEnabled(site.slug);
      if (!enabled) { report.push({ site: site.slug, status: 'disabled' }); continue; }
      if (!Bluesky.isConfigured()) { report.push({ site: site.slug, status: 'bluesky-not-configured' }); continue; }
      var anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) { report.push({ site: site.slug, status: 'no-anthropic-key' }); continue; }

      var session = await Bluesky.createSession();
      var posts = await Bluesky.getOwnPosts(session.token, session.did, 30);

      var already = await State.alreadyRepliedUris(site.slug);
      var candidates = posts.filter(function(p) {
        if (already.indexOf(p.uri) !== -1) return false;
        if ((p.likeCount + p.repostCount) < THRESHOLD) return false;
        var age = p.createdAt ? Date.now() - new Date(p.createdAt).getTime() : Infinity;
        return age <= LOOKBACK_MS;
      });

      if (!candidates.length) { report.push({ site: site.slug, status: 'none-hot' }); continue; }

      var repliedTo = [];
      for (var j = 0; j < candidates.length; j++) {
        var post = candidates[j];
        try {
          var cta = await writeCTA(anthropicKey, post);
          await Bluesky.replyToPost(session.token, session.did, post, cta);
          repliedTo.push(post.uri);
        } catch (e) {
          report.push({ site: site.slug, status: 'reply-error', uri: post.uri, error: e.message });
        }
      }

      if (repliedTo.length) await State.markReplied(site.slug, repliedTo);
      report.push({ site: site.slug, status: 'replied', count: repliedTo.length });
    } catch (e) {
      report.push({ site: site.slug, status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ report: report });
};
