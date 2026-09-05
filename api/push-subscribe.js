// Called by the dashboard when the editor clicks "Enable desktop alerts"
// (subscribe) or when a browser drops a stale subscription (unsubscribe).
var push = require('./_push.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  var body = req.body || {};

  try {
    if (body.action === 'unsubscribe') {
      if (!body.endpoint) return res.status(400).json({ error: 'endpoint required' });
      await push.removeSubscription(body.endpoint);
      return res.status(200).json({ ok: true });
    }
    if (!body.subscription || !body.subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
    var count = await push.addSubscription(body.subscription);
    return res.status(200).json({ ok: true, totalSubscriptions: count });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
