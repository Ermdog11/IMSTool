// Coverage Desk agent — a scheduled "assistant editor" memo.
//
// Runs on its own each morning (vercel.json cron). Reads this morning's rated
// news + what InsideMDSports has recently published, and emails the publisher a
// short editor's memo: what to cover today, gaps competitors have filled that we
// haven't, developing threads to follow up, and an editor's read. The
// "what worked" section is a placeholder until analytics is connected.
//
// Same shape as roster-check.js: cron -> bounded Claude call -> email.

var mailer = require('./_mailer');

module.exports = async function handler(req, res) {
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

    var today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

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
      'WHAT WORKED — write exactly one line: "Article-performance insights will appear here once analytics is connected." Do not invent numbers or name a top story.\n' +
      "EDITOR'S READ — one or two sentences: an honest take on where the beat is right now and the single thing you would focus on today.\n\n" +
      "TODAY'S RATED NEWS:\n" + (newsList || '(nothing notable in the scan)') + '\n\n' +
      'RECENTLY PUBLISHED BY INSIDEMDSPORTS:\n' + (ownList || '(unavailable this run)') + '\n\n' +
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
      '<div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0"><span style="color:#fff;font-weight:700">Coverage Desk &mdash; ' + today + '</span></div>' +
      '<div style="background:#fff;border:1px solid #e8e6e1;border-top:none;border-radius:0 0 8px 8px;padding:18px;font-size:14px;line-height:1.55">' +
      memo +
      '<p style="color:#888;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:10px">Auto-generated from this morning’s scan of ' + alerts.length + ' rated stories. A starting point &mdash; review before assigning.</p>' +
      '</div></div>';

    var mailResult = await mailer.sendMail({ subject: 'Coverage Desk — ' + today, html: html });

    console.log('Coverage Desk sent | alerts:', alerts.length, '| own index:', ownIndex.length, '| mail:', JSON.stringify(mailResult));
    return res.status(200).json({ ok: true, alerts: alerts.length, ownIndex: ownIndex.length, mail: mailResult });
  } catch (e) {
    console.error('coverage-desk error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
