// Coverage Desk agent — a scheduled "assistant editor" memo.
//
// Runs on its own each morning (vercel.json cron). Reads this morning's rated
// news + what InsideMDSports has recently published, and emails the publisher a
// short editor's memo: what to cover today, gaps competitors have filled that we
// haven't, developing threads to follow up, yesterday's site and social
// numbers with what to do about them, and an editor's read. Yesterday's numbers
// come from api/_yesterday-analytics.js (Chartbeat snapshots + Buffer); the
// "at a glance" block is rendered straight from that data so its figures are
// exact, and Claude writes the interpretation.
//
// Same shape as roster-check.js: cron -> bounded Claude call -> email.

var mailer = require('./_mailer');
var S = require('./_supabase');

function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function num(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }

// Exact figures, straight from the data (no model in between).
function glanceHtml(y) {
  if (!y || (!y.site && !y.social)) return '';
  var cell = 'padding:4px 10px 4px 0;font-size:13px;';
  var h = '<div style="background:#f5f7fb;border-radius:8px;padding:12px 14px;margin:0 0 14px">' +
    '<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Yesterday at a glance &mdash; ' + esc(y.day) + '</div>';
  var site = y.site;
  if (site && site.readings) {
    h += '<div style="font-weight:600;font-size:13px;margin-top:4px">Site (Chartbeat)</div><table style="border-collapse:collapse">' +
      '<tr><td style="' + cell + '">Average readers on site</td><td style="' + cell + 'font-weight:600">' + num(site.avgReaders) +
      (site.changeVsWeekPct != null ? ' <span style="color:#888;font-weight:400">(' + (site.changeVsWeekPct >= 0 ? '+' : '') + site.changeVsWeekPct + '% vs prior week)</span>' : '') + '</td></tr>' +
      (site.peak ? '<tr><td style="' + cell + '">Peak</td><td style="' + cell + 'font-weight:600">' + num(site.peak.readers) + ' <span style="color:#888;font-weight:400">at ' + esc(site.peak.at) + '</span></td></tr>' : '') +
      '</table>';
    if ((site.topStories || []).length) {
      h += '<ol style="margin:4px 0 0 18px;padding:0;font-size:13px">' + site.topStories.slice(0, 5).map(function (st) {
        return '<li>' + esc(st.title) + ' <span style="color:#888">&mdash; ' + num(st.readers) + ' readers across ' + st.readings + ' reading' + (st.readings === 1 ? '' : 's') +
          (st.socialPostsYesterday === 0 ? ', <b style="color:#b45309">no social posts</b>' : st.socialPostsYesterday ? ', ' + st.socialPostsYesterday + ' social post' + (st.socialPostsYesterday === 1 ? '' : 's') : '') + '</span></li>';
      }).join('') + '</ol>';
    }
  } else if (site && site.note) {
    h += '<div style="font-size:13px;color:#888">Site: ' + esc(site.note) + '</div>';
  }
  var so = y.social;
  if (so) {
    var chans = Object.keys(so.byChannel || {});
    h += '<div style="font-weight:600;font-size:13px;margin-top:10px">Social (Buffer)</div>' +
      '<div style="font-size:13px">' + num(so.postsYesterday) + ' post' + (so.postsYesterday === 1 ? '' : 's') + ' sent' +
      (chans.length ? ': ' + chans.map(function (c) { return esc(c) + ' (' + so.byChannel[c].posts + ')'; }).join(', ') : '') + '.</div>';
    if ((so.topPostsLast7Days || []).length) {
      h += '<div style="font-size:12px;color:#555;margin-top:4px">Best posts of the last 7 days:</div><ol style="margin:2px 0 0 18px;padding:0;font-size:13px">' +
        so.topPostsLast7Days.slice(0, 3).map(function (p) { return '<li>' + esc(String(p.text || '').replace(/https?:\/\/\S+/g, '').trim() || '(link only)') + ' <span style="color:#888">&mdash; ' + esc(p.channel) + ', ' + num(p.interactions) + ' interactions</span></li>'; }).join('') + '</ol>';
    }
    h += '<div style="font-size:11px;color:#888;margin-top:4px">' + esc(so.note) + '</div>';
  }
  return h + '</div>';
}

