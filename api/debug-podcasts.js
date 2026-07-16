module.exports = async function handler(req, res) {
  var key = process.env.LISTEN_API_KEY;
  if (!key) return res.status(200).json({ error: 'LISTEN_API_KEY not set' });

  var log = [];
  try {
    var url = 'https://listen-api.listennotes.com/api/v2/search?q=%22Maryland+Terrapins%22&type=episode&sort_by_date=1&language=English&page_size=5';
    var r = await fetch(url, { headers: { 'X-ListenAPI-Key': key } });
    var text = await r.text();
    var data;
    try { data = JSON.parse(text); } catch(e) { return res.status(200).json({ parseError: e.message, raw: text.substring(0, 500) }); }
    log.push({ status: r.status, ok: r.ok, resultCount: (data.results||[]).length, error: data.detail || null });
    return res.status(200).json({ log: log, firstResult: (data.results||[])[0] || null, rawKeys: Object.keys(data) });
  } catch(e) {
    return res.status(200).json({ fetchError: e.message, log: log });
  }
};
