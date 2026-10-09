// Proactive public-records suggestions (cron, every 2 hours). Each one is
// also saved (Records.addSuggestion) for the News Monitor's "new suggested
// records requests" panel and the next update email (rolling-digest.js).
// Reads the
// newsroom's latest shared scan (_latest-scan.js; no new scan is run), picks
// new stories in records priority tier 1 (coach/AD hires, firings, contracts,
// buyouts) or tier 2 (sponsorship, apparel, media rights, game and event
// agreements) rated 3+, has _records.draft() judge each one and draft the
// request, and emails eligible ones to everyone with the 'records' alert on
// (editors and publishers by default): the letter, where the records office
// address came from, a "Send it from my email" link and a link back to the
// News Monitor card. Nothing is sent to a records office from here: a person
// sends it.
//
// Each story is offered once (keys kept 45 days). At most MAX_PER_RUN drafts
// per run, tier 1 first, to cap Claude spend (~$0.03-0.08 each with lookup).
var S = require('./_supabase.js');
var Beat = require('./_beat.js');
var Latest = require('./_latest-scan.js');
var Records = require('./_records.js');
var mailer = require('./_mailer.js');

// The newsroom this request runs as (_site.js).
function curSite() { return require('./_site').slug(); }
var MAX_PER_RUN = 3;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function scanAlerts(latest) {
  try {
    var text = ((latest && latest.response && latest.response.content) || []).map(function (c) { return c.text || ''; }).join('');
    var arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function emailHtml(story, d, tierLabel) {
  var mailto = 'mailto:' + encodeURIComponent(d.to || '') + '?subject=' + encodeURIComponent(d.subject || '') + '&body=' + encodeURIComponent(d.body || '');
  return '<div style="font-family:Arial,sans-serif;max-width:640px;font-size:14px;line-height:1.5">' +
    '<p style="color:#b45309;font-weight:700;margin:0 0 6px">📄 Public records request ready · ' + esc(tierLabel) + '</p>' +
    '<h2 style="margin:4px 0 8px;font-size:18px">' + (story.url ? '<a href="' + esc(story.url) + '">' + esc(story.headline) + '</a>' : esc(story.headline)) + '</h2>' +
    '<p style="margin:0 0 10px">' + esc(d.reason) + '</p>' +
    (d.law ? '<p style="margin:0 0 6px"><b>Law:</b> ' + esc(d.law) + (d.agency ? ' · <b>To:</b> ' + esc(d.agency) : '') + '</p>' : '') +
    (d.records.length ? '<p style="margin:8px 0 4px"><b>Asks for:</b></p><ul style="margin:0 0 10px">' + d.records.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
    '<p style="margin:0 0 4px"><b>Send to:</b> ' + (d.to ? esc(d.to) + (/^https?:/.test(d.toSource || '') ? ' <span style="color:#888">(confirmed on <a href="' + esc(d.toSource) + '">' + esc(d.toSource.replace(/^https?:\/\//, '').slice(0, 60)) + '</a>)</span>' : '')
      : d.toUnconfirmed ? '<i>possibly ' + esc(d.toUnconfirmed) + '</i> <span style="color:#888">(not printed on the agency page' + (/^https?:/.test(d.toSource || '') ? ' <a href="' + esc(d.toSource) + '">' + esc(d.toSource.replace(/^https?:\/\//, '').slice(0, 60)) + '</a>' : '') + '; check it before sending)</span>' : '<i>no published email found</i>') +
    (d.portal ? ' · <a href="' + esc(d.portal) + '">online request portal</a>' : '') + '</p>' +
    (d.left_out && d.left_out.length ? '<p style="margin:8px 0 4px;color:#555"><b>Left out on purpose</b> (would be denied):</p><ul style="margin:0 0 10px;color:#555">' + d.left_out.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
    (d.response_note ? '<p style="color:#555;margin:0 0 10px">' + esc(d.response_note) + '</p>' : '') +
    '<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;background:#f7f6f3;border-radius:6px;padding:12px;font-size:13px">' + esc(d.body) + '</pre>' +
    '<p style="margin:14px 0 6px"><b>Want CoPublisher to send it for you?</b> Open it in CoPublisher, check the letter and tap <b>Send request</b>. It goes out under your name, you\'re copied, and the records office replies straight to you.</p>' +
    '<p style="margin:0 0 14px">' +
    '<a href="https://ims-tool.vercel.app/alerts#records" style="background:#2563eb;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;margin-right:8px">Yes, review &amp; send it for me</a>' +
    (d.to ? '<a href="' + mailto + '" style="color:#2563eb">No, I\'ll send it from my email</a>' : '') + '</p>' +
    '<p style="color:#888;font-size:11px">Fill in any [bracketed] placeholders before sending. Nothing has been sent to the records office yet; CoPublisher only wrote it. Turn these off under Permissions &amp; preferences › Your alerts.</p>' +
    '</div>';
}

module.exports = async function handler(req, res) {
  try { await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }

  try {
    var latest = await Latest.load();
    var seen = await Records.suggestedKeys(curSite());
    var candidates = scanAlerts(latest).filter(function (a) {
      var tier = typeof a.recordsTier === 'number' ? a.recordsTier : Records.classify(a);
      a._tier = tier;
      return (tier === 1 || tier === 2) && (a.rating || 0) >= 3 && !seen[Records.storyKey(a)];
    }).sort(function (a, b) { return a._tier - b._tier || (b.rating || 0) - (a.rating || 0); });
    if (!candidates.length) return res.status(200).json({ ok: true, suggested: 0, scannedAt: latest && latest.at });

    var sb = S.isConfigured() ? S.admin() : null;
    var beat = await Beat.getBeat(sb);
    var recipients = await S.recipientsFor('records', curSite());
    if (!recipients.length && !S.isConfigured()) recipients = mailer.digestList();

    var results = [], done = [];
    for (var i = 0; i < candidates.length && i < MAX_PER_RUN; i++) {
      var a = candidates[i];
      var story = { headline: String(a.headline || ''), summary: String(a.summary || ''), source: String(a.source || ''), url: a.url || '' };
      try {
        var d = await Records.draft(story, beat, { name: '', email: '' });
        done.push(Records.storyKey(a));
        // Only requests likely to be granted are offered unprompted.
        if (!d.eligible) { results.push({ headline: story.headline, eligible: false, reason: d.reason, risk: d.denial_risk }); continue; }
        if (d.denial_risk !== 'low') { results.push({ headline: story.headline, eligible: false, skipped: 'denial risk ' + d.denial_risk }); continue; }
        var tierLabel = a._tier === 1 ? 'coaching hire, firing or contract' : 'sponsorship, game or event deal';
        // Kept for the News Monitor and the next update email (Jeff, 2026-10-06).
        try {
          await Records.addSuggestion(curSite(), { headline: story.headline, url: story.url, source: story.source, tier: a._tier, tierLabel: tierLabel,
            draft: { to: d.to || '', toVerified: !!d.toVerified, toUnconfirmed: d.toUnconfirmed || '', toSource: d.toSource || '', portal: d.portal || '', agency: d.agency || '', law: d.law || '', subject: d.subject || '', body: d.body || '', records: d.records || [], reason: d.reason || '', response_note: d.response_note || '', denial_risk: d.denial_risk || '', left_out: d.left_out || [] } });
        } catch (e) { console.error('records-suggest save failed', e.message); }
        var mail = null;
        if (recipients.length) {
          try {
            mail = await mailer.sendMail({ to: recipients, alertType: 'records', subject: '📄 Records request ready: ' + story.headline.slice(0, 120), html: emailHtml(story, d, tierLabel) });
          } catch (e) { mail = { error: e.message }; }
        }
        results.push({ headline: story.headline, eligible: true, to: d.to, agency: d.agency, recipients: recipients.length, mail: mail });
      } catch (e) {
        results.push({ headline: story.headline, error: e.message });
      }
    }
    if (done.length) { try { await Records.markSuggested(curSite(), done); } catch (e) { console.error('records-suggest mark failed', e.message); } }
    return res.status(200).json({ ok: true, suggested: results.filter(function (r) { return r.eligible; }).length, results: results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
