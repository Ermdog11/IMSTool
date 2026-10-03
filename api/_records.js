// Public-records requests (FOIA / state open-records acts): the shared logic
// behind the "Request records" card button (api/records-request.js) and the
// proactive suggestions cron (api/records-suggest.js), so the two can't drift.
//
//   classify(story)   -> priority tier from the headline/summary:
//                        1 coach/AD hires, firings, contracts, buyouts
//                        2 sponsorship, apparel, media/naming rights, game and
//                          event agreements (series, home-and-home, guarantees),
//                          other contracts/MOUs, NCAA investigations and
//                          violations, arrests, lawsuits, settlements, audits
//                        3 other money/business news (budgets, bonuses, travel,
//                          ticket revenue, facilities, donations, regents...)
//   draft(story, beat, who) -> Claude's eligibility call + the request letter,
//                        addressed to the records office on file, or one found
//                        by web search (lookupOffice) when none is on file.
//   lookupOffice(agency) -> { email, portal, law, sourceUrl } via Claude's web
//                        search, cached 60 days per agency in Blob.
//   log / suggested state in Blob records-requests.json.
//
// Nothing here sends a request: a person always reviews and clicks Send.
var { get, put } = require('@vercel/blob');

var LOG_PATH = 'records-requests.json';
var OFFICE_PATH = 'records-offices.json';
var OFFICE_TTL_MS = 60 * 24 * 3600 * 1000;
var EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

var PEOPLE = '(head coach|coach|coaches|coaching staff|coordinator|athletic director|athletics director|\\bad\\b|general manager|\\bgm\\b|president|chancellor)';
var TIER1 = new RegExp('(' + PEOPLE + '[^.]{0,80}\\b(hired|hires|hiring|fired|fires|firing|dismissed|ousted|resigns?|resigned|retires?|retiring|steps? down|parts? ways|contract|extension|extended|buyout|salary|raise|compensation|deal|agreement|terminat\\w*|named|introduced))|(\\b(hire[sd]?|hiring|fire[sd]?|firing|ousts?|ousted|dismiss(es|ed)?|buyout|parts? ways with|contract extension|new contract|extension)\\b[^.]{0,80}' + PEOPLE + ')|\\b(buyouts?|parts? ways|contract extension|extension through|new contract|contract through|signs? (an? )?(contract )?extension|(contract|extension) worth)\\b', 'i');
var TIER2 = /\b(sponsorships?|sponsor|apparel|nike|under armour|adidas|jordan brand|media rights|tv deal|broadcast (deal|rights)|naming rights|multimedia rights|learfield|game contract|home-and-home|home and home|neutral.site|series (with|against)|(future|non-?conference)( \w+)? (games?|schedules?|opponents?)|schedules? (a )?(game|series|matchup)|guarantee (game|payment)|bowl (agreement|tie-in|partnership)|classic|showcase|tournament agreement|event agreement|agreement|partnership|signs? (a |an )?(deal|agreement)|contracts?|memorandum of understanding|mou|ncaa (investigation|probe|violations?|sanctions?|infractions?|penalt\w+|notice of allegations)|notice of allegations|infractions?|violations?|sanction\w*|show.cause|investigations?|probe|title ix|lawsuits?|sued|sues|suing|settlements?|arrest\w*|charged|citations?|police|misconduct|harassment|hazing|audit\w*|whistleblower|complaints?)\b/i;
var TIER3 = /\b(salar(y|ies)|bonus(es)?|incentives?|perks?|courtesy cars?|private (jet|plane|flight)s?|travel (budget|costs?|expenses?|spending)|private flights?|recruiting (budget|spending|expenses?)|ticket (sales|prices?|revenue)|attendance|season tickets?|premium seating|suites?|concessions?|alcohol sales|beer sales|licensing|royalt(y|ies)|search firm|consultants?|severance|tuition|scholarships? (cost|count|limits?)|roster limits?|cost of attendance|camp revenue|clinic revenue|board of (regents|trustees|visitors)|regents|trustees|bond|debt|loans?|subsid(y|ies)|student fees?|athletic fees?|conference distributions?|media revenue|naming|security|emails?|text messages|communications|public records|documents show|memo|compensation|payouts?|budgets?|deficit|revenue|donations?|donors?|gifts?|fundrais\w*|facilit(y|ies)|stadium|arena|renovat\w*|construction|lawsuits?|sued|settlements?|investigations?|title ix|nil (deal|fund|collective|budget)|revenue.sharing|house settlement|realignment|exit fee|audit|expenses?|charter|scheduled?|scheduling)\b/i;

