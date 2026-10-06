// /api/transcript-library: the newsroom's saved transcripts (_transcript-library.js).
//   GET                      -> { items: [{ id, title, createdAt, source, sourceName, duration, speakers, by, snippet }] }
//   GET ?id=<id>             -> the full transcript { id, title, utterances, text, names, duration, ... }
//   POST { action:'save', id, source, sourceName, sourceUrl, data:{utterances,text,duration,auto}, names }
//                            -> { id, title } (titled by Claude the first time it's saved)
//   POST { action:'update', id, title?, names?, breaks? }  (breaks: AI paragraph starts, /api/transcript-tidy)
//   POST { action:'delete', id }   (whoever made it, or an editor/publisher)
// Same access as Transcribe (tab_transcribe). Fails open without Supabase.
var S = require('./_supabase');
var Lib = require('./_transcript-library');

module.exports = async function handler(req, res) {
  var ctx = null;
  if (S.isConfigured()) {
    try {
      ctx = await S.requireUser(req);
      if (!(await require('./_access').allowed(ctx, 'tab_transcribe'))) return res.status(403).json({ error: 'Your publisher has turned Transcribe off for your role.' });
    } catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  }
  try {
    if (req.method === 'GET') {
      var id = req.query && req.query.id;
      if (id) {
        var doc = await Lib.load(id);
        return doc ? res.status(200).json(doc) : res.status(404).json({ error: 'Not found' });
      }
      return res.status(200).json({ items: await Lib.list() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    var b = req.body || {};
    if (b.action === 'save') {
      var saved = await Lib.save(b, ctx && ctx.user);
      return res.status(200).json({ id: saved.id, title: saved.title, createdAt: saved.createdAt });
    }
    if (b.action === 'update') {
      var up = await Lib.update(String(b.id || ''), { title: b.title, names: b.names, breaks: b.breaks });
      return res.status(200).json({ id: up.id, title: up.title });
    }
    if (b.action === 'delete') {
      var item = await Lib.load(String(b.id || ''));
      if (!item) return res.status(404).json({ error: 'Not found' });
      var mine = !ctx || (item.byId && item.byId === ctx.user.id);
      var rank = { editor: 2, publisher: 3 }[ctx && ctx.membership.role] || 0;
      if (!mine && rank < 2) return res.status(403).json({ error: 'Only whoever made it, or an editor, can delete a transcript.' });
      await Lib.remove(item.id);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
