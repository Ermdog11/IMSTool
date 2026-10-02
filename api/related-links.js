// /api/related-links — the Content Editor's "Add related links" box: 1-4
// "Related" links placed as a block in the finished article (slider 1-10 for
// where), picked by Claude from either our own coverage only or anywhere on
// the web.
//
//   POST { article, headline, count:1-4, scope:'site'|'web', exclude:[urls] }
//     -> { links:[{ headline, url, external }] }
//
// `exclude` is the URLs the edit already hotlinked inside the text. At most
// half of the picks may repeat one of those (Jeff, 2026-10-02: "avoid more
// than 50% of them being the same ones being auto-hotlinked") — enforced here
// in code, not just asked of the model, and only relaxed when there aren't
// enough other good candidates.
//
// Only URLs Claude actually saw come back: our recent-articles index, a
// knowledge-base hit with a real url, or a web_search result. Anything else is
// dropped as a possible made-up link.

var S = require('./_supabase');
var CE = require('./copyedit');

var MODEL = 'claude-sonnet-4-6';

function norm(u) { return String(u || '').trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase(); }

function pickTool(count) {
  return {
    name: 'pick_links',
    description: 'Return the related links, best first.',
    input_schema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          description: 'Up to ' + (count + 3) + ' candidates ranked best first; extras are used as backups.',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              headline: { type: 'string', description: 'The article\'s real headline, cleaned up (no site name suffix).' }
            },
            required: ['url', 'headline']
          }
        }
      },
      required: ['links']
    }
  };
}

// At most floor(count/2) picks may repeat an in-text hotlink; fill from the
// skipped repeats only if we'd otherwise come up short.
function applyOverlapCap(ranked, count, exclude) {
  var ex = {};
  exclude.forEach(function (u) { ex[norm(u)] = 1; });
  var cap = Math.floor(count / 2), used = 0, out = [], skipped = [];
  ranked.forEach(function (l) {
    if (out.length >= count) return;
    if (ex[norm(l.url)]) {
      if (used < cap) { used++; out.push(l); } else skipped.push(l);
    } else out.push(l);
  });
  while (out.length < count && skipped.length) out.push(skipped.shift());
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (S.isConfigured()) {
    try { await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  }
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var body = req.body || {};
  var article = String(body.article || '').slice(0, 20000);
  if (article.replace(/\s+/g, ' ').length < 200) return res.status(400).json({ error: 'Run the edit first, so there\'s an article to find related links for.' });
  var count = Math.max(1, Math.min(4, parseInt(body.count, 10) || 3));
  var scope = body.scope === 'web' ? 'web' : 'site';
  var exclude = (Array.isArray(body.exclude) ? body.exclude : []).map(String).slice(0, 60);

  var profile = {};
  try { if (S.isConfigured()) profile = await require('./_settings-store').getProfile(S.admin()); } catch (e) {}
  var outlet = profile.outletName || 'InsideMDSports';

  var allowed = {}; // norm(url) -> { url, headline, external }
  var index = [];
  try { index = await CE.relatedArticleIndex(); } catch (e) {}
  index.forEach(function (r) { allowed[norm(r.url)] = { url: r.url, headline: r.headline, external: false }; });

  var tools = [CE.KB_SEARCH_TOOL, pickTool(count)];
  if (scope === 'web') tools.unshift(CE.WEB_SEARCH_TOOL);

  var system = 'You pick "Related" links for the bottom of a sports news article published by ' + outlet + '. ' +
    'Good picks are what a reader of THIS story would click next: earlier coverage of the same player, coach, recruit or game, the news this story follows up, or useful background. ' +
    'Skip anything only loosely connected, and do not pick the same story twice.\n' +
    (scope === 'site'
      ? 'Use ONLY ' + outlet + ' articles: the RECENT ARTICLES list below, or search_knowledge_base results that have a real url. Never invent or guess a URL.\n'
      : 'Pick from anywhere on the web: ' + outlet + '\'s own articles (RECENT ARTICLES below or search_knowledge_base) and reputable outlets found with web_search. Use web_search to find strong outside coverage. Only use URLs that appeared in those results; never invent or guess a URL. Prefer real articles over team hub, roster or schedule pages.\n') +
    'These URLs are ALREADY linked inside the article text. Prefer other articles; at most ' + Math.floor(count / 2) + ' of your top ' + count + ' may come from this list:\n' +
    (exclude.length ? exclude.join('\n') : '(none)') + '\n\n' +
    'When you are done, call pick_links with up to ' + (count + 3) + ' links ranked best first.';

  var user = 'RECENT ' + outlet + ' ARTICLES:\n' +
    (index.map(function (r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n') || '(none available right now)') +
    '\n\nARTICLE' + (body.headline ? ' (headline: ' + String(body.headline).slice(0, 200) + ')' : '') + ':\n' + article;

  var messages = [{ role: 'user', content: user }];
  var picked = null;
  try {
    for (var round = 0; round < 5 && !picked; round++) {
      var r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 3000, system: system, tools: tools, messages: messages,
          // Last round: force the answer.
          tool_choice: round === 4 ? { type: 'tool', name: 'pick_links' } : { type: 'auto' }
        })
      });
      var d = await r.json();
      if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
      var content = d.content || [];

      // Remember every URL web search actually returned.
      content.forEach(function (b) {
        if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) return;
        b.content.forEach(function (x) {
          if (x && x.url && !allowed[norm(x.url)]) allowed[norm(x.url)] = { url: x.url, headline: x.title || x.url, external: true };
        });
      });

      var fin = content.filter(function (b) { return b.type === 'tool_use' && b.name === 'pick_links'; })[0];
      if (fin) { picked = (fin.input && fin.input.links) || []; break; }

      var kb = content.filter(function (b) { return b.type === 'tool_use' && b.name === 'search_knowledge_base'; });
      messages.push({ role: 'assistant', content: content });
      if (!kb.length) {
        messages.push({ role: 'user', content: 'Now call pick_links with your picks.' });
        continue;
      }
      var results = await Promise.all(kb.map(function (u) { return CE.searchKnowledgeBase(u.input && u.input.query); }));
      results.forEach(function (rs) {
        (rs.results || []).forEach(function (x) {
          if (x.url && !allowed[norm(x.url)]) allowed[norm(x.url)] = { url: x.url, headline: x.headline, external: false };
        });
      });
      messages.push({
        role: 'user',
        content: kb.map(function (u, i) { return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(results[i]) }; })
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  var seen = {};
  var ranked = (picked || []).map(function (l) {
    var a = allowed[norm(l.url)];
    if (!a || seen[norm(a.url)]) return null;
    seen[norm(a.url)] = 1;
    var headline = String(l.headline || a.headline || '').replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, '').trim().slice(0, 200);
    return { url: a.url, headline: headline || a.headline, external: a.external };
  }).filter(Boolean);

  var links = applyOverlapCap(ranked, count, exclude);
  if (!links.length) return res.status(200).json({ links: [], note: scope === 'site' ? 'Couldn\'t find related ' + outlet + ' coverage for this one. Try "Anywhere on the web".' : 'Couldn\'t find strong related coverage for this one.' });
  return res.status(200).json({ links: links });
};

module.exports.applyOverlapCap = applyOverlapCap;
