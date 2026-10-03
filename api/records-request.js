// Public-records requests from the News Monitor ("Request records" on alert
// cards about contracts, schedules, budgets, hires and other business news).
//
//   POST {action:'draft', alert}  -> Claude judges whether records behind the
//        story are obtainable under a public-records law (FOIA, a state act like
//        Maryland's PIA) and, if so, drafts the request letter addressed to the
//        records office in the beat profile (beat.records, api/_beat.js).
//   POST {action:'send', to, subject, body, alert, cc?} -> emails it from the
//        CoPublisher mailbox under the staff member's name, CC'd to them with
//        Reply-To set to them, so the records office answers the reporter
//        directly. Editors and publishers only; writers use "Open in my email".
//   GET  -> the newsroom's sent requests, newest first.
//
// Nothing is ever sent without a person reviewing the letter and clicking
// Send. Sent requests are logged in Vercel Blob (records-requests.json) so the
// response deadline can be tracked.
var { get, put } = require('@vercel/blob');
var S = require('./_supabase.js');
var Beat = require('./_beat.js');
var { sendMail } = require('./_mailer.js');

var LOG_PATH = 'records-requests.json';
var SITE = 'insidemdsports';
var EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

var TOOL = {
  name: 'submit_records_request',
  description: 'Return the eligibility judgment and, when eligible, the drafted public-records request.',
  input_schema: {
    type: 'object',
    properties: {
      eligible: { type: 'boolean', description: 'True when a public body (public university, state or city agency, stadium authority, etc.) likely holds records behind this story that are obtainable under a public-records law.' },
      reason: { type: 'string', description: 'One or two plain sentences for the newsroom: why it is or is not requestable, and from whom.' },
      agency: { type: 'string', description: 'The public body the request goes to. Empty when not eligible.' },
      law: { type: 'string', description: 'The law the request is made under, with citation. Empty when not eligible.' },
      records: { type: 'array', items: { type: 'string' }, description: 'The specific documents to request, each one line.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'The full request letter, plain text, ready to send.' },
      response_note: { type: 'string', description: 'One sentence on the response deadline under that law, e.g. "The custodian must respond within 30 days."' }
    },
    required: ['eligible', 'reason']
  }
};

async function loadLog() {
  try {
    var r = await get(LOG_PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    var d = await new Response(r.stream).json();
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { return {}; }
}

async function appendLog(entry) {
  var all = await loadLog();
  var list = all[SITE] = Array.isArray(all[SITE]) ? all[SITE] : [];
  list.unshift(entry);
  all[SITE] = list.slice(0, 300);
  await put(LOG_PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

function clean(a) {
  a = a || {};
  return {
    headline: String(a.headline || '').slice(0, 500),
    summary: String(a.summary || '').slice(0, 3000),
    source: String(a.source || '').slice(0, 200),
    url: a.url ? String(a.url).slice(0, 2000) : ''
  };
}

async function draft(story, beat, who) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
  var t = beat.team, rec = beat.records;
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
  var office = rec.agency || rec.email || rec.law
    ? 'RECORDS OFFICE ON FILE FOR THIS BEAT:\n' +
      (rec.agency ? 'Agency: ' + rec.agency + '\n' : '') + (rec.law ? 'Law: ' + rec.law + '\n' : '') +
      (rec.email ? 'Email: ' + rec.email + '\n' : '') + (rec.mail ? 'Mail: ' + rec.mail + '\n' : '') +
      (rec.public === true ? 'This school/team is a public body.\n' : rec.public === false ? 'This school/team is NOT a public body; only a separate public body (e.g. a stadium authority, city or state) could hold requestable records.\n' : '') +
      (rec.notes ? 'Notes: ' + rec.notes + '\n' : '')
    : 'No records office is on file; identify the right public body and law yourself, and say so in the reason.\n';

  var sys = 'You help a sports newsroom file public-records requests (federal FOIA, or the state public-records law that covers a public university or other government body). ' +
    'You judge whether the documents behind a news story are likely held by a public body and obtainable, and when they are, you draft a precise, professional request letter.\n\n' +
    'Eligibility: public universities and their athletic departments, state and local agencies, and public stadium/sports authorities are covered. Private universities, pro teams, conferences, the NCAA and NIL collectives generally are not, unless a public body holds a copy (say, a public school\'s game contract with a private opponent). Stories with no plausible underlying document (game recaps, injuries, recruiting commitments, player quotes) are not eligible.\n\n' +
    'Good requests ask for specific, identifiable documents with a date range: employment agreements, amendments, term sheets and memoranda of understanding; buyout and incentive provisions; game contracts and guarantee payments with an opponent; facility, apparel, media-rights and sponsorship agreements; budgets and expense reports; settlement agreements; and, when useful, email correspondence between named officials over a narrow date range containing named keywords. ' +
    'Ask for electronic copies, release of any non-exempt portions, the specific legal basis for anything withheld, and a fee waiver or reduction because the requester is news media and the records serve the public interest (ask for an estimate before fees over $50). Cite the statute. Courteous and businesslike, no legal threats. Never state facts beyond what the story says. ' +
    'Sign it with the requester\'s name, outlet and email exactly as given; leave a clear [placeholder] for anything not given.';

  var user = 'Today: ' + today + '\nBeat: ' + beat.coverage + (t.school ? ' (' + t.school + ')' : '') + ', level: ' + t.level + '\n' + office +
    '\nREQUESTER: ' + (who.name || '[Your name]') + ', ' + beat.outletName + (who.email ? ', ' + who.email : '') +
    '\n\nSTORY:\nHeadline: ' + story.headline + '\nSummary: ' + story.summary + '\nSource: ' + story.source + (story.url ? '\nURL: ' + story.url : '');

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys,
      tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: user }]
    })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === TOOL.name; })[0];
  var out = tu && tu.input;
  if (!out || typeof out.eligible !== 'boolean') throw new Error('No usable draft returned');
  out.records = Array.isArray(out.records) ? out.records : [];
  // The address on file is only right when the request goes to that office.
  out.to = out.eligible && rec.email && (!out.agency || !rec.agency || out.agency.toLowerCase().indexOf(rec.agency.toLowerCase().split(',')[0]) !== -1) ? rec.email : '';
  return out;
}