module.exports = async function handler(req, res) {
  try { await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  try {
    // 1. This morning's rated news (deep-read pass, same as the digest).
    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function (resolve, reject) {
      scanHandler({ body: { deep: true } }, {
        status: function () { return this; },
        json: function (d) { resolve(d); return this; }
      }).catch(reject);
    });
    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);
    var text = (scanResult.content || []).map(function (b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var mm = text.match(/\[[\s\S]*\]/);
    var alerts = mm ? JSON.parse(mm[0]) : [];
    alerts = alerts.filter(function (a) { return a && !a.irrelevant; });

    // 2. What InsideMDSports has published lately (its own headlines).
    var ownIndex = [];
    try { ownIndex = await require('./copyedit.js').relatedArticleIndex(); } catch (e) { /* best effort */ }

    var today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

    // 3. Yesterday's site + social numbers (best effort; the memo goes out either way).
    var yesterday = null;
    if (S.isConfigured()) {
      try {
        var sb = S.admin();
        var site = await sb.from('sites').select('id').eq('slug', 'insidemdsports').single();
        if (site.data) yesterday = await require('./_yesterday-analytics').gatherYesterday(sb, site.data.id);
      } catch (e) { console.error('coverage-desk analytics failed (non-fatal):', e.message); }
    }
    var hasNumbers = !!(yesterday && ((yesterday.site && yesterday.site.readings) || yesterday.social));

    var newsList = alerts
      .sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); })
      .slice(0, 40)
      .map(function (a) { return '- [' + (a.rating || '?') + '/5] ' + a.headline + '  (' + (a.source || '') + ', ' + (a.time || '') + ')' + (a.summary ? ' — ' + a.summary : ''); })
      .join('\n');
    var ownList = ownIndex.slice(0, 25).map(function (a) { return '- ' + a.headline; }).join('\n');

    var prompt =
      'You are the managing editor of InsideMDSports, a University of Maryland Terrapins beat site. It is the morning of ' + today + '. ' +
      'Write a SHORT daily coverage memo to the publisher — the kind an assistant editor leaves on the desk. Plain, direct, skimmable. ' +
      'Use these sections, each 1-4 bullets; skip a section only if there is genuinely nothing real to say.\n\n' +
      "TODAY'S PRIORITIES — the 2-4 stories from the news below worth putting a writer on today, and one clause on why (fresh, major, or ours to own).\n" +
      'GAPS — anything in the news below that matters to Terps readers that InsideMDSports has NOT already covered (compare against the recently-published list). Name the story and, if the source shows it, who already has it.\n' +
      'FOLLOW UPS — developing threads from roughly the last one to two weeks that deserve a check-in: a recruit deciding soon, an injury with no update, a pending decision, a story that said "more to come."\n' +
      (hasNumbers
        ? "WHAT WORKED YESTERDAY — 3-5 bullets reading YESTERDAY'S NUMBERS below (the publisher also sees the raw figures in a box above your memo, so don't just repeat them): what pulled readers on the site and why it likely did (topic, timing, angle), what did or didn't land on social, any top site story that got no social push, and how yesterday compared with the prior week. End with 1-2 concrete actions for today drawn from this (e.g. a follow-up on a story that pulled readers, re-push a strong story on social, post at the hour that worked). Use ONLY the numbers given; never invent figures. If a source is missing or thin, say so in a few words rather than guessing.\n"
        : 'WHAT WORKED — write exactly one line: "No analytics from yesterday yet (connect Chartbeat and Buffer under Analytics)." Do not invent numbers or name a top story.\n') +
      "EDITOR'S READ — one or two sentences: an honest take on where the beat is right now and the single thing you would focus on today.\n\n" +
      "TODAY'S RATED NEWS:\n" + (newsList || '(nothing notable in the scan)') + '\n\n' +
      'RECENTLY PUBLISHED BY INSIDEMDSPORTS:\n' + (ownList || '(unavailable this run)') + '\n\n' +
      (hasNumbers ? "YESTERDAY'S NUMBERS (" + yesterday.day + ', Eastern; site readers are summed from readings every 3 hours, a ranking rather than exact pageviews):\n' + JSON.stringify({ site: yesterday.site, social: yesterday.social, errors: yesterday.errors }) + '\n\n' : '') +
      'Return ONLY clean HTML: <h3> for each section header, <ul><li> for bullets, <p> for the read. No preamble, no markdown fences.';

    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2200, messages: [{ role: 'user', content: prompt }] })
    });
    var cd = await cr.json();
    if (cd.error) throw new Error('Claude error: ' + JSON.stringify(cd.error));
    var memo = (cd.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).join('\n').replace(/```html|```/g, '').trim();
    if (!memo) throw new Error('Empty memo from Claude.');

    var html =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a">' +
      '<div style="background:#0f1b2d;padding:12px 16px;border-radius:8px 8px 0 0"><span style="color:#fff;font-weight:700">Coverage Desk &mdash; ' + today + '</span></div>' +
      '<div style="background:#fff;border:1px solid #e8e6e1;border-top:none;border-radius:0 0 8px 8px;padding:18px;font-size:14px;line-height:1.55">' +
      glanceHtml(yesterday) +
      memo +
      '<p style="color:#888;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:10px">Auto-generated from this morning’s scan of ' + alerts.length + ' rated stories. A starting point &mdash; review before assigning.</p>' +
      '</div></div>';

    var mailResult = await mailer.sendMail({ subject: 'Coverage Desk — ' + today, html: html });

    console.log('Coverage Desk sent | alerts:', alerts.length, '| own index:', ownIndex.length, '| analytics:', hasNumbers, '| mail:', JSON.stringify(mailResult));
    return res.status(200).json({ ok: true, alerts: alerts.length, ownIndex: ownIndex.length, analytics: hasNumbers ? { site: !!(yesterday.site && yesterday.site.readings), social: !!yesterday.social, errors: yesterday.errors } : null, mail: mailResult });
  } catch (e) {
    console.error('coverage-desk error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
