// Temporary — manual trigger to verify a desktop push actually arrives.
// Delete once confirmed working.
var { sendPush } = require('./_push');

module.exports = async function handler(req, res) {
  try {
    var result = await sendPush({
      title: '✅ IMSTool Test Alert',
      body: 'If you can see this, desktop push notifications are working.',
      url: 'https://ims-tool.vercel.app/',
      tag: 'test-alert'
    });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
