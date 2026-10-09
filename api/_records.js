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
//
// Requests that would be denied on sight are never suggested (Jeff,
// 2026-10-09: "should understand student privacy law and standard rules so it
// doesn't suggest requests that will automatically be denied"): DENIAL_RULES
// is the drafter's rulebook (FERPA and the other standard exemptions, plus
// what makes any request fail), the model rates each draft's denial risk and
// lists what it left out and why, and screenRecords() drops any requested
// item that is plainly a protected student record. A draft judged high risk,
// or left with nothing requestable, comes back not eligible.
var { get, put } = require('./_site-blob');

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

// Is this email really on the agency's own page? (Jeff, 2026-10-06: auto-fill
// the address only "if it can reliably".) Fetches the cited page and looks
// for the address, also in the "name [at] domain [dot] edu" form. A miss
// leaves the address as a suggestion to check rather than filling it in.
async function emailOnPage(email, url) {
  if (!email || !url) return false;
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoPublisherAI/1.0)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    var t = (await r.text()).toLowerCase()
      .replace(/&#64;|&commat;|\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*/g, '@')
      .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*|&#46;/g, '.');
    return t.indexOf(email.toLowerCase()) !== -1;
  } catch (e) { return false; }
}

async function lookupOffice(agency) {
  agency = String(agency || '').trim();
  if (!agency) return null;
  var key = agency.toLowerCase();
  var cache = await readJson(OFFICE_PATH);
  var hit = cache[key];
  if (hit && Date.now() - hit.at < OFFICE_TTL_MS && hit.office && typeof hit.office.verified === 'boolean') return hit.office;

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
  out.verified = out.email ? await emailOnPage(out.email, out.sourceUrl) : false;
  try { cache[key] = { at: Date.now(), office: out }; await writeJson(OFFICE_PATH, cache); } catch (e) { /* cache is best-effort */ }
  return out;
}

// ── Privacy law and standard denial rules ─────────────────────────────────
var DENIAL_RULES =
  'WHAT GETS DENIED (never ask for these; a request built on them is refused on sight):\n' +
  '1. Student records (FERPA, 20 U.S.C. 1232g; 34 CFR Part 99). Every enrolled student, student-athletes included, has protected education records: grades, GPA, transcripts, class schedules, academic progress and eligibility certifications, APR/academic data about a named athlete, admissions files, financial aid and an individual athlete\'s scholarship amount or cancellation, disciplinary and Title IX case files about a student, student emails and records that identify a student, and athletic-training, injury, treatment and drug-test records. Redacting the name does not help when the story already identifies the student, because the record is still "personally identifiable". Allowed instead: aggregate or de-identified data (team GPA, total athletic aid spent, APR for the team, roster counts), directory information the school designates (name, sport, height/weight, hometown, dates of attendance), the final result of a disciplinary proceeding for a crime of violence or nonforcible sex offense (34 CFR 99.31(a)(14)), law-enforcement unit records, the institution\'s own policies, and its correspondence with the NCAA or conference with student information redacted.\n' +
  '2. Recruits and minors: a prospect\'s file, evaluations, visit records, communications with a recruit and anything identifying a minor. Recruiting is not requestable except the program\'s aggregate recruiting budget and travel/expense reports.\n' +
  '3. Individual athletes\' NIL and revenue-sharing deals: many state NIL laws make an athlete\'s NIL contracts and disclosures confidential, and revenue-sharing payments to a named athlete are protected student financial information. Ask only for aggregate totals, the policy, and the institution\'s own contracts with collectives or marketing partners where that state allows it.\n' +
  '4. Medical and health information about anyone (injuries, concussions, mental health, physicals), even when a coach discussed it publicly.\n' +
  '5. Personnel files: in most states, an employee\'s evaluations, discipline, complaints, applications of candidates who were not hired, and background checks are exempt. Still public almost everywhere: the contract, salary and bonuses, offer letter, separation/buyout agreement, job description, dates of employment, and often the finalists for a top job. Ask for those.\n' +
  '6. Open investigations: police and agency investigative files are withheld while the case is open; ask for the incident report or arrest record (adults only) and charging documents. An NCAA infractions case in progress is often withheld until the Committee on Infractions decision; ask for the notice of allegations and response once public, or for correspondence with student information redacted.\n' +
  '7. Attorney-client and legal advice, drafts and internal deliberations before a decision (in many states), security plans, trade secrets and some proprietary terms in sponsorship or media deals (in some states), and donors who asked to stay anonymous. Athletic foundations, booster clubs, collectives and private conferences are usually not public bodies, so they can\'t be asked at all; ask the public university for what it holds.\n' +
  'STANDARD RULES ANY REQUEST MUST FOLLOW OR IT IS DENIED OR BURIED IN FEES:\n' +
  '- Ask only for records that already exist. A public-records law does not make an agency answer questions, explain decisions, compile new lists or create a document (ask for "the records showing X", not "how much was X").\n' +
  '- Describe the records so a clerk can find them: the document type, the people or offices, and a date range. No "all records relating to"; no open-ended email searches. Emails must name the senders/recipients, a range of weeks or months, and keywords.\n' +
  '- No future records, no standing requests for anything created later.\n' +
  '- Send it to the public body that holds the records, under that state\'s own law and its own exemptions (apply the specific state law, e.g. the Maryland Public Information Act, General Provisions Title 4, with its personnel and student-record exemptions).\n' +
  '- When the documents behind a story are all protected, the honest answer is not eligible: say so plainly and, if there is one, name a narrower record that could be obtained instead.\n';

