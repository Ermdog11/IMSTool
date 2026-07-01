module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });
  try {
    var body = req.body || {};
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
   'anthropic-beta': 'web-search-2025-03-05'
},
      body: JSON.stringify(body)
    });
    var d = await r.json();
    return res.status(r.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
