// AI-assisted calendar: when the newsroom picks "Let the AI help" on the
// Calendar tab (_calendar.js settings.mode = 'ai'), CoPublisher adds on its
// own:
//   - games: once a week (api/heat-spots.js, Monday), a web search for the
//     beat's primary teams' games in the next three weeks (date, time,
//     opponent, TV). Teams come from the beat profile, never hard-coded.
//   - things it notices: every morning (api/coverage-desk.js), the dated
//     upcoming items in the day's rated news (a press conference, a decision
//     date, a hearing, signing day), pulled out by the same extractor the
//     pasted-email path uses.
// Everything lands through _calendar.addAiEvents: future only, never a
// duplicate of what's there, never something a person already deleted, and
// announced in Team Chat like any new calendar item. Best-effort: a failure
// is logged and the day goes on.

var Cal = require('./_calendar');

var GAMES_TOOL = {
  name: 'submit_games',
  description: 'The upcoming games found.',
  input_schema: {
    type: 'object',
    properties: {
      games: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sport: { type: 'string' },
            opponent: { type: 'string', description: 'Opponent name only, e.g. "Rutgers".' },
            home: { type: 'boolean', description: 'true if a home game' },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'Start time HH:MM, 24-hour, Eastern. Empty if not announced.' },
            location: { type: 'string', description: 'Stadium/arena and city, if given.' },
            tv: { type: 'string', description: 'TV/streaming network if announced, else empty.' },
            source_url: { type: 'string', description: 'The official schedule page or article it came from.' }
          },
          required: ['sport', 'opponent', 'home', 'date', 'time', 'location', 'tv', 'source_url']
        }
      }
    },
    required: ['games']
  }
};

function todayStr() { return new Date().toLocaleDateString('en-US', { timeZone: Cal.TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }

// The beat's games in the next 21 days, from the official schedule pages.
async function findGames(beat) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key || !beat || !beat.team) return [];
  var team = beat.team.school || beat.team.name || beat.team.short;
  var sports = (beat.primarySports || []).join(' and ') || 'football and basketball';
  var messages = [{ role: 'user', content: 'Today is ' + todayStr() + '. Find every ' + team + ' ' + sports + ' game scheduled from today through the next 21 days. ' +
    'Use the official athletics schedule page first (the school\'s or team\'s own site), then a major outlet to fill in kickoff/tip times and TV. ' +
    'Include exhibitions and postseason games if scheduled. Times in Eastern. Never guess a date or time: leave time empty if it hasn\'t been announced. Then call submit_games.' }];
  var games = null;
  for (var round = 0; round < 3 && !games; round++) {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, GAMES_TOOL], tool_choice: { type: 'auto' }, messages: messages })
    });
    var d = await r.json();
    if (d.error) throw new Error('Game search: ' + (d.error.message || JSON.stringify(d.error)));
    var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === GAMES_TOOL.name; })[0];
    if (tu) { games = (tu.input && tu.input.games) || []; break; }
    if (d.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: d.content });
  }
  var short = beat.team.short || team;
  return (games || []).map(function (g) {
    var start = Cal.zonedIso(g.date, g.time || '');
    if (!start || !g.opponent) return null;
    var sport = String(g.sport || '').trim();
    return {
      title: (sport ? sport.charAt(0).toUpperCase() + sport.slice(1) + ': ' : '') + (g.home ? String(g.opponent) + ' at ' + short : short + ' at ' + String(g.opponent)).slice(0, 110),
      start: start, allDay: !g.time, end: null, kind: 'game',
      location: String(g.location || '').slice(0, 160),
      note: [g.tv ? 'TV: ' + g.tv : '', g.time ? '' : 'Time not announced yet.'].filter(Boolean).join(' ').slice(0, 240),
      sourceUrl: /^https?:\/\//.test(g.source_url || '') ? String(g.source_url).slice(0, 500) : ''
    };
  }).filter(Boolean);
}

async function addGames(sb) {
  var beat = await require('./_beat').getBeat(sb);
  var games = await findGames(beat);
  return await Cal.addAiEvents(games, { summary: 'Upcoming games CoPublisher found on the schedule.' });
}

// Dated, still-upcoming items in the day's rated news (3+, not recycled).
async function addFromNews(alerts) {
  var items = (alerts || []).filter(function (a) { return a && (a.rating || 0) >= 3 && !a.republished && !a.irrelevant; }).slice(0, 40);
  if (!items.length) return [];
  var text = 'NEWS STORIES (headline, summary, source). Only add items that are still AHEAD of today and that the newsroom would cover or need to be ready for (a press conference, an announcement or decision date, a hearing, a vote, signing day, a media day, a game not on the schedule yet). Skip anything already over.\n\n' +
    items.map(function (a) { return '- ' + a.headline + (a.summary ? ' — ' + a.summary : '') + ' (' + (a.source || '') + ', ' + (a.time || '') + ')'; }).join('\n');
  var got = await Cal.extract(text, {});
  return await Cal.addAiEvents(got.events, { summary: 'Spotted in today\'s news.' });
}

module.exports = { findGames: findGames, addGames: addGames, addFromNews: addFromNews };