function classify(a) {
  if (!a || a.kind === 'video' || ['social', 'podcast'].indexOf(a.category) !== -1) return 0;
  var t = (a.headline || '') + '. ' + (a.summary || '');
  if (TIER1.test(t)) return 1;
  if (TIER2.test(t)) return 2;
  if (TIER3.test(t)) return 3;
  return 0;
}

async function readJson(path) {
  try {
    var r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    var d = await new Response(r.stream).json();
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { return {}; }
}
async function writeJson(path, data) {
  await put(path, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

// ── Records-office lookup ──────────────────────────────────────────────────
var OFFICE_TOOL = {
  name: 'report_records_office',
  description: 'Report where public-records requests to this agency are submitted. Call exactly once, after searching.',
  input_schema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'The email address that accepts public-records requests, exactly as published by the agency. Empty if the agency only takes requests through a web portal or none was found.' },
      portal: { type: 'string', description: 'URL of the online request portal or form, if any.' },
      law: { type: 'string', description: 'The public-records law that applies, with citation.' },
      source_url: { type: 'string', description: 'The official page (preferably on the agency\'s own domain) where the email/portal is published.' }
    },
    required: ['email', 'portal', 'law', 'source_url']
  }
};

async function lookupOffice(agency) {
  agency = String(agency || '').trim();
  if (!agency) return null;
  var key = agency.toLowerCase();
  var cache = await readJson(OFFICE_PATH);
  var hit = cache[key];
  if (hit && Date.now() - hit.at < OFFICE_TTL_MS) return hit.office;

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  var messages = [{ role: 'user', content: 'Find where to submit a public-records request (FOIA or the state open-records act) to: ' + agency +
    '.\nSearch for the agency\'s official public-records / FOIA / open-records page. Use only an email or portal published by the agency itself (its own domain or an official state site), never a third-party aggregator\'s guess. Then call report_records_office.' }];
  var office = null;
  // Server-side web search can pause a long turn (pause_turn); resume a couple of times.
  for (var round = 0; round < 3 && !office; round++) {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 2000,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }, OFFICE_TOOL],
        tool_choice: { type: 'auto' },
        messages: messages
      })
    });
    var d = await r.json();
    if (d.error) throw new Error('Records-office lookup: ' + (d.error.message || JSON.stringify(d.error)));
    var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === OFFICE_TOOL.name; })[0];
    if (tu) { office = tu.input || {}; break; }
    if (d.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: d.content });
  }
  if (!office) return null;
  var email = String(office.email || '').trim().replace(/^mailto:/i, '');
  var out = {
    email: EMAIL_RE.test(email) ? email : '',
    portal: /^https?:\/\//i.test(office.portal || '') ? String(office.portal).slice(0, 500) : '',
    law: String(office.law || '').slice(0, 300),
    sourceUrl: /^https?:\/\//i.test(office.source_url || '') ? String(office.source_url).slice(0, 500) : ''
  };
  if (!out.sourceUrl) out.email = ''; // an address we can't point to a source for isn't trusted
  try { cache[key] = { at: Date.now(), office: out }; await writeJson(OFFICE_PATH, cache); } catch (e) { /* cache is best-effort */ }
  return out;
}

// ── Drafting ───────────────────────────────────────────────────────────────
var TOOL = {
  name: 'submit_records_request',
  description: 'Return the eligibility judgment and, when eligible, the drafted public-records request.',
  input_schema: {
    type: 'object',
    properties: {
      eligible: { type: 'boolean', description: 'True when a public body (public university, state or city agency, stadium authority, etc.) likely holds records behind this story that are obtainable under a public-records law.' },
      reason: { type: 'string', description: 'One or two plain sentences for the newsroom: why it is or is not requestable, and from whom.' },
      agency: { type: 'string', description: 'The public body the request goes to, by its full official name (e.g. "The Ohio State University"). Empty when not eligible.' },
      law: { type: 'string', description: 'The law the request is made under, with citation. Empty when not eligible.' },
      records: { type: 'array', items: { type: 'string' }, description: 'The specific documents to request, each one line.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'The full request letter, plain text, ready to send.' },
      response_note: { type: 'string', description: 'One sentence on the response deadline under that law, e.g. "The custodian must respond within 30 days."' }
    },
    required: ['eligible', 'reason']
  }
};

function sameAgency(a, b) {
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); };
  a = norm(a); b = norm(b);
  return !!(a && b && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1));
}

