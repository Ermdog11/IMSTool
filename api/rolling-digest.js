const mailer = require('./_mailer.js');
const push = require('./_push.js');
const S = require('./_supabase.js');
const Drafts = require('./_drafts.js');
const Chat = require('./_chat-store.js');
const BreakingDraft = require('./_breaking-draft.js');
const ArticleDate = require('./_article-date.js');
const Corroborate = require('./_corroborate.js');
const Settings = require('./_settings-store.js');

// Same minimal Markdown->HTML used by api/submit-article.js — the auto-draft
// needs to land in the same doc.html shape the Drafts tab / Content Editor
// already know how to render.
function breakingMdToHtml(t) {
  var s = String(t || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="text-decoration:underline;text-underline-offset:2px">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s.split(/\n\s*\n/).map(function(p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).filter(Boolean).join('\n');
}

// A manual ?slot= run and the newsroom-wide auto-drafts: how many hours back
// to look (gap since the previous send in the 8am/12pm/5pm ET schedule, plus buffer)
var WINDOW_HOURS = {
  morning: 16,  // since last night's 5pm send
  midday: 5,    // since this morning's 8am send
  evening: 6    // since today's noon send
};

// The hour (0-23) in tz at ms.
function localHour(ms, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))) % 24;
}

// Eastern hours that run the newsroom-wide work (auto-drafts, push).
var DESK_SLOTS = { 8: 'morning', 12: 'midday', 17: 'evening' };

var SLOT_LABEL = {
  morning: 'morning',
  midday: 'midday',
  evening: 'evening'
};

// Never auto-draft a story whose own page says it was published longer ago than this.
var DRAFT_MAX_AGE_HOURS = 48;

// Cap each digest at this many of the most recent items
var MAX_ITEMS = 20;

// Sport sub-group order within each day. "Minor sports" (volleyball, tennis, golf,
// cross country, wrestling, softball, field hockey, swimming) always sits last.
var GROUP_ORDER = ['Recruiting', 'Football', 'Basketball', 'Other sports', 'Alumni', 'Social & podcasts', 'Minor sports'];

// Parse a relative "time" string ("2h ago", "3 days ago", "just now") into hours-ago
function hoursAgo(t) {
  t = (t || '').toLowerCase();
  var m = t.match(/(\d+)/);
  var n = m ? parseInt(m[1], 10) : 0;
  if (/month/.test(t)) return n * 720;
  if (/week/.test(t)) return n * 168;
  if (/day/.test(t)) return n * 24;
  if (/(min|just now|moment)/.test(t)) return 0;
  return n; // hours
}