module.exports = async function handler(req, res) {
  var auth;
  try { auth = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }

  if (req.method === 'GET') {
    var all = await loadLog();
    return res.status(200).json({ requests: all[SITE] || [] });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var body = req.body || {};
  var user = auth && auth.user;
  var who = {
    email: (user && user.email) || '',
    name: (auth && auth.membership && auth.membership.byline) || (user && user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || ''
  };

  try {
    if (body.action === 'draft') {
      var story = clean(body.alert);
      if (!story.headline) return res.status(400).json({ error: 'alert.headline required' });
      var beat = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
      return res.status(200).json(await draft(story, beat, who));
    }

    if (body.action === 'send') {
      // Mail goes out to a third party under a staff member's name: a signed-in
      // editor or publisher only (cron and in-process callers never send).
      if (auth && (auth.cron || auth.internal)) return res.status(403).json({ error: 'Records requests are sent by a person, not a scheduled job' });
      if (auth && auth.membership && auth.membership.role === 'writer') return res.status(403).json({ error: 'Ask an editor to send it, or use "Open in my email" to send it yourself' });
      var to = String(body.to || '').trim();
      var subject = String(body.subject || '').trim().slice(0, 300);
      var text = String(body.body || '').trim().slice(0, 20000);
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter the records office email address' });
      if (!subject || !text) return res.status(400).json({ error: 'Subject and letter are required' });
      if (/\[[^\]]{2,60}\]/.test(text)) return res.status(400).json({ error: 'Fill in the [bracketed] placeholders in the letter first' });
      var cc = [who.email].concat(String(body.cc || '').split(/[,;\s]+/)).map(function (e) { return e.trim(); })
        .filter(function (e, i, arr) { return e && EMAIL_RE.test(e) && e.toLowerCase() !== to.toLowerCase() && arr.indexOf(e) === i; });
      var replyTo = who.email || cc[0] || '';
      if (!replyTo) return res.status(400).json({ error: 'Add your email in CC so the records office can reply to you' });
      var beat2 = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
      var esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      var sent = await sendMail({
        to: [to], cc: cc, replyTo: replyTo, subject: subject, text: text,
        html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">' + esc(text) + '</div>',
        fromName: (who.name ? who.name + ', ' : '') + beat2.outletName
      });
      var entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sentAt: new Date().toISOString(), to: to, cc: cc, subject: subject,
        agency: String(body.agency || '').slice(0, 200), law: String(body.law || '').slice(0, 300),
        responseNote: String(body.responseNote || '').slice(0, 300),
        story: clean(body.alert), requestedBy: who.email || null, via: sent.via
      };
      try { await appendLog(entry); } catch (e) { console.error('records log failed', e.message); }
      return res.status(200).json({ ok: true, request: entry });
    }

    return res.status(400).json({ error: "action must be 'draft' or 'send'" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
