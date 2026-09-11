// The newsroom knowledge base: every piece that passes through the Content
// Editor gets stored and indexed here (Supabase content_items), privately per
// site. Powers (as they're built): richer style profiles, internal linking
// from the full archive, the archive fact-checker, and analytics context.
//
// Best-effort by design — a knowledge-base write must never break saving a
// draft. If Supabase isn't configured, or anything here throws, we log and
// move on; the draft itself (Blob storage) is unaffected either way.

var S = require('./_supabase');
var SITE_SLUG = 'insidemdsports';
var siteIdCache = null;

async function resolveSiteId(sb) {
  if (siteIdCache) return siteIdCache;
  var r = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
  if (r.error || !r.data) throw new Error('Knowledge base: site row missing (run db/schema.sql)');
  siteIdCache = r.data.id;
  return siteIdCache;
}

// Strip HTML down to plain-ish text for storage/search. The draft's .html
// already has house-style copy + any inserts spliced in; that's fine to index
// as-is (inserts are usually short promo blocks, harmless noise in search).
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Upsert one draft into the knowledge base, keyed by draft id so repeated
// saves of the same piece update one row instead of piling up duplicates.
async function upsertFromDraft(doc) {
  if (!S.isConfigured()) return { skipped: 'not configured' };
  try {
    var sb = S.admin();
    var siteId = await resolveSiteId(sb);
    var body = htmlToText(doc.html);
    if (!body) return { skipped: 'empty body' };

    var row = {
      site_id: siteId,
      draft_id: doc.id || null,
      writer_name: doc.writerName || null,
      source: 'copydesk',
      headline: doc.headline || null,
      body: body.slice(0, 50000),
      metadata: {
        tier: doc.tier || null,
        status: doc.status || null,
        headlines: doc.headlines || [],
        notes: doc.notes || []
      },
      updated_at: new Date().toISOString()
    };

    var up = await sb.from('content_items').upsert(row, { onConflict: 'site_id,draft_id' }).select('id').single();
    if (up.error) throw new Error(up.error.message);
    return { ok: true, id: up.data && up.data.id };
  } catch (e) {
    console.error('Knowledge base upsert failed (non-fatal):', e.message);
    return { error: e.message };
  }
}

module.exports = { upsertFromDraft: upsertFromDraft, htmlToText: htmlToText };
