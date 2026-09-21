// Dedicated ~30-min cron for the fast X/Twitter search pass (_x-search.js) —
// separate from rolling-digest.js's 3x/day digest cron because the whole
// point here is speed: catch a viral/breaking moment (a rival player's
// headline-worthy quote, a recruiting bombshell) as close to real-time as
// this product gets, not wait for the next scheduled digest email. A fixed
// clock cron (rather than tying this to scan.js's client-triggered auto-scan)
// keeps the metered X read cost predictable regardless of who has the
// dashboard open (Jeff confirmed 2026-09-15, ~30 min cadence).
//
// Deliberately NOT a full digest: no "InsideMDSports update" email every 30
// minutes — that's rolling-digest.js's job. This only ever posts something
// when it finds a genuinely new (never-drafted) rating-4+ story, same
// dedup-by-sourceUrl rule rolling-digest.js uses for its own breaking-draft
// block, reused verbatim here so the two crons can't double-draft the same
// story if it surfaces in both.
const S = require('./_supabase.js');
const Settings = require('./_settings-store.js');
const Drafts = require('./_drafts.js');
const Chat = require('./_chat-store.js');
const BreakingDraft = require('./_breaking-draft.js');
const mailer = require('./_mailer.js');
const push = require('./_push.js');

// What are we actively covering right now? Pulls recent "breaking" chat drops
// (auto-drafted rating-4+ stories, posted by this cron and rolling-digest.js's)
// from the last 48h and asks Claude to condense them into up to 3 short,
// X-search-ready storyline topics — e.g. a DeJuan Williams injury story
// becomes { label: "DeJuan Williams injury", query: '"DeJuan Williams" injury' }.
// Best-effort: any failure here just means this run's X search stays broad-only,
// same as before this feature existed — never blocks the scan itself.
async function activeStorylineTopics(sb, anthropicKey) {
  try {
    var siteId = await Chat.resolveSiteId(sb);
    var since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    var msgs = await Chat.recent(sb, siteId, since, 200);
    var breaking = msgs.filter(function(m) { return m.kind === 'breaking' && m.meta && m.meta.headline; });
    if (!breaking.length) return [];

    // Most recent first, distinct headlines, cap the input list small — this
    // only needs to name what's actively developing, not catalog everything.
    var seen = {};
    var headlines = [];
    breaking.slice().reverse().forEach(function(m) {
      var h = m.meta.headline.trim();
      if (seen[h]) return;
      seen[h] = 1;
      headlines.push(h);
    });
    headlines = headlines.slice(0, 8);

    var prompt = 'These are headlines InsideMDSports has already flagged as breaking/major Maryland Terrapins news in the last 48 hours:\n' +
      headlines.map(function(h, i) { return (i + 1) + '. ' + h; }).join('\n') +
      '\n\nCondense these into up to 3 DISTINCT active storylines worth tracking for new X/Twitter updates (merge headlines about the same underlying story into one). Skip anything that reads as fully resolved/closed (e.g. a final score, a completed signing with nothing left to develop) — only genuinely ongoing storylines. Return ONLY a JSON array, up to 3 items, no other text: [{"label": "short human-readable name, e.g. \'DeJuan Williams injury\'", "query": "an X search fragment for this, e.g. \'\\"DeJuan Williams\\" injury\' — quote the person/entity name, add 1-2 unquoted context words"}]. Return [] if nothing is genuinely still developing.';

    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    var d = await r.json();
    var text = ((d.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n'));
    var m2 = text.match(/\[[\s\S]*\]/);
    if (!m2) return [];
    var topics = JSON.parse(m2[0]);
    return Array.isArray(topics) ? topics.filter(function(t) { return t && t.label && t.query; }).slice(0, 3) : [];
  } catch (e) {
    console.error('activeStorylineTopics failed (non-fatal):', e.message);
    return [];
  }
}

function breakingMdToHtml(t) {
  var s = String(t || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s.split(/\n\s*\n/).map(function(p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).filter(Boolean).join('\n');
}

module.exports = async function handler(req, res) {
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  try {
    // Nothing to do if X search isn't connected — cheap no-op, not an error,
    // so this cron can stay on regardless of whether the key is set yet.
    if (!S.isConfigured()) return res.status(200).json({ skipped: 'Supabase not configured' });
    var sbAdmin = S.admin();
    var creds = await Settings.getXSearch(sbAdmin);
    if (!creds) return res.status(200).json({ skipped: 'X search not connected' });

    // What's already developing, so the X pass tracks it specifically instead
    // of only ever running the same 3 broad queries. See activeStorylineTopics
    // above — best-effort, [] just means broad-only this run.
    var storylineTopics = await activeStorylineTopics(sbAdmin, ANTHROPIC_API_KEY);

    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function(resolve, reject) {
      var fakeRes = { status: function() { return this; }, json: function(d) { resolve(d); return this; } };
      // deep:false — these are short-form social posts, not articles needing
      // a full-text re-read; speed matters more than the deep-read pass here.
      scanHandler({ body: { deep: false, xSearch: true, xStorylines: storylineTopics } }, fakeRes).catch(reject);
    });
    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);

    var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from scan');
    var allAlerts = JSON.parse(match[0]).filter(function(a) { return !a.republished; });

    var draftEligible = allAlerts.filter(function(a) { return (a.rating || 0) >= 4; });
    var results = [];
    if (draftEligible.length) {
      var sb = sbAdmin;
      var houseStyle = await Settings.getHouseStyle(sb);
      for (var i = 0; i < draftEligible.length; i++) {
        var story = draftEligible[i];
        try {
          // The dedup that keeps this cron safe to run every ~30 min: a story
          // still sitting in the window on a later run is a no-op, not a
          // re-draft/re-push/re-post.
          if (story.url && await Drafts.findBySourceUrl(story.url)) {
            results.push({ headline: story.headline, status: 'already-drafted' });
            continue;
          }

          var draft = await BreakingDraft.generateBreakingDraft(story, houseStyle);
          var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          var now = new Date().toISOString();
          var doc = {
            id: id, writerName: 'AI (breaking auto-draft)', tier: 'free',
            headline: draft.headline, headlines: [{ label: '', text: draft.headline }],
            html: breakingMdToHtml(draft.edited), notes: draft.notes, factsToCheck: draft.factsToCheck,
            sourceUrl: story.url || null, autoGenerated: true,
            status: 'draft', createdAt: now, updatedAt: now
          };
          await Drafts.saveDraft(doc);

          var reviewUrl = 'https://ims-tool.vercel.app/editor#3/' + id;
          var recipients = await S.recipientsFor('breaking', 'insidemdsports');
          var mailResult = null;
          if (recipients.length) {
            try {
              mailResult = await mailer.sendMail({
                to: recipients,
                subject: '🚨 Breaking (X/Twitter): ' + draft.headline,
                html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
                  '<p style="color:#b91c1c;font-weight:700">Auto-drafted from a viral X/Twitter post — review before sending.</p>' +
                  '<h2 style="margin:10px 0">' + draft.headline + '</h2>' +
                  doc.html +
                  (draft.factsToCheck.length ? '<p style="margin-top:14px"><b>Verify before publishing:</b></p><ul>' + draft.factsToCheck.map(function(f) { return '<li>' + f + '</li>'; }).join('') + '</ul>' : '') +
                  '<p style="margin-top:16px"><a href="' + reviewUrl + '" style="background:#cf0315;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;">Open in Content Editor</a></p>' +
                  '<p style="color:#888;font-size:11px;margin-top:16px">Source: ' + (story.source || 'unknown') + (story.url ? ' · <a href="' + story.url + '">' + story.url + '</a>' : '') + '</p>' +
                  '</div>'
              });
            } catch (e) { mailResult = { error: e.message }; }
          }

          await Chat.postSystemMessage(sb, {
            senderName: 'IMSTool', kind: 'breaking', tag: 'Breaking News Alert (X)',
            text: draft.headline,
            meta: { headline: draft.headline, sourceUrl: story.url || null, draftId: id, reviewUrl: reviewUrl }
          });

          // Desktop push only for the highest-priority items, and only here
          // (this dedup'd first-time branch) — never a separate unconditional
          // push block, which on a 30-min cron would re-fire on every run a
          // still-fresh rating-5 story stays in the scan window.
          var pushResult = null;
          if ((story.rating || 0) >= 5) {
            try {
              pushResult = await push.sendPush({
                title: '🚨 Breaking Terps News (X/Twitter)',
                body: draft.headline,
                url: 'https://ims-tool.vercel.app/',
                tag: 'breaking-news-x'
              });
            } catch (e) { pushResult = { error: e.message }; }
          }

          results.push({ headline: draft.headline, status: 'drafted', id: id, recipients: recipients.length, mail: mailResult, push: pushResult });
        } catch (e) {
          results.push({ headline: story.headline, status: 'error', error: e.message });
        }
      }
    }

    return res.status(200).json({ success: true, checked: allAlerts.length, drafted: results.filter(function(r) { return r.status === 'drafted'; }).length, results: results });
  } catch (error) {
    console.error('X-scan error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
