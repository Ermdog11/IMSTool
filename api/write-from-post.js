// "From social" (Content Editor tab): paste a social media post (a screenshot,
// its text, a link) and CoPublisher finds the beat's angle in it and drafts the
// article. Example from Jeff (2026-10-03): a Facebook "Top 10 all-time
// Montgomery County football players" graphic, where two names have Maryland
// ties; the story is "two former Terps land on the county's all-time top 10".
//
//   POST { image?: {data: <base64>, mediaType}, text?, url?, poster?, note? }
//     (any one of image, text or url is enough; a url is read by _post-link.js)
//     -> { relevant, angle, people:[{name, tie, confidence}], headline, id? }
//
// Claude reads the image itself (vision) and checks every name against the
// beat profile's watch lists (roster, staff, alumni, commits) and its own
// knowledge; ties it can't confirm from the watch lists go into factsToCheck.
// The draft is saved to Editorial Desk drafts like Write it, so the writer
// opens the Content Editor on it. Nothing is published or posted.
var S = require('./_supabase.js');
var Beat = require('./_beat.js');
var Drafts = require('./_drafts.js');
var Settings = require('./_settings-store.js');
var relatedArticleIndex = require('./copyedit.js').relatedArticleIndex;

var TOOL = {
  name: 'submit_post_story',
  description: 'Return the beat angle found in the social post and, when there is one, the drafted article.',
  input_schema: {
    type: 'object',
    properties: {
      relevant: { type: 'boolean', description: 'True when the post has a genuine connection to the beat (a current or former player, coach, staff member, recruit or the program itself).' },
      angle: { type: 'string', description: 'One or two sentences: the story for this outlet\'s readers, or why there isn\'t one.' },
      people: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            tie: { type: 'string', description: 'Their connection to the beat, e.g. "former Maryland running back (2008-11)".' },
            confidence: { type: 'string', enum: ['watch list', 'known', 'unsure'], description: '"watch list" = on the beat profile lists below; "known" = from your own knowledge; "unsure" = possible but unconfirmed.' }
          },
          required: ['name', 'tie', 'confidence']
        }
      },
      headline: { type: 'string', description: 'Publishable, accurate, under 90 characters. Empty when not relevant.' },
      article: { type: 'string', description: 'The article as Markdown, 200-450 words, in the house style. Empty when not relevant.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Notes for the writer: reporting to add, who to call, how to make it better.' },
      factsToCheck: { type: 'array', items: { type: 'string' }, description: 'Every fact a human must verify before publishing: any tie, year, position or stat not stated in the post or the watch lists.' }
    },
    required: ['relevant', 'angle', 'people', 'headline', 'article', 'notes', 'factsToCheck']
  }
};