async function draft(story, beat, who) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
  var t = beat.team, rec = beat.records || {};
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });
  var office = rec.agency || rec.email || rec.law
    ? 'RECORDS OFFICE ON FILE FOR THIS BEAT:\n' +
      (rec.agency ? 'Agency: ' + rec.agency + '\n' : '') + (rec.law ? 'Law: ' + rec.law + '\n' : '') +
      (rec.email ? 'Email: ' + rec.email + '\n' : '') + (rec.mail ? 'Mail: ' + rec.mail + '\n' : '') +
      (rec.public === true ? 'This school/team is a public body.\n' : rec.public === false ? 'This school/team is NOT a public body; only a separate public body (e.g. a stadium authority, city or state) could hold requestable records.\n' : '') +
      (rec.notes ? 'Notes: ' + rec.notes + '\n' : '')
    : 'No records office is on file; identify the right public body and law yourself.\n';

  var sys = 'You help a sports newsroom file public-records requests (federal FOIA, or the state public-records law that covers a public university or other government body). ' +
    'You judge whether the documents behind a news story are likely held by a public body and obtainable, and when they are, you draft a precise, professional request letter.\n\n' +
    'Eligibility: public universities and their athletic departments, state and local agencies, and public stadium/sports authorities are covered. Private universities, pro teams, conferences, the NCAA and NIL collectives generally are not, unless a public body holds a copy (a public school\'s game contract with a private opponent; a private school\'s contract with a public school; a pro team\'s lease with a public stadium authority). The story may be about any school, not only the beat team: address the request to whichever public body holds the documents. Stories with no plausible underlying document (game recaps, recruiting commitments, player quotes) are not eligible, and student education records (grades, eligibility files) and medical records are exempt, so never request those; ask instead for the releasable documents around them (e.g. the institution\'s correspondence with the NCAA, a police report, a policy, a contract). Look for any document a public body would hold that could carry news: contracts and amendments, payments, emails among named officials, meeting minutes, reports, complaints.\n\n' +
    'Good requests ask for specific, identifiable documents with a date range: employment agreements, offer letters, amendments, term sheets and memoranda of understanding; separation, buyout and settlement agreements; incentive and bonus provisions; game contracts and guarantee payments; event, facility, apparel, sponsorship, media-rights and naming-rights agreements; budgets, expense and travel reports, bonus and incentive payouts, ticket and attendance revenue, search-firm and consultant contracts, board of regents/trustees minutes and votes, NCAA infractions correspondence and self-reports, police and incident reports (adult arrests), audit reports, Title IX outcomes as releasable, lawsuit and settlement records; and, when useful, email correspondence between named officials over a narrow date range containing named keywords. ' +
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
  out.tier = classify(story);
  out.to = ''; out.toSource = ''; out.portal = '';
  if (!out.eligible) return out;

  // Address: the beat's own records office when the request goes there,
  // otherwise look the agency's office up on the web.
  if (rec.email && (!out.agency || !rec.agency || sameAgency(out.agency, rec.agency))) {
    out.to = rec.email; out.toSource = 'beat profile'; out.portal = rec.portal || '';
  } else if (out.agency) {
    try {
      var found = await lookupOffice(out.agency);
      if (found) { out.to = found.email; out.toSource = found.sourceUrl; out.portal = found.portal; if (!out.law && found.law) out.law = found.law; }
    } catch (e) { out.lookupError = e.message; }
  }
  return out;
}

// ── Log + suggestion state ─────────────────────────────────────────────────
async function loadState() { return readJson(LOG_PATH); }
async function appendLog(site, entry) {
  var all = await loadState();
  all[site] = (Array.isArray(all[site]) ? all[site] : []);
  all[site].unshift(entry);
  all[site] = all[site].slice(0, 300);
  await writeJson(LOG_PATH, all);
}
function storyKey(a) { return String((a && (a.url || a.headline)) || '').toLowerCase().slice(0, 300); }
// Stories already offered by the suggestions cron (so each is offered once).
async function suggestedKeys(site) {
  var all = await loadState();
  return (all._suggested && all._suggested[site]) || {};
}
async function markSuggested(site, keys) {
  var all = await loadState();
  all._suggested = all._suggested || {};
  var m = all._suggested[site] = all._suggested[site] || {};
  var now = Date.now();
  keys.forEach(function (k) { m[k] = now; });
  Object.keys(m).forEach(function (k) { if (now - m[k] > 45 * 24 * 3600 * 1000) delete m[k]; });
  await writeJson(LOG_PATH, all);
}

module.exports = {
  classify: classify, draft: draft, lookupOffice: lookupOffice,
  loadState: loadState, appendLog: appendLog, storyKey: storyKey,
  suggestedKeys: suggestedKeys, markSuggested: markSuggested, EMAIL_RE: EMAIL_RE
};
