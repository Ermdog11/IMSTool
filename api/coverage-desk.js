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
var SOURCE_NAMES = { search: 'Search (Google etc.)', social: 'Social', links: 'Other sites', direct: 'Direct', internal: 'Within the site', ai: 'AI tools', email: 'Email', newsletter: 'Newsletter' };
function num(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }

// Exact figures, straight from the data (no model in between).
function glanceHtml(y) {
  if (!y || (!y.site && !y.social && !y.x && !y.search)) return '';
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
    if ((site.trafficSources || []).length) {
      h += '<div style="font-size:13px;margin-top:4px">Where readers came from: ' + site.trafficSources.filter(function (s) { return s.sharePct >= 1; }).map(function (s) {
        return esc(SOURCE_NAMES[s.source] || s.source) + ' ' + s.sharePct + '%' + (s.priorWeekSharePct != null ? ' <span style="color:#888">(' + s.priorWeekSharePct + '% prior week)</span>' : '');
      }).join(', ') + '</div>';
    }
    if ((site.topStories || []).length) {
      h += '<ol style="margin:4px 0 0 18px;padding:0;font-size:13px">' + site.topStories.slice(0, 5).map(function (st) {
        // Chartbeat paths carry the host ("site.com/a/b"), so they link straight to the story.
        var storyUrl = /^https?:\/\//i.test(st.path || '') ? st.path : /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(st.path || '') ? 'https://' + st.path : '';
        return '<li>' + (storyUrl ? '<a href="' + esc(storyUrl) + '" style="color:#2563eb">' + esc(st.title) + '</a>' : esc(st.title)) + ' <span style="color:#888">&mdash; ' + num(st.readers) + ' readers across ' + st.readings + ' reading' + (st.readings === 1 ? '' : 's') +
          (st.fromSearch || st.fromSocial ? ', ' + num(st.fromSearch || 0) + ' from search, ' + num(st.fromSocial || 0) + ' from social' : '') +
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
        so.topPostsLast7Days.slice(0, 3).map(function (p) {
          var label = esc(String(p.text || '').replace(/https?:\/\/\S+/g, '').trim() || '(link only)');
          // Links to the post itself on the social network (Buffer's externalLink).
          return '<li>' + (p.postUrl ? '<a href="' + esc(p.postUrl) + '" style="color:#2563eb">' + label + '</a>' : label) +
            ' <span style="color:#888">&mdash; ' + esc(p.channel) + ', ' + num(p.interactions) + ' interactions</span></li>';
        }).join('') + '</ol>';
    }
    h += '<div style="font-size:11px;color:#888;margin-top:4px">' + esc(so.note) + '</div>';
  }
  var gs = y.search;
  if (gs && gs.web) {
    h += '<div style="font-weight:600;font-size:13px;margin-top:10px">Google (Search Console)</div>' +
      '<div style="font-size:13px">Search: ' + num(gs.web.clicks) + ' clicks from ' + num(gs.web.impressions) + ' impressions' +
      (gs.discover && gs.discover.clicks ? ' · Discover: ' + num(gs.discover.clicks) + ' clicks' : '') +
      (gs.googleNews && gs.googleNews.clicks ? ' · Google News: ' + num(gs.googleNews.clicks) + ' clicks' : '') + '</div>';
    if ((gs.topQueries || []).length) {
      h += '<div style="font-size:12px;color:#555;margin-top:4px">Top searches: ' + gs.topQueries.slice(0, 5).map(function (q) { return esc(q.query) + ' (' + num(q.clicks) + ')'; }).join(', ') + '</div>';
    }
    h += '<div style="font-size:11px;color:#888;margin-top:4px">' + esc(gs.note) + '</div>';
  }
  var xx = y.x;
  if (xx && xx.totals) {
    h += '<div style="font-weight:600;font-size:13px;margin-top:10px">X ' + esc(xx.handle || '') + '</div>' +
      '<div style="font-size:13px">' + num(xx.totals.tweets) + ' tweet' + (xx.totals.tweets === 1 ? '' : 's') + ', ' + num(xx.totals.impressions) + ' impressions, ' + num(xx.totals.interactions) + ' interactions' +
      (xx.avgImpressionsPerTweetLast7Days != null ? ' <span style="color:#888">(7-day average ' + num(xx.avgImpressionsPerTweetLast7Days) + ' impressions per tweet)</span>' : '') + '.</div>';
    if ((xx.topTweets || []).length) {
      h += '<ol style="margin:4px 0 0 18px;padding:0;font-size:13px">' + xx.topTweets.slice(0, 3).map(function (t) {
        return '<li><a href="' + esc(t.url) + '" style="color:#2563eb">' + esc(String(t.text).replace(/https?:\/\/\S+/g, '').trim() || '(link only)') + '</a> <span style="color:#888">&mdash; ' + num(t.impressions) + ' impressions, ' + num(t.interactions) + ' interactions</span></li>';
      }).join('') + '</ol>';
    }
    h += '<div style="font-size:11px;color:#888;margin-top:4px">' + esc(xx.note) + '</div>';
  } else if (xx && xx.note) {
    h += '<div style="font-size:13px;color:#888;margin-top:10px">X: ' + esc(xx.note) + '</div>';
  }
  return h + '</div>';
}

// "📅 Today on the calendar" box at the top of the memo.
function calendarHtml(list) {
  if (!list || !list.length) return '';
  var Cal = require('./_calendar');
  return '<div style="border:1px solid #cfe0f5;background:#f3f8fe;border-radius:8px;padding:10px 14px;margin-bottom:16px">' +
    '<div style="font-size:12px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">📅 Today on the calendar</div>' +
    list.map(function (e) {
      return '<div style="font-size:13px;padding:3px 0"><b>' + esc(Cal.timeOf(e)) + '</b> &nbsp;' + esc(e.title) +
        (e.location ? ' <span style="color:#666">· ' + esc(e.location) + '</span>' : '') +
        (e.note ? '<div style="font-size:12px;color:#555;margin-left:2px">' + esc(e.note) + '</div>' : '') + '</div>';
    }).join('') +
    '<div style="font-size:11px;margin-top:6px"><a href="https://ims-tool.vercel.app/calendar" style="color:#2563eb">Open the calendar</a></div></div>';
}

module.exports = async function handler(req, res) {
  var who;
  try { who = await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  // Vercel Cron can deliver a run twice; only the first sends (see _cron-once.js).
  if (who && who.cron && !(await require('./_cron-once').claim('coverage-desk', require('./_cron-once').today()))) {
    return res.status(200).json({ skipped: 'duplicate cron delivery' });
  }
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
        var site = await sb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
        if (site.data) yesterday = await require('./_yesterday-analytics').gatherYesterday(sb, site.data.id);
      } catch (e) { console.error('coverage-desk analytics failed (non-fatal):', e.message); }
    }
    var hasNumbers = !!(yesterday && ((yesterday.site && yesterday.site.readings) || yesterday.social || (yesterday.x && yesterday.x.totals) || yesterday.search));

    var newsList = alerts
      .sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); })
      .slice(0, 40)
      .map(function (a) { return '- [' + (a.rating || '?') + '/5] ' + a.headline + '  (' + (a.source || '') + ', ' + (a.time || '') + ')' + (a.summary ? ' — ' + a.summary : ''); })
      .join('\n');
    var ownList = ownIndex.slice(0, 25).map(function (a) { return '- ' + a.headline; }).join('\n');

    // This week's hot spots (best times to publish; filled in now if the
    // Monday cron hasn't run). Today's show in the calendar box; all of the
    // week's remaining ones go to the memo's WHEN TO PUBLISH section.
    var heatList = '';
    if (S.isConfigured()) {
      try {
        var hsb = S.admin();
        var hsite = await hsb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
        if (hsite.data) {
          var heat = await require('./_calendar').ensureHeatSpots(hsb, hsite.data.id, false);
          var nowMs = Date.now();
          // Only spots far enough ahead to act on (the memo lands at 7 AM;
          // a 7 or 8 AM spot is too soon to plan for from it).
          heatList = (heat.spots || []).filter(function (e) { return Date.parse(e.start) > nowMs + 90 * 60000; })
            .sort(function (a, b) { return (a.heatRank || 9) - (b.heatRank || 9); })
            .map(function (e) {
              return '- #' + e.heatRank + ' ' + new Date(e.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit' }) + (e.note ? ' — ' + e.note : '');
            }).join('\n');
          if (!heatList && heat.note) heatList = '(' + heat.note + ')';
        }
      } catch (e) { console.error('Coverage Desk: hot spots failed (non-fatal):', e.message); }
    }

    // AI-assisted calendar: add the dated, upcoming items in today's news first,
    // so anything happening today shows in the box below.
    try {
      var CalM = require('./_calendar');
      if (CalM.mode(await CalM.load()) === 'ai') {
        var noticed = await require('./_ai-calendar').addFromNews(alerts);
        if (noticed.length) console.log('Coverage Desk: AI calendar added', noticed.length);
      }
    } catch (e) { console.error('Coverage Desk: AI calendar failed (non-fatal):', e.message); }

    // Ombudsman: daily quality review of our last 3 days of articles (best-effort).
    var ombReview = null;
    try { ombReview = await require('./_ombudsman.js').review({}); } catch (e) { console.error('Coverage Desk: ombudsman review failed (non-fatal):', e.message); }
    // Writer leaderboard kudos (last 7 days): in the memo, and in Team Chat
    // when the publisher has shared the leaderboard with any role.
    var kudosLines = [];
    try {
      if (S.isConfigured()) {
        var ksb = S.admin();
        var ksite = await ksb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
        if (ksite.data) {
          var WS = require('./_writer-stats');
          kudosLines = WS.kudos(await WS.get(ksb, ksite.data.id, 7, true));
          var prof = await require('./_settings-store').getProfile(ksb);
          var acc = (prof && prof.editorAccess) || {};
          var shared = ['editor', 'writer', 'contributor', 'viewer'].some(function (r) { return acc[r] && acc[r].mon_leaderboard === true; });
          if (shared && kudosLines.length) {
            await require('./_chat-store').postSystemMessage(ksb, { senderName: 'CoPublisher AI', kind: 'system', text: 'Kudos this week: ' + kudosLines.join(' ') + ' (Leaderboard)' });
          }
        }
      }
    } catch (e) { console.error('Coverage Desk: kudos failed (non-fatal):', e.message); }

    // Today's calendar: shown at the top of the email and given to the memo.
    var todayEvents = [];
    try { todayEvents = await require('./_calendar').eventsOn(); } catch (e) { console.error('Coverage Desk: calendar failed (non-fatal):', e.message); }
    var Cal = require('./_calendar');
    var calList = todayEvents.map(function (e) { return '- ' + Cal.timeOf(e) + ': ' + e.title + (e.location ? ' (' + e.location + ')' : '') + (e.note ? ' — ' + e.note : ''); }).join('\n');

    var prompt =
      'You are the managing editor of InsideMDSports, a University of Maryland Terrapins beat site. It is the morning of ' + today + '. ' +
      'Write a SHORT daily coverage memo to the publisher — the kind an assistant editor leaves on the desk. Plain, direct, skimmable. ' +
      'Use these sections, each 1-4 bullets; skip a section only if there is genuinely nothing real to say.\n\n' +
      "TODAY'S PRIORITIES — the 2-4 stories from the news below worth putting a writer on today, and one clause on why (fresh, major, or ours to own).\n" +
      'GAPS — anything in the news below that matters to Terps readers that InsideMDSports has NOT already covered (compare against the recently-published list). Name the story and, if the source shows it, who already has it.\n' +
      'FOLLOW UPS — developing threads from roughly the last one to two weeks that deserve a check-in: a recruit deciding soon, an injury with no update, a pending decision, a story that said "more to come."\n' +
      (hasNumbers
        ? "WHAT WORKED YESTERDAY — 3-5 bullets reading YESTERDAY'S NUMBERS below (the publisher also sees the raw figures in a box above your memo, so don't just repeat them): what pulled readers on the site and why it likely did (topic, timing, angle), what did or didn't land on social (Buffer posts and the X account's own tweets), any top site story that got no social push, and how yesterday compared with the prior week, where readers came from (search vs social vs direct, and any shift vs the prior week), and what people searched on Google to find us (Search Console; preliminary numbers). End with 1-2 concrete actions for today drawn from this (e.g. a follow-up on a story that pulled readers, re-push a strong story on social, post at the hour that worked). Use ONLY the numbers given; never invent figures. If a source is missing or thin, say so in a few words rather than guessing.\n"
        : 'WHAT WORKED — write exactly one line: "No analytics from yesterday yet (connect Chartbeat and Buffer under Analytics)." Do not invent numbers or name a top story.\n') +
      (calList ? "TODAY'S CALENDAR is shown to the publisher in its own box above your memo; don't list it again, but factor it into TODAY'S PRIORITIES (who covers a game, presser or deadline today).\n" : '') +
      (heatList ? "WHEN TO PUBLISH — two or three sentences on this week's hot spots (the best times to publish, ranked from our own last 4 weeks of site readers and social engagement, listed below): name today's if any and what story from TODAY'S PRIORITIES to hold for it, then the best ones still ahead this week in order. If tomorrow has one before 10 AM, say to have a story written and scheduled before the end of today, since there won't be time in the morning. Use only the reasons given; don't invent numbers. If the list says there isn't enough history yet, say that in one line.\n" : '') +
      "EDITOR'S READ — one or two sentences: an honest take on where the beat is right now and the single thing you would focus on today.\n\n" +
      "TODAY'S RATED NEWS:\n" + (newsList || '(nothing notable in the scan)') + '\n\n' +
      (calList ? "TODAY'S CALENDAR:\n" + calList + '\n\n' : '') +
      (heatList ? "THIS WEEK'S HOT SPOTS (ranked):\n" + heatList + '\n\n' : '') +
      'RECENTLY PUBLISHED BY INSIDEMDSPORTS:\n' + (ownList || '(unavailable this run)') + '\n\n' +
      (hasNumbers ? "YESTERDAY'S NUMBERS (" + yesterday.day + ', Eastern; site readers are summed from readings every 3 hours, a ranking rather than exact pageviews):\n' + JSON.stringify({ site: yesterday.site, social: yesterday.social, x: yesterday.x, googleSearch: yesterday.search, errors: yesterday.errors }) + '\n\n' : '') +
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
      calendarHtml(todayEvents) +
      require('./_ombudsman.js').reviewHtml(ombReview) +
      (kudosLines.length ? '<div style="border:1px solid #fde68a;background:#fffbeb;border-radius:8px;padding:10px 14px;margin-bottom:16px"><div style="font-size:12px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">🏆 Writer kudos · last 7 days</div>' + kudosLines.map(function (k) { return '<div style="font-size:13px;padding:2px 0">' + esc(k) + '</div>'; }).join('') + '<div style="font-size:11px;margin-top:4px"><a href="https://ims-tool.vercel.app/leaderboard" style="color:#2563eb">Full leaderboard</a></div></div>' : '') +
      glanceHtml(yesterday) +
      memo +
      '<p style="color:#888;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:10px">Auto-generated from this morning’s scan of ' + alerts.length + ' rated stories. A starting point &mdash; review before assigning.</p>' +
      '</div></div>';

    var mailResult = await mailer.sendMail({ alertType: 'coverage_desk', subject: 'Coverage Desk — ' + today, html: html });

    console.log('Coverage Desk sent | alerts:', alerts.length, '| own index:', ownIndex.length, '| analytics:', hasNumbers, '| calendar:', todayEvents.length, '| heat:', heatList ? heatList.split('\n').length : 0, '| mail:', JSON.stringify(mailResult));
    return res.status(200).json({ ok: true, alerts: alerts.length, ownIndex: ownIndex.length, analytics: hasNumbers ? { site: !!(yesterday.site && yesterday.site.readings), social: !!yesterday.social, x: !!(yesterday.x && yesterday.x.totals), errors: yesterday.errors } : null, mail: mailResult });
  } catch (e) {
    console.error('coverage-desk error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