// A requested item that is plainly a protected record about a student or
// recruit (grades, eligibility, injuries, an athlete's NIL deal...). These are
// dropped from the draft even if the model missed them; aggregate wording
// ("team", "all athletes", "total", "aggregate", "policy") is let through.
var STUDENT_SUBJECT = /\b(student|player|athlete|recruit|prospect|signee|commit|transfer|walk-on|quarterback|guard|forward|center|freshman|sophomore|junior|senior|his|her|their)\b/i;
var PROTECTED_ITEM = /\b(grades?|gpa|transcripts?|academic (records?|progress|standing|eligibility|file)|eligibility (records?|file|certification|status)|class schedules?|admissions? (file|records?|application)|financial aid|scholarship (amount|agreement|offer|cancell?ation|records?)|medical|injur(y|ies)|concussion|treatment|athletic training records?|drug.test|disciplinary (file|records?)|conduct (file|records?)|title ix (file|case file|investigation file)|counseling|mental health|nil (contract|deal|agreement|disclosure)s?|revenue.sharing (agreement|contract|payment)s?|recruiting (file|evaluations?|notes|communications?)|official visit records?|national letter of intent)\b/i;
var AGGREGATE = /\b(aggregate|total|totals|team-wide|all (student-)?athletes|de-?identified|redact\w*|polic(y|ies)|budget|summary|statistics|counts?)\b/i;
function screenRecords(list) {
  var keep = [], dropped = [];
  (list || []).forEach(function (r) {
    var t = String(r || '');
    if (PROTECTED_ITEM.test(t) && !AGGREGATE.test(t) && (STUDENT_SUBJECT.test(t) || !/\b(coach|director|employee|staff|official|president|chancellor)\b/i.test(t))) dropped.push(t);
    else keep.push(t);
  });
  return { keep: keep, dropped: dropped };
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
      response_note: { type: 'string', description: 'One sentence on the response deadline under that law, e.g. "The custodian must respond within 30 days."' },
      denial_risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How likely the request as drafted is to be refused under FERPA, the state law\'s exemptions or the standard rules. High means it would very likely be denied outright; then set eligible to false.' },
      left_out: { type: 'array', items: { type: 'string' }, description: 'Records the story points to that were NOT requested because they are protected or not obtainable, each with the reason in a few words, e.g. "His academic eligibility file (FERPA student record)". Empty if none.' }
    },
    required: ['eligible', 'reason', 'denial_risk']
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
    'Eligibility: public universities and their athletic departments, state and local agencies, and public stadium/sports authorities are covered. Private universities, pro teams, conferences, the NCAA and NIL collectives generally are not, unless a public body holds a copy (a public school\'s game contract with a private opponent; a private school\'s contract with a public school; a pro team\'s lease with a public stadium authority). The story may be about any school, not only the beat team: address the request to whichever public body holds the documents. Stories with no plausible underlying document (game recaps, recruiting commitments, visits and rankings, player quotes, injuries, transfers and eligibility rulings about a student) are not eligible unless a releasable institutional record sits behind them. Look for any document a public body would hold that could carry news: contracts and amendments, payments, emails among named officials, meeting minutes, reports, complaints.\n\n' +
    DENIAL_RULES + '\n' +
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
  out.left_out = Array.isArray(out.left_out) ? out.left_out : [];
  if (['low', 'medium', 'high'].indexOf(out.denial_risk) === -1) out.denial_risk = 'medium';
  var sc = screenRecords(out.records);
  if (sc.dropped.length) {
    out.records = sc.keep;
    out.left_out = out.left_out.concat(sc.dropped.map(function (r) { return r + ' (protected student record, left out)'; }));
    // Take the same lines out of the letter, so it never asks for them.
    if (out.body) sc.dropped.forEach(function (r) { out.body = out.body.split('\n').filter(function (l) { return l.indexOf(r.slice(0, 60)) === -1; }).join('\n'); });
  }
  if (out.eligible && (out.denial_risk === 'high' || !out.records.length)) {
    out.eligible = false;
    out.reason = (out.reason ? out.reason + ' ' : '') + (out.records.length
      ? 'As drafted it would very likely be denied, so CoPublisher isn\'t suggesting it.'
      : 'Everything behind this story is a protected record (student privacy or another exemption), so a request would be denied.');
  }
  out.tier = classify(story);
  out.to = ''; out.toSource = ''; out.portal = '';
  if (!out.eligible) return out;

  // Address: the beat's own records office when the request goes there,
  // otherwise look the agency's office up on the web.
  if (rec.email && (!out.agency || !rec.agency || sameAgency(out.agency, rec.agency))) {
    out.to = rec.email; out.toSource = 'beat profile'; out.portal = rec.portal || ''; out.toVerified = true;
  } else if (out.agency) {
    try {
      var found = await lookupOffice(out.agency);
      if (found) {
        out.toSource = found.sourceUrl; out.portal = found.portal; if (!out.law && found.law) out.law = found.law;
        // Fill the address in only when it's printed on that page; otherwise
        // offer it as a possible address to check.
        if (found.verified) { out.to = found.email; out.toVerified = true; }
        else if (found.email) out.toUnconfirmed = found.email;
      }
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

// Suggested requests found by the records-suggest cron, kept for the News
// Monitor ("📄 N new suggested records requests") and for the next update
// email (each one goes in one digest: inDigest).
async function addSuggestion(site, s) {
  var all = await loadState();
  var list = (all._suggestions && all._suggestions[site]) || [];
  s.id = s.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  s.at = s.at || new Date().toISOString();
  s.status = s.status || 'new';
  list.unshift(s);
  all._suggestions = all._suggestions || {};
  all._suggestions[site] = list.slice(0, 100);
  await writeJson(LOG_PATH, all);
  return s;
}
async function listSuggestions(site) {
  var all = await loadState();
  return (all._suggestions && all._suggestions[site]) || [];
}
async function setSuggestionStatus(site, id, status) {
  var all = await loadState();
  var list = (all._suggestions && all._suggestions[site]) || [];
  var s = list.filter(function (x) { return x.id === id; })[0];
  if (!s) return null;
  s.status = status; s.statusAt = new Date().toISOString();
  await writeJson(LOG_PATH, all);
  return s;
}
// New suggestions not yet in an update email, and marking them once the
// email has gone out (so each goes in exactly one).
async function pendingForDigest(site) {
  var list = await listSuggestions(site);
  return list.filter(function (x) { return x.status === 'new' && !x.inDigest; });
}
async function markInDigest(site, ids) {
  if (!ids || !ids.length) return;
  var all = await loadState();
  var list = (all._suggestions && all._suggestions[site]) || [];
  list.forEach(function (x) { if (ids.indexOf(x.id) !== -1) x.inDigest = new Date().toISOString(); });
  await writeJson(LOG_PATH, all);
}

module.exports = {
  addSuggestion: addSuggestion, listSuggestions: listSuggestions, setSuggestionStatus: setSuggestionStatus, pendingForDigest: pendingForDigest, markInDigest: markInDigest, emailOnPage: emailOnPage,
  classify: classify, draft: draft, lookupOffice: lookupOffice,
  loadState: loadState, appendLog: appendLog, storyKey: storyKey,
  suggestedKeys: suggestedKeys, markSuggested: markSuggested, EMAIL_RE: EMAIL_RE,
  screenRecords: screenRecords, DENIAL_RULES: DENIAL_RULES
};
