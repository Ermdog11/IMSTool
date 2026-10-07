// Text messages for alerts (Jeff, 2026-10-07: "add option for email, text or
// both under each alert category"). Twilio's REST API, no SDK. Switched on by
// three env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either
// TWILIO_FROM (a +1 number) or TWILIO_MESSAGING_SERVICE_SID. Until they're set,
// isConfigured() is false and everyone who chose text keeps getting email.

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID));
}

// US-first: 10 digits gets +1; anything else needs its own + country code.
function normalizePhone(p) {
  var s = String(p || '').trim();
  var digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (/^\+/.test(s)) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '';
}

async function send(to, body) {
  if (!isConfigured()) throw new Error('Texting is not connected');
  var phone = normalizePhone(to);
  if (!phone) throw new Error('Not a valid mobile number: ' + to);
  var sid = process.env.TWILIO_ACCOUNT_SID;
  var form = new URLSearchParams({ To: phone, Body: String(body || '').slice(0, 600) });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM);
  var r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error('Twilio: ' + (d.message || ('HTTP ' + r.status)));
  return { sid: d.sid };
}

// The text version of an alert email: its subject and first link.
function fromEmail(opts) {
  if (opts.sms) return String(opts.sms);
  var link = (String(opts.html || '').match(/href="(https?:\/\/[^"]+)"/) || [])[1] || '';
  return String(opts.subject || '').slice(0, 300) + (link ? '\n' + link : '');
}

module.exports = { isConfigured: isConfigured, normalizePhone: normalizePhone, send: send, fromEmail: fromEmail };
