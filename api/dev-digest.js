// Daily "what got built" email — Jeff wants a standing digest of engineering
// progress on IMSTool itself, not the newsroom content. Runs on its own cron
// (independent of everything else): pulls the last 24h of commits straight
// from GitHub's public API (no repo checkout needed — this is a serverless
// function, not a git client) plus the top of TODO.md's Pending list, has
// Claude write a short "what shipped / what's next" note, and emails it to
// Jeff and Dana directly (not the newsroom's ALERT_EMAIL list).
//
// Self-contained on purpose: doesn't depend on any particular coding session
// being open. If nothing merged to main in the window, it still sends —
// silence is itself a useful signal that nothing has moved.

var mailer = require('./_mailer.js');

var REPO = 'Ermdog11/IMSTool';
var RECIPIENTS = ['jeffermann@gmail.com', 'dana.ermann@gmail.com'];
var BROWSER_UA = 'imstool-dev-digest';

async function fetchRecentCommits() {
  var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  var url = 'https://api.github.com/repos/' + REPO + '/commits?sha=main&since=' + since + '&per_page=50';
  var r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub commits fetch failed: HTTP ' + r.status);
  var data = await r.json();
  return (data || []).map(function(c) {
    return { sha: c.sha.slice(0, 7), message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date };
  });
}

async function fetchTodoPending() {
  var url = 'https://raw.githubusercontent.com/' + REPO + '/main/TODO.md';
  var r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) return '';
  var text = await r.text();
  var m = text.match(/## Pending([\s\S]*?)(\n## |$)/);
  return m ? m[1].trim().slice(0, 6000) : '';
}

async function writeDigest(commits, pending, dateLabel) {
  var key = process.env.ANTHROPIC_API_KEY;
  var commitList = commits.length
    ? commits.map(function(c) { return '- ' + c.message.split('\n')[0] + (c.message.indexOf('\n') !== -1 ? '\n  ' + c.message.split('\n').slice(1).join(' ').trim().slice(0, 300) : ''); }).join('\n')
    : '(no commits merged to main in the last 24 hours)';

  if (!key) {
    // Degrade gracefully — plain text instead of a synthesized note (still readable, just not translated).
    return {
      shipped: '<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;">' + commitList + '</pre>',
      next: '<p>(Digest couldn\'t reach the writing assistant today, so here\'s the raw to-do list instead.)</p><pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;">' + pending.slice(0, 1500) + '</pre>'
    };
  }

  var prompt =
    'You write a short daily email for Jeff, the founder of a newsroom product called IMSTool, and his wife Dana, updating them on what the engineering team built yesterday. ' +
    "Neither is a programmer, so write like you're catching a smart friend up over coffee — plain English, no jargon. " +
    'Never use words like: commit, repo, API, cron, endpoint, database table, schema, deploy, backend, frontend, function, or any file/variable name. ' +
    'Instead of naming the mechanism, describe what changed for a person using the product and why it matters — e.g. instead of "added a cron job to scrape 247Sports and diff it against content_items", write "the tool now automatically checks what actually got published against what our AI first drafted, so we can see what our editors tend to change." ' +
    "Today's date: " + dateLabel + ".\n\n" +
    'WORK LOG FROM THE LAST 24 HOURS (technical notes to translate, not to quote):\n' + commitList + '\n\n' +
    "TOP OF THE TEAM'S TODO LIST (not all of it happens immediately — mention only what's genuinely next):\n" + (pending || '(none)') + '\n\n' +
    'Write two sections, each as a series of short HTML paragraphs (2-4 sentences each, one clear idea per paragraph, plenty of white space — never a dense bullet list):\n' +
    '1. WHAT WE BUILT YESTERDAY — one paragraph per distinct piece of work. If nothing happened, one short paragraph saying so plainly.\n' +
    "2. WHAT'S COMING NEXT — one paragraph per near-term item, 2-4 total, prioritizing whatever unblocks other work or was asked for recently.\n\n" +
    'Give every paragraph the style attribute style="margin:0 0 14px" so they have breathing room in an email client. ' +
    'Return ONLY a JSON object: {"shipped": "<p style=\\"margin:0 0 14px\\">...</p>...", "next": "<p style=\\"margin:0 0 14px\\">...</p>..."} — no markdown, no preamble, no other text.';

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + JSON.stringify(d.error));
  var raw = (d.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n').trim();
  var fallback = {
    shipped: '<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;">' + commitList + '</pre>',
    next: '<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;">' + pending.slice(0, 1500) + '</pre>'
  };
  var jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;
  try {
    var parsed = JSON.parse(jsonMatch[0]);
    return { shipped: parsed.shipped || fallback.shipped, next: parsed.next || fallback.next };
  } catch (e) {
    return fallback;
  }
}

module.exports = async function handler(req, res) {
  var dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  try {
    var commits = await fetchRecentCommits();
    var pending = await fetchTodoPending();
    var digest = await writeDigest(commits, pending, dateLabel);

    var html =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">' +
      '<div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0"><span style="color:#fff;font-weight:700">IMSTool build digest — ' + dateLabel + '</span></div>' +
      '<div style="background:#fff;border:1px solid #e8e6e1;border-top:none;border-radius:0 0 8px 8px;padding:18px;font-size:14px;line-height:1.55">' +
      '<h3 style="margin:0 0 6px">What shipped</h3>' + digest.shipped +
      '<h3 style="margin:16px 0 6px">What\'s next</h3>' + digest.next +
      '<p style="color:#888;font-size:11px;margin-top:20px;border-top:1px solid #eee;padding-top:10px">Auto-generated from the last 24 hours of commits to main plus the project TODO. Sanity-check before treating it as gospel.</p>' +
      '</div></div>';

    var mailResult = await mailer.sendMail({
      to: RECIPIENTS,
      subject: 'IMSTool build digest — ' + dateLabel,
      html: html
    });

    return res.status(200).json({ ok: true, commits: commits.length, mail: mailResult });
  } catch (e) {
    console.error('dev-digest error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
