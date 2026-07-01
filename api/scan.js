module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: 'List 10 recent Maryland Terrapins athletics news stories. For each include: headline, summary, category (recruiting/football/basketball/other-sport/alumni/social/podcast), sport, source, time, and rating 1-5. Return ONLY a valid JSON array, no other text.' }]
      })
    });
    var d = await r.json();
    return res.status(r.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