function mdToHtml(t) {
  var s = String(t || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="text-decoration:underline;text-underline-offset:2px">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s.split(/\n\s*\n/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).filter(Boolean).join('\n');
}

module.exports = async function handler(req, res) {
  var auth;
  try { auth = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await require('./_access').allowed(auth, 'tab_social'))) return require('./_access').deny(res);

  var body = req.body || {};
  var text = String(body.text || '').trim().slice(0, 8000);
  var url = /^https?:\/\//i.test(body.url || '') ? String(body.url).slice(0, 2000) : '';
  var poster = String(body.poster || '').trim().slice(0, 200);
  var note = String(body.note || '').trim().slice(0, 2000);
  var img = body.image && body.image.data ? body.image : null;
  var mediaType = img && /^image\/(jpeg|png|webp|gif)$/.test(img.mediaType) ? img.mediaType : 'image/jpeg';
  if (!img && !text && !url) return res.status(400).json({ error: 'Add the post: a link, a screenshot or its text' });

  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  try {
    var sb = S.isConfigured() ? S.admin() : null;
    var beat = await Beat.getBeat(sb);
    var houseStyle = sb ? await Settings.getHouseStyle(sb) : null;
    var related = [];
    try { related = await relatedArticleIndex(); } catch (e) { /* links are optional */ }
    // A pasted link is read too (X posts via the X API, other pages via their
    // preview tags); its photo stands in when no screenshot was added.
    var link = url ? await require('./_post-link.js').readPostLink(url, sb) : null;
    if (link && link.image && !img) { img = link.image; mediaType = link.image.mediaType; }
    if (!img && !text && !(link && link.text)) {
      return res.status(400).json({ error: 'Couldn\u2019t read that link (Facebook and some other sites hide posts from apps). Take a screenshot of the post and add it instead.' });
    }
    if (!poster && link && link.author) poster = link.author;
    var t = beat.team, Sh = t.short;
    var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });

    var sys = 'You are a writer and editor for ' + beat.outletName + ', covering ' + beat.coverage + '. Today is ' + today + '. ' +
      'An editor has pasted a social media post. Your job: find the story in it for ' + Sh + ' readers and draft it.\n\n' +
      '1. Read everything in the post (image text included). List every person, team or school in it that has a real connection to ' + Sh + ': current or former players, coaches and staff, recruits and commits, the program itself. Check names against the PEOPLE TO WATCH lists below and the CONTEXT (current roster, roster changes, our coverage) first, then search_knowledge_base; use your own knowledge only as a last resort. Beware of shared names (a different person with the same name is not a tie). Never invent a tie.\n' +
      '2. If there is a genuine ' + Sh + ' angle, write the article around it: lead with what it means for ' + Sh + ' (e.g. "Two former ' + Sh + ' players landed on a list of the best players in their home county\'s history"), attribute the post (who posted it and where) as the source, give each ' + Sh + '-connected person a line or two on their ' + Sh + ' ties, and mention the rest of the post only as context. Use only facts in the post, the editor\'s note and the lists below; anything you add from your own knowledge (years, positions, stats, honors) goes into factsToCheck. No invented quotes or numbers.\n' +
      '3. If there is no genuine ' + Sh + ' connection, set relevant:false, explain in angle, and leave headline and article empty.\n' +
      '- Insert Markdown links to related ' + beat.outletName + ' coverage from the list below where a phrase genuinely connects; never invent a URL.\n' +
      '- Lightly: make the first two sentences answer who/what on their own and name people in full on first mention.\n\n' +
      '=== HOUSE STYLE GUIDE (write in this voice) ===\n' + (houseStyle || '(none set: AP style, active voice, tight sentences, attribute claims, no cliches)') + '\n\n' +
      Beat.watchListText(beat);

    var userText = (poster ? 'POSTED BY: ' + poster + '\n' : '') + (url ? 'POST URL: ' + url + '\n' : '') +
      (text ? 'POST TEXT:\n' + text + '\n' : '') +
      (link && link.text ? 'POST AS READ FROM ITS LINK (' + link.via + (link.date ? ', posted ' + link.date : '') + '):\n' + link.text + '\n' : '') +
      (img ? '(The post\'s ' + (link && link.image && img === link.image ? 'image' : 'screenshot') + ' is attached.)\n' : '') +
      (note ? '\nEDITOR\'S NOTE (trusted context from the newsroom):\n' + note + '\n' : '') +
      '\nRELATED ARTICLES (for internal links):\n' + (related.map(function (r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n') || '(none available)');

    var content = [];
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: String(img.data).replace(/^data:[^,]+,/, '') } });
    content.push({ type: 'text', text: userText });

    // Grounded like every writing tool (api/_writer.js): our knowledge base,
    // current roster, roster changes, calendar, plus knowledge-base and web
    // research before it writes.
    var out = await require('./_writer').writeGrounded({
      key: key, system: sys, topic: [poster, text, link && link.text, note].filter(Boolean).join(' ').slice(0, 1200),
      content: content, tool: TOOL, web: 2, maxTokens: 4000
    });
    if (!out || typeof out.relevant !== 'boolean') throw new Error('No usable result returned');
    var result = { relevant: out.relevant, angle: out.angle || '', people: out.people || [], headline: out.headline || '' };
    if (!out.relevant || !out.article) return res.status(200).json(result);

    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var now = new Date().toISOString();
    var requester = auth && auth.user && auth.user.email;
    var notes = (out.notes || []).slice();
    notes.unshift('Written from a social post' + (poster ? ' by ' + poster : '') + (url ? ' (' + url + ')' : '') + '. Angle: ' + result.angle);
    await Drafts.saveDraft({
      id: id, writerName: 'AI draft (From social)' + (requester ? ' for ' + requester : ''), tier: 'free',
      headline: out.headline, headlines: [{ label: '', text: out.headline }],
      html: mdToHtml(out.article), notes: notes, factsToCheck: out.factsToCheck || [],
      sourceUrl: url || null, autoGenerated: true, ownerId: (auth && auth.user && auth.user.id) || null, ownerEmail: requester || null,
      status: 'draft', createdAt: now, updatedAt: now
    });
    result.id = id;
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
