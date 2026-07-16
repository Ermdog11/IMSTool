module.exports = async function handler(req, res) {
  var key = process.env.LISTEN_API_KEY;
  if (!key) return res.status(200).json({ error: 'LISTEN_API_KEY not set' });

  try {
    // Test with no date filter first to confirm API works
    var url = 'https://listen-api.listennotes.com/api/v2/search?q=%22Maryland+Terrapins%22&type=episode&sort_by_date=1&page_size=3';
    var r = await fetch(url, { headers: { 'X-ListenAPI-Key': key } });
    var data = await r.json();
    return res.status(200).json({ status: r.status, keyPrefix: key.substring(0,8) + '...', resultCount: (data.results||[]).length, firstResult: (data.results||[])[0] || null, error: data.detail || data.error || null });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
