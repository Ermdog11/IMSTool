// Symmetric encryption for secrets we store per-tenant in Supabase (analytics
// API keys, etc). AES-256-GCM with a server-only key — never sent to the
// browser, never logged.
//
// Env var (set in Vercel -> Project -> Settings -> Environment Variables):
//   ANALYTICS_ENCRYPTION_KEY - 32 random bytes, base64-encoded.
//                              Generate one with: openssl rand -base64 32
//
// Encrypted values are stored as "iv:tag:ciphertext", each base64.

var crypto = require('crypto');

function key() {
  var k = process.env.ANALYTICS_ENCRYPTION_KEY || '';
  if (!k) throw new Error('ANALYTICS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` and add it in Vercel.');
  var buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('ANALYTICS_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32).');
  return buf;
}

function encrypt(plaintext) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  var enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

function decrypt(blob) {
  var parts = String(blob || '').split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted value.');
  var iv = Buffer.from(parts[0], 'base64');
  var tag = Buffer.from(parts[1], 'base64');
  var enc = Buffer.from(parts[2], 'base64');
  var decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function isConfigured() {
  return !!process.env.ANALYTICS_ENCRYPTION_KEY;
}

module.exports = { encrypt: encrypt, decrypt: decrypt, isConfigured: isConfigured };