// Calendar-day label for an item, derived from its relative time
function dayKey(t) {
  var d = new Date(Date.now() - hoursAgo(t) * 3600000);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Which sport sub-group an item belongs to (single group, no duplicates)
function groupOf(a) {
  if (a.lowPriority) return 'Minor sports';
  if (a.category === 'recruiting') return 'Recruiting';
  if (a.category === 'alumni') return 'Alumni';
  if (['social', 'podcast'].indexOf(a.category) !== -1) return 'Social & podcasts';
  if (a.sport === 'football') return 'Football';
  if (['basketball', 'mens-basketball', 'womens-basketball'].indexOf(a.sport || '') !== -1) return 'Basketball';
  return 'Other sports';
}

function ratingStars(r) {
  r = r || 0;
  var s = '';
  for (var i = 0; i < 5; i++) s += (i < r) ? '★' : '☆';
  return s;
}

function itemHTML(item, overflowByTopic) {
  var label = (item.kind === 'video' ? '📺 ' : '') + item.headline;
  var headline = item.url
    ? '<a href="' + item.url + '" style="color:#1a1a1a;text-decoration:none;">' + label + '</a>'
    : label;
  var html = '<div style="padding:10px 0;border-bottom:1px solid #e8e6e1;">';
  html += '<div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">' + headline + '</div>';
  if (item.summary) html += '<div style="font-size:12px;color:#555;line-height:1.5;">' + item.summary + '</div>';
  html += '<div style="font-size:11px;color:#888;margin-top:4px;">' +
    '<span style="color:#e0a800;letter-spacing:1px;">' + ratingStars(item.rating) + '</span> &middot; ' +
    item.source + ' &middot; ' + item.time + '</div>';
  html += require('./_story-ratings').emailLinks(item);

  // "More on this" — extra stories about the same person/topic that were held out of the feed
  var extras = (item.trendingTopic && overflowByTopic && overflowByTopic[item.trendingTopic]) || [];
  if (extras.length) {
    html += '<div style="font-size:11px;color:#888;margin-top:5px;">More on ' + item.trendingTopic + ': ' +
      extras.slice(0, 5).map(function(x) {
        return x.url
          ? '<a href="' + x.url + '" style="color:#888;text-decoration:underline;">' + x.title + '</a>'
          : x.title;
      }).join(' &nbsp;&middot;&nbsp; ') +
      '</div>';
  }

  html += '</div>';
  return html;
}

// "📄 Suggested records requests" at the top of the update email: each new
// suggestion from the records-suggest cron goes in the next update that's
// sent (Jeff, 2026-10-06: "include this information in the email that day,
// or the next if it's been sent").
function recordsHTML(list) {
  if (!list || !list.length) return '';
  var e = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  return '<div style="margin-bottom:22px;border:1px solid #f0d78a;background:#fffbeb;border-radius:8px;padding:12px 14px;">' +
    '<div style="font-size:12px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">📄 Public records requests to review (' + list.length + ')</div>' +
    list.map(function (s) {
      var d = s.draft || {};
      var mailto = d.to ? 'mailto:' + encodeURIComponent(d.to) + '?subject=' + encodeURIComponent(d.subject || '') + '&body=' + encodeURIComponent(d.body || '') : '';
      return '<div style="padding:8px 0;border-top:1px solid #f3e6bd;">' +
        '<div style="font-size:14px;font-weight:600;">' + (s.url ? '<a href="' + e(s.url) + '" style="color:#1a1a1a;text-decoration:none;">' + e(s.headline) + '</a>' : e(s.headline)) + '</div>' +
        '<div style="font-size:12px;color:#555;line-height:1.5;margin-top:2px;">' + e(d.reason) + '</div>' +
        '<div style="font-size:12px;color:#555;margin-top:3px;"><b>To:</b> ' + (d.agency ? e(d.agency) + ' · ' : '') + (d.to ? e(d.to) : d.toUnconfirmed ? e(d.toUnconfirmed) + ' (check it)' : 'no published email') + '</div>' +
        '<div style="font-size:12px;margin-top:5px;">' + (mailto ? '<a href="' + mailto + '" style="color:#2563eb;margin-right:12px;">Send it from my email</a>' : '') + '<a href="https://ims-tool.vercel.app/alerts#records" style="color:#2563eb;">Have CoPublisher send it for me</a></div>' +
      '</div>';
    }).join('') + '</div>';
}

// Evening update: tomorrow's early hot spots (before 11 AM Eastern), so a
// story can be ready the night before; the morning memo comes too late for them.
async function earlyHotSpotsHtml() {
  try {
    var Cal = require('./_calendar');
    var data = await Cal.load();
    if (!Cal.heatOn(data)) return '';
    var tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    var early = (data.events || []).filter(function (e) {
      if (e.kind !== 'heat') return false;
      var d = new Date(e.start);
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === tomorrow &&
        Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(d)) % 24 < 11;
    });
    if (!early.length) return '';
    return '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px 14px;margin:0 0 16px;font-size:14px;color:#7c2d12">' +
      '<b>🔥 Tomorrow morning\'s hot spot' + (early.length > 1 ? 's' : '') + ':</b> ' + early.map(function (e) {
        return new Date(e.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + (e.note ? ' (' + String(e.note).replace(/[<>&]/g, '') + ')' : '');
      }).join('; ') + '. That\'s before the morning memo, so have a story written and scheduled tonight.</div>';
  } catch (e) { return ''; }
}

function buildEmailHTML(alerts, date, slot, overflowByTopic, recordsList, ideas, hotSpotsHtml, heldHtml) {
  // Group by calendar day
  var days = {};
  alerts.forEach(function(a) {
    var k = dayKey(a.time);
    if (!days[k]) days[k] = { hrs: 0, items: [] };
    days[k].items.push(a);
    if (hoursAgo(a.time) > days[k].hrs) days[k].hrs = hoursAgo(a.time);
  });
  // Days in chronological order (oldest first)
  var dayKeys = Object.keys(days).sort(function(x, y) { return days[y].hrs - days[x].hrs; });

  var body = '';
  dayKeys.forEach(function(dk) {
    var dayItems = days[dk].items;
    var daySections = '';
    GROUP_ORDER.forEach(function(title) {
      var items = dayItems.filter(function(a) { return groupOf(a) === title; });
      if (!items.length) return;
      // Highest-rated first, then most recent
      items.sort(function(a, b) {
        return (b.rating || 0) - (a.rating || 0) || hoursAgo(a.time) - hoursAgo(b.time);
      });
      daySections += '<div style="margin-bottom:18px;">';
      daySections += '<div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;border-bottom:2px solid #2563eb;padding-bottom:5px;">' + title + '</div>';
      items.forEach(function(item) { daySections += itemHTML(item, overflowByTopic); });
      daySections += '</div>';
    });
    body += '<div style="margin-bottom:26px;">';
    body += '<div style="font-size:15px;font-weight:800;color:#1a1a1a;margin-bottom:12px;">' + dk + '</div>';
    body += daySections;
    body += '</div>';
  });

  body = (heldHtml || '') + (hotSpotsHtml || '') + recordsHTML(recordsList) + body + require('./_ombudsman.js').emailHtml(ideas);
  var bodyMsg = alerts.length
    ? '<p style="font-size:13px;color:#555;margin-bottom:20px;">' + alerts.length + ' new ' + (alerts.length === 1 ? 'story' : 'stories') + ' since your last update.</p>' + body
    : '<p style="font-size:13px;color:#555;margin-bottom:20px;">Nothing new on the beat since your last update.</p>' + body;

  return '<!DOCTYPE html><html><head></head><body style="font-family:-apple-system,sans-serif;background:#f7f6f3;margin:0;padding:20px;">' +
    '<div style="max-width:600px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;">' +
    '<div style="background:#0f1b2d;padding:16px 20px;">' +
    '<div style="color:white;font-size:16px;font-weight:700;">InsideMDSports</div>' +
    '<div style="color:rgba(255,255,255,0.8);font-size:12px;">' + SLOT_LABEL[slot] + ' update &mdash; ' + date + '</div>' +
    '</div>' +
    '<div style="padding:20px 24px;">' +
    bodyMsg +
    '</div>' +
    '<div style="background:#1a1a1a;padding:12px 20px;text-align:center;">' +
    '<a href="https://247sports.com/college/maryland/" style="color:#ffd520;font-size:12px;font-weight:600;text-decoration:none;">Open InsideMDSports &rarr;</a>' +
    '</div></div></body></html>';
}

module.exports = async function handler(req, res) {
  var who;
  try { who = await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });
  }

  // Each person's updates come at their own times (Jeff, 2026-10-07: "three
  // different time slots ... option to only receive 1 or 2 daily"; set on
  // Permissions & preferences, _alert-schedule.js timesOf). The cron runs
  // hourly; each run emails the people whose time it is, each covering
  // everything since the last digest email they got (an earlier update, or
  // last night's digest: "the a.m. digest needs to include what's new since
  // the p.m. digest"). Default times: 8 AM, noon, 5 PM in their zone.
  // ?slot=morning|midday|evening (a manual run) still sends everyone one.
  var Sched = require('./_alert-schedule');
  var nowMs = Date.now();
  var slotParam = req.query && req.query.slot;
  if (slotParam && !WINDOW_HOURS[slotParam]) slotParam = 'morning';
  // The newsroom-wide work after the emails (breaking auto-drafts, push)
  // keeps the old 8 AM / noon / 5 PM Eastern rhythm, whoever is due.
  var deskSlot = slotParam || DESK_SLOTS[localHour(nowMs, Sched.DEFAULT_TZ)] || null;
  var groups;
  if (slotParam) {
    groups = [{ to: null, windowHours: WINDOW_HOURS[slotParam], slot: slotParam }];
  } else {
    var base = await mailer.baseRecipients('digest_rolling');
    var schedAll = await Sched.load();
    var nightlyOff = await Sched.switchedOff('digest_nightly');
    var byKey = {};
    base.forEach(function(e) {
      var k = String(e).toLowerCase(), mine = schedAll[k] || {};
      if (!Sched.dueNow(mine, 'digest_rolling', nowMs)) return;
      var h = Sched.hoursSinceLast(mine, nowMs, !nightlyOff[k]);
      var lh = localHour(nowMs, Sched.tzFor(mine, 'digest_rolling'));
      var slot = lh < 11 ? 'morning' : lh < 15 ? 'midday' : 'evening';
      var g = byKey[h + '|' + slot] = byKey[h + '|' + slot] || { to: [], windowHours: h + 1, slot: slot };
      g.to.push(e);
    });
    groups = Object.keys(byKey).map(function(k) { return byKey[k]; });
    // Alerts that came in someone's off hours ride in their own copy of the
    // update, at the top ("While you were off"; _held-alerts.js).
    var Held = require('./_held-alerts');
    var held = {};
    try { held = await Held.peek([].concat.apply([], groups.map(function(g) { return g.to; }))); } catch (e) { held = {}; }
    if (Object.keys(held).length) {
      var solo = [];
      groups.forEach(function(g) {
        g.to = g.to.filter(function(e) {
          var k = String(e).toLowerCase();
          if (!held[k]) return true;
          solo.push({ to: [e], windowHours: g.windowHours, slot: g.slot, held: held[k], tz: Sched.tzOf(schedAll[k]) });
          return false;
        });
      });
      groups = groups.filter(function(g) { return g.to.length; }).concat(solo);
    }
    if (!groups.length && !deskSlot) return res.status(200).json({ skipped: 'no one\'s update is due this hour' });
  }
  // Vercel Cron can deliver a run twice; only the first sends (see _cron-once.js).
  var Once = require('./_cron-once');
  if (who && who.cron && !(await Once.claim('rolling-digest-' + (slotParam || 'h' + new Date(nowMs).toISOString().slice(11, 13)), Once.today()))) {
    return res.status(200).json({ skipped: 'duplicate cron delivery' });
  }

  try {
    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function(resolve, reject) {
      var fakeRes = {
        status: function() { return this; },
        json: function(d) { resolve(d); return this; }
      };
      // The paid web and Google searches stay at the three newsroom times
      // (_web-search.js, _google-search.js budgets); other hours use the regular scan.
      scanHandler({ body: deskSlot ? { deep: true, webSearch: true, googleSearch: true } : {} }, fakeRes).catch(reject);
    });

    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);
    var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from scan');

    var allAlerts = JSON.parse(match[0]).filter(function(a) { return !a.republished; });

    // Only stories newer than the window (since that person's last email).
    // The story's real age (from its feed, search result or page) when scan.js
    // knows it; the rater's "time" text otherwise. Capped at the most recent MAX_ITEMS.
    function windowed(windowHours) {
      var list = allAlerts.filter(function(a) { return (a.ageHours != null ? a.ageHours : hoursAgo(a.time)) <= windowHours; });
      list.sort(function(a, b) { return hoursAgo(a.time) - hoursAgo(b.time); });
      return list.slice(0, MAX_ITEMS);
    }
    // Held-out "More on this" stories (same person/topic), grouped by topic
    function overflowFor(windowHours) {
      var out = {};
      (scanResult.overflow || []).forEach(function(s) {
        if (!s.trendingTopic || (s.age || 0) > windowHours) return;
        (out[s.trendingTopic] = out[s.trendingTopic] || []).push(s);
      });
      return out;
    }

    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    // Ombudsman: five story ideas at the bottom of every update (best-effort).
    var ideas = [];
    if (groups.length) {
      try { ideas = await require('./_ombudsman.js').suggest(allAlerts, { slot: deskSlot || groups[0].slot }); } catch (e) { console.error('Ombudsman ideas failed (non-fatal):', e.message); }
    }

    var recordsList = [];
    if (groups.length) {
      try { recordsList = await require('./_records.js').pendingForDigest(require('./_site').slug()); } catch (e) { console.error('Records for digest failed (non-fatal):', e.message); }
    }
    var mailResult = [], anySent = false;
    var hotSpots = null;
    for (var gi = 0; gi < groups.length; gi++) {
      var grp = groups[gi], list = windowed(grp.windowHours);
      if (grp.slot === 'evening' && hotSpots === null) hotSpots = await earlyHotSpotsHtml();
      try {
        var sent = await mailer.sendMail({
          to: grp.to || undefined,
          alertType: 'digest_rolling',
          subject: list.length
            ? 'InsideMDSports ' + SLOT_LABEL[grp.slot] + ' update — ' + list.length + ' new ' + (list.length === 1 ? 'story' : 'stories')
            : 'InsideMDSports ' + SLOT_LABEL[grp.slot] + ' update — nothing new',
          html: buildEmailHTML(list, date, grp.slot, overflowFor(grp.windowHours), recordsList, ideas, grp.slot === 'evening' ? hotSpots : '', grp.held ? require('./_held-alerts').html(grp.held, grp.tz) : '')
        });
        if (grp.held && sent && !sent.error && !sent.skipped) {
          await require('./_held-alerts').clear(grp.to[0], grp.held[grp.held.length - 1].at);
        }
        mailResult.push({ slot: grp.slot, windowHours: grp.windowHours, count: list.length, mail: sent });
        if (sent && !sent.error && !sent.skipped) anySent = true;
      } catch (e) { mailResult.push({ slot: grp.slot, error: e.message }); }
    }
    if (recordsList.length && anySent) {
      try { await require('./_records.js').markInDigest(require('./_site').slug(), recordsList.map(function(x) { return x.id; })); } catch (e) { console.error('Records digest mark failed:', e.message); }
    }

    var slot = deskSlot;
    var alerts = deskSlot ? windowed(WINDOW_HOURS[deskSlot]) : [];

    // Auto-draft a ready-to-review article for each NEW rating-4+ story (never
    // re-draft one still sitting in the window on a later run this slot),
    // email it to whoever has 'breaking' alerts on, and drop it in Team Chat
    // tagged so the whole newsroom sees it, not just the recipients. Lower
    // bar than the push notification above (which stays at 5, "drop what
    // you're doing") — Jeff wants rating-4 covered too (2026-09-13), both
    // because 4s are real news worth a head start on and because 5s alone
    // are too rare to exercise/verify this pipeline regularly.
    var draftEligible = alerts.filter(function(a) { return (a.rating || 0) >= 4; });
    var breakingDrafts = [];
    // Two-source check results by story URL (see _corroborate.js): labels the
    // push below, and stories it shows are old news are never pushed.
    var checkedByUrl = {};
    var notBreaking = {};
    var checkPool = allAlerts.concat(scanResult.overflow || []);
    if (draftEligible.length && S.isConfigured()) {
      var sb = S.admin();
      var houseStyle = await Settings.getHouseStyle(sb);
      for (var bi = 0; bi < draftEligible.length; bi++) {
        var story = draftEligible[bi];
        try {
          if (story.url && await Drafts.findBySourceUrl(story.url)) {
            breakingDrafts.push({ headline: story.headline, status: 'already-drafted' });
            continue;
          }

          // Last check before anything goes out as breaking: if the article's
          // own page says it was published days ago, it isn't breaking news,
          // whatever date the feed or search result gave it. And with no date
          // anywhere (not the feed, the search result or the page), it stays
          // in the digest but isn't drafted: we can't vouch that it's new.
          var publishedAt = await ArticleDate.publishedMs(story.url);
          if (!isNaN(publishedAt) && Date.now() - publishedAt > DRAFT_MAX_AGE_HOURS * 3600000) {
            breakingDrafts.push({ headline: story.headline, status: 'skipped-old', publishedAt: new Date(publishedAt).toISOString() });
            if (story.url) notBreaking[story.url] = true;
            continue;
          }
          if (isNaN(publishedAt) && story.ageHours == null) {
            breakingDrafts.push({ headline: story.headline, status: 'skipped-undated' });
            if (story.url) notBreaking[story.url] = true;
            continue;
          }

          var draft = await BreakingDraft.generateBreakingDraft(story, houseStyle);

          // Two-source check: other outlets reporting it, the draft's facts
          // against them, and whether it was already reported long ago.
          var check = await Corroborate.check(story, draft.edited, checkPool, sb);
          if (story.url) checkedByUrl[story.url] = check;
          if (check.oldNews) {
            breakingDrafts.push({ headline: story.headline, status: 'skipped-old-news', detail: check.oldNewsDetail });
            if (story.url) notBreaking[story.url] = true;
            continue;
          }
          var checkLabel = Corroborate.label(check);

          var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          var now = new Date().toISOString();
          var doc = {
            id: id, writerName: 'AI (breaking auto-draft)', tier: 'free',
            headline: draft.headline, headlines: [{ label: '', text: draft.headline }],
            html: breakingMdToHtml(draft.edited), notes: draft.notes,
            factsToCheck: Corroborate.factsToCheckLines(check).concat(draft.factsToCheck),
            corroboration: check,
            sourceUrl: story.url || null, autoGenerated: true,
            status: 'draft', createdAt: now, updatedAt: now
          };
          await Drafts.saveDraft(doc);

          var reviewUrl = 'https://ims-tool.vercel.app/editor#3/' + id;
          var recipients = await S.recipientsFor('breaking', require('./_site').slug());
          var mailToBreaking = null;
          if (recipients.length) {
            try {
              mailToBreaking = await mailer.sendMail({
                to: recipients, alertType: 'breaking',
                subject: ((story.rating || 0) >= 5 ? '🚨 Breaking' : 'Major story') + (check.status === 'single' ? ' (single source)' : '') + ': ' + draft.headline,
                html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
                  '<p style="color:#b91c1c;font-weight:700">CoPublisher AI drafted this from a ' + ((story.rating || 0) >= 5 ? 'breaking' : 'major') + ' story. Review it before publishing.</p>' +
                  Corroborate.emailBlock(check) +
                  '<h2 style="margin:10px 0">' + draft.headline + '</h2>' +
                  doc.html +
                  (doc.factsToCheck.length ? '<p style="margin-top:14px"><b>Verify before publishing:</b></p><ul>' + doc.factsToCheck.map(function(f) { return '<li>' + f + '</li>'; }).join('') + '</ul>' : '') +
                  '<p style="margin-top:16px"><a href="' + reviewUrl + '" style="background:#2563eb;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;">Open in Content Editor</a></p>' +
                  '<p style="color:#888;font-size:11px;margin-top:16px">Source: ' + (story.source || 'unknown') + (story.url ? ' · <a href="' + story.url + '">' + story.url + '</a>' : '') + '</p>' +
                  require('./_story-ratings').emailLinks(story) +
                  '</div>'
              });
            } catch (e) { mailToBreaking = { error: e.message }; }
          }

          await Chat.postSystemMessage(sb, {
            senderName: 'CoPublisher AI', kind: 'breaking', tag: 'Breaking News Alert',
            text: draft.headline + ' (' + checkLabel + ')',
            meta: { headline: draft.headline, sourceUrl: story.url || null, draftId: id, reviewUrl: reviewUrl, corroboration: checkLabel }
          });

          breakingDrafts.push({ headline: draft.headline, status: 'drafted', id: id, check: checkLabel, recipients: recipients.length, mail: mailToBreaking });
        } catch (e) {
          breakingDrafts.push({ headline: story.headline, status: 'error', error: e.message });
        }
      }
    }

    // Desktop push for the highest-priority items only — a digest email already
    // covers everything else, this is just for "drop what you're doing" news.
    // Sent after the drafts so it can carry the two-source label, and never
    // for a story with no confirmable publish date (ageHours null) or one the
    // checks above found to be old.
    var breaking = alerts.filter(function(a) { return (a.rating || 0) >= 5 && a.ageHours != null && !(a.url && notBreaking[a.url]); });
    var pushResult = null;
    if (breaking.length) {
      try {
        pushResult = await push.sendPush({
          title: breaking.length === 1 ? '🚨 Breaking Terps News' : '🚨 ' + breaking.length + ' Breaking Terps Stories',
          body: breaking.slice(0, 3).map(function(a) {
            var c = a.url && checkedByUrl[a.url];
            return a.headline + (c && c.status === 'single' ? ' (single source)' : '');
          }).join(' \n '),
          url: 'https://ims-tool.vercel.app/',
          tag: 'breaking-news'
        });
      } catch (e) { pushResult = { error: e.message }; }
    }

    console.log('Breaking drafts:', JSON.stringify(breakingDrafts.map(function(b) { return { headline: b.headline, status: b.status, check: b.check, detail: b.detail }; })));
    return res.status(200).json({ success: true, slot: slot, groups: groups.length, date: date, mail: mailResult, push: pushResult, breakingDrafts: breakingDrafts });
  } catch (error) {
    console.error('Rolling digest error (' + (slotParam || deskSlot || 'hourly') + '):', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
