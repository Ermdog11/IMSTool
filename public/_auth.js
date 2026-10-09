// Shared client-side auth for the News Monitor and Content Editor.
//
// Loaded on every gated page AFTER supabase-config.js and the supabase-js UMD
// bundle. Exposes window.IMSAuth.
//
// Design: INERT until the backend is configured. `guard()` asks /api/me whether
// login is switched on; if not, it does nothing and the app works exactly as
// before. It also fails OPEN on any unexpected error, so a bug here can never
// lock anyone out of the tool.

(function () {
  var STATE = { ready: false, configured: false, user: null, role: null, access: null, byline: null, site: null, sites: [], client: null, preview: false };

  // Sections safe to show a signed-out visitor as a read-mostly demo — no drafts,
  // no team/config controls, nothing that emails the publisher or costs real work
  // if someone pokes at it. Everything else still requires sign-in.
  var PUBLIC_PATHS = ['/alerts', '/recruiting', '/trending', '/podcasts', '/youtube', '/bluesky', '/digest'];

  function client() {
    if (STATE.client) return STATE.client;
    if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_PUBLISHABLE_KEY) return null;
    STATE.client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return STATE.client;
  }

  async function token() {
    var c = client();
    if (!c) return null;
    try {
      var res = await c.auth.getSession();
      return (res.data && res.data.session && res.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  // Every same-origin /api/ call carries the sign-in token automatically, so
  // the many plain fetch('/api/...') calls in the pages don't each need
  // changing. (Server routes reject callers who aren't signed in.)
  var rawFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameOrigin = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;
      if (sameOrigin && url.indexOf('/api/me') === -1) {
        var t = await token();
        if (t) {
          init = Object.assign({}, init || {});
          var h = init.headers || {};
          if (typeof Headers !== 'undefined' && h instanceof Headers) { if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + t); }
          else if (!h.Authorization) init.headers = Object.assign({}, h, { Authorization: 'Bearer ' + t });
          // Which newsroom, for people in more than one (api/_site.js).
          var cs = chosenSite();
          if (cs) {
            var h2 = init.headers || {};
            if (typeof Headers !== 'undefined' && h2 instanceof Headers) h2.set('X-Site', cs);
            else init.headers = Object.assign({}, h2, { 'X-Site': cs });
          }
        }
      }
    } catch (e) { /* never block a request over auth plumbing */ }
    return rawFetch(input, init);
  };

  // The newsroom picked in the switcher (only set for people in several).
  function chosenSite() { try { return localStorage.getItem('cp-site') || ''; } catch (e) { return ''; } }
  function chooseSite(slug) {
    try { if (slug) localStorage.setItem('cp-site', slug); else localStorage.removeItem('cp-site'); } catch (e) {}
    location.reload();
  }

  // Signed in, but not part of any newsroom: start one (api/newsroom-create)
  // and go straight into the setup wizard. Multi-newsroom, 2026-10-06.
  function showNoNewsroom(me) {
    function esc(x) { var d = document.createElement('div'); d.textContent = x == null ? '' : String(x); return d.innerHTML; }
    var wrap = document.createElement('div');
    wrap.id = 'cp-nonewsroom';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f7f6f2;display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;overflow:auto;font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1a1a1a';
    wrap.innerHTML = '<div style="background:#fff;border:1px solid #e5e2da;border-radius:12px;max-width:440px;width:100%;padding:26px 24px">' +
      '<h1 style="font-size:24px;margin:0 0 8px">Start your newsroom</h1>' +
      '<p style="color:#555;margin:0 0 18px">You\'re signed in as <b>' + esc(me.user && me.user.email) + '</b> but aren\'t part of a newsroom yet. Name yours and we\'ll walk you through setting up your beat. Joining someone else\'s? Ask its publisher to invite this email, then sign in again.</p>' +
      '<label for="cp-nn-name" style="display:block;font-weight:600;font-size:17px;margin-bottom:6px">Newsroom name</label>' +
      '<input id="cp-nn-name" placeholder="e.g. Hokies Insider" maxlength="80" style="width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:11px;border:1px solid #d6d2c8;border-radius:8px">' +
      '<button id="cp-nn-go" style="margin-top:14px;width:100%;font:inherit;font-weight:700;background:#c8102e;color:#fff;border:0;border-radius:8px;padding:12px;cursor:pointer">Create my newsroom</button>' +
      '<div id="cp-nn-msg" style="margin-top:10px;font-size:13.5px;color:#b42318"></div>' +
      '<button id="cp-nn-out" style="margin-top:16px;background:none;border:0;color:#666;text-decoration:underline;cursor:pointer;font:inherit;font-size:13.5px">Sign out</button></div>';
    document.body.appendChild(wrap);
    var go = document.getElementById('cp-nn-go'), msg = document.getElementById('cp-nn-msg');
    document.getElementById('cp-nn-out').onclick = signOut;
    go.onclick = async function () {
      var name = document.getElementById('cp-nn-name').value.trim();
      if (name.length < 2) { msg.textContent = 'Give your newsroom a name.'; return; }
      go.disabled = true; go.textContent = 'Creating…'; msg.textContent = '';
      try {
        var r = await window.fetch('/api/newsroom-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok || !d.ok) throw new Error(d.error || 'Could not create it');
        try { localStorage.setItem('cp-site', d.site.slug); } catch (e) {}
        location.replace(d.next || '/setup');
      } catch (e) { msg.textContent = e.message; go.disabled = false; go.textContent = 'Create my newsroom'; }
    };
  }

  // fetch() wrapper that adds the bearer token when we have one.
  async function authFetch(url, opts) {
    opts = opts || {};
    var t = await token();
    if (t) {
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t });
    }
    if (chosenSite()) opts.headers = Object.assign({}, opts.headers, { 'X-Site': chosenSite() });
    return rawFetch(url, opts);
  }

  // Call once on page load. Resolves when it's safe to render the page.
  async function guard(opts) {
    opts = opts || {};
    try {
      var t = await token();
      var mh = t ? { Authorization: 'Bearer ' + t } : {};
      if (chosenSite()) mh['X-Site'] = chosenSite();
      var r = await fetch('/api/me', { headers: mh });
      var me = await r.json();

      STATE.configured = !!me.configured;
      if (!me.configured) { STATE.ready = true; showHealthBanner(); return STATE; }        // login not switched on -> business as usual

      if (!me.authenticated) {
        var isPublicPath = PUBLIC_PATHS.indexOf(location.pathname) !== -1;
        if (opts.noRedirect || isPublicPath) { STATE.ready = true; STATE.preview = isPublicPath; return STATE; }
        var next = encodeURIComponent(location.pathname + location.search);
        location.replace('/login?next=' + next);
        return new Promise(function () {});                            // never resolves; page is navigating away
      }

      STATE.user = me.user || null;
      STATE.role = me.role || null;
      STATE.access = me.access || null; // what this role may use (api/_access.js)
      STATE.byline = me.byline || null;
      STATE.site = me.site || null;
      STATE.sites = me.sites || [];
      STATE.beat = me.beat || null;
      // A remembered newsroom this person no longer belongs to: forget it.
      if (chosenSite() && STATE.site && STATE.site.slug !== chosenSite()) { try { localStorage.removeItem('cp-site'); } catch (e) {} }
      if (me.pending && me.canCreate && !opts.allowPending && !/[?&]preview=1/.test(location.search)) {
        showNoNewsroom(me);
        return new Promise(function () {});                            // the page waits behind the newsroom screen
      }
      STATE.ready = true;
      showHealthBanner();
      return STATE;
    } catch (e) {
      // Fail open — never trap the user behind a broken guard.
      console.warn('[IMSAuth] guard failed open:', e && e.message);
      STATE.ready = true;
      return STATE;
    }
  }

  // Red bar at the top of the page while something is broken (Claude credits
  // ran out, a scheduled job keeps failing). See api/_health.js.
  async function showHealthBanner() {
    try {
      if (document.getElementById('cp-health')) return;
      var r = await window.fetch('/api/health');
      if (!r.ok) return;
      var d = await r.json();
      if (!d.problems || !d.problems.length) return;
      var bar = document.createElement('div');
      bar.id = 'cp-health';
      bar.style.cssText = 'background:#dc2626;color:#fff;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;padding:9px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:relative;z-index:200';
      bar.innerHTML = d.problems.map(function (p) {
        var t = document.createElement('span'); t.textContent = '⚠️ ' + p.message;
        return t.outerHTML + (p.link ? ' <a href="' + p.link + '" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline">Fix it</a>' : '');
      }).join('<span style="opacity:.6">·</span>');
      document.body.insertBefore(bar, document.body.firstChild);
    } catch (e) { /* the banner is a nicety; never break the page */ }
  }

  async function signOut() {
    var c = client();
    try { if (c) await c.auth.signOut(); } catch (e) {}
    location.replace('/login');
  }

  // Small user chip appended to a container. No-op unless signed in.
  function mountMenu(containerEl) {
    if (!containerEl || !STATE.user) return;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';
    var who = document.createElement('span');
    who.textContent = (STATE.user.full_name || STATE.user.email || 'Signed in') + (STATE.role ? ' · ' + STATE.role : '');
    who.style.cssText = 'color:rgba(255,255,255,.75);white-space:nowrap;';
    var out = document.createElement('button');
    out.textContent = 'Sign out';
    out.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,.25);color:rgba(255,255,255,.8);border-radius:20px;padding:3px 10px;font-size:11px;cursor:pointer;';
    out.onclick = signOut;
    // Newsroom switcher, only for people in more than one newsroom.
    if (STATE.sites && STATE.sites.length > 1) {
      var sel = document.createElement('select');
      sel.title = 'Switch newsroom';
      sel.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,.25);color:rgba(255,255,255,.85);border-radius:20px;padding:3px 8px;font-size:11px;max-width:160px;';
      STATE.sites.forEach(function (x) {
        var o = document.createElement('option'); o.value = x.slug; o.textContent = x.name; o.style.color = '#000';
        if (STATE.site && STATE.site.slug === x.slug) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { chooseSite(sel.value); };
      wrap.appendChild(sel);
    }
    wrap.appendChild(who); wrap.appendChild(out);
    containerEl.appendChild(wrap);
  }

  window.IMSAuth = {
    state: STATE,
    signOut: signOut,
    guard: guard,
    authFetch: authFetch,
    token: token,
    signOut: signOut,
    showHealthBanner: showHealthBanner,
    mountMenu: mountMenu,
    chooseSite: chooseSite,
    isPublisher: function () { return STATE.role === 'publisher'; },
    isEditor: function () { return STATE.role === 'publisher' || STATE.role === 'editor'; }
  };
})();

// 💬 Feedback (Jeff, 2026-10-09: "Need a feedback tool. Put wherever it makes
// sense"). A small button in the bottom corner of every page that loads this
// file (on phones in the News Monitor it's in the ⋯ More sheet instead, so it
// doesn't sit on the bottom bar). Opens a popup: what kind (broken / idea /
// other) and a message; the page they're on is sent with it. /api/feedback
// saves it and emails CoPublisher AI. Operators also see an Inbox there.
(function () {
  var KINDS = [['bug', '🐞 Something\'s broken'], ['idea', '💡 Idea'], ['other', '💬 Other']];
  var kind = 'bug', box = null;
  function esc(x) { var d = document.createElement('div'); d.textContent = x == null ? '' : String(x); return d.innerHTML; }
  function css() {
    if (document.getElementById('cp-fb-css')) return;
    var st = document.createElement('style'); st.id = 'cp-fb-css';
    st.textContent = '#cp-fb-btn{position:fixed;right:16px;bottom:44px;z-index:250;border:1px solid rgba(0,0,0,.12);background:#111827;color:#fff;border-radius:99px;padding:8px 14px;font:600 13px -apple-system,Segoe UI,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:.88}' +
      '#cp-fb-btn:hover{opacity:1}@media print{#cp-fb-btn{display:none}}@media (max-width:700px){#cp-fb-btn.cp-fb-mnav{display:none}#cp-fb-btn{bottom:calc(14px + env(safe-area-inset-bottom));padding:7px 12px}}' +
      '#cp-fb{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1a1a1a}' +
      '@media (min-width:701px){#cp-fb{align-items:center}}' +
      '#cp-fb .bx{background:#fff;width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));max-height:88vh;overflow-y:auto;box-sizing:border-box}' +
      '@media (min-width:701px){#cp-fb .bx{border-radius:14px}}' +
      '#cp-fb h3{margin:0 0 4px;font-size:18px}#cp-fb p{margin:0 0 12px;color:#555;font-size:13.5px;line-height:1.45}' +
      '#cp-fb .ks{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}#cp-fb .ks button{border:1px solid #d1d5db;background:#fff;border-radius:99px;padding:7px 12px;font:600 13px inherit;cursor:pointer;color:#1a1a1a}' +
      '#cp-fb .ks button.on{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}' +
      '#cp-fb textarea{width:100%;box-sizing:border-box;min-height:130px;border:1px solid #d1d5db;border-radius:10px;padding:10px;font:16px/1.45 inherit;resize:vertical}' +
      '#cp-fb .row{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}' +
      '#cp-fb .go{background:#2563eb;color:#fff;border:0;border-radius:9px;padding:9px 16px;font:600 14px inherit;cursor:pointer}#cp-fb .go:disabled{opacity:.6}' +
      '#cp-fb .ln{background:none;border:0;color:#555;text-decoration:underline;cursor:pointer;font:13px inherit;padding:4px}' +
      '#cp-fb .msg{font-size:13px;margin-right:auto}#cp-fb .it{border-top:1px solid #eee;padding:10px 0;font-size:13.5px}#cp-fb .it.dn{opacity:.55}' +
      '#cp-fb .it small{color:#777;display:block;margin-top:4px;line-height:1.5}#cp-fb .it .tx{white-space:pre-wrap;margin-top:4px}';
    document.head.appendChild(st);
  }
  function close() { if (box) { box.remove(); box = null; } }
  // The Inbox link shows only for operators: the server decides who they are,
  // so ask it once (publishers only; everyone else never could).
  var inboxOk = null;
  async function checkInbox() {
    var A = window.IMSAuth;
    if (inboxOk !== null || !A || (A.state.configured && !A.isPublisher())) return !!inboxOk;
    try { inboxOk = (await fetch('/api/feedback')).ok; } catch (e) { inboxOk = false; }
    return inboxOk;
  }
  function form() {
    kind = 'bug';
    box.querySelector('.bx').innerHTML = '<h3>Send feedback</h3><p>Something broken, confusing, or an idea for CoPublisher? Tell us. It goes straight to the people who build it, along with the page you\'re on, and we\'ll reply by email.</p>' +
      '<div class="ks">' + KINDS.map(function (k) { return '<button type="button" data-k="' + k[0] + '" class="' + (k[0] === kind ? 'on' : '') + '">' + k[1] + '</button>'; }).join('') + '</div>' +
      '<textarea id="cp-fb-t" placeholder="What happened, or what would make this better?"></textarea>' +
      '<div class="row"><span class="msg" id="cp-fb-m"></span><button type="button" class="ln" id="cp-fb-in" style="display:none">Inbox</button>' +
      '<button type="button" class="ln" id="cp-fb-x">Cancel</button><button type="button" class="go" id="cp-fb-go">Send</button></div>';
    box.querySelectorAll('.ks button').forEach(function (b) { b.onclick = function () { kind = b.dataset.k; box.querySelectorAll('.ks button').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    box.querySelector('#cp-fb-x').onclick = close;
    box.querySelector('#cp-fb-in').onclick = inbox;
    checkInbox().then(function (ok) { var l = box && box.querySelector('#cp-fb-in'); if (l && ok) l.style.display = ''; });
    box.querySelector('#cp-fb-go').onclick = send;
    setTimeout(function () { var t = document.getElementById('cp-fb-t'); if (t) t.focus(); }, 30);
  }
  async function send() {
    var t = document.getElementById('cp-fb-t'), m = document.getElementById('cp-fb-m'), go = document.getElementById('cp-fb-go');
    if (t.value.trim().length < 3) { m.textContent = 'Write a little more first.'; m.style.color = '#b91c1c'; return; }
    go.disabled = true; go.textContent = 'Sending…';
    try {
      var r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kind, message: t.value, page: location.href }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      box.querySelector('.bx').innerHTML = '<h3>Thank you 🙏</h3><p>Got it. We read every one, and we\'ll reply by email if we have a question or when it\'s fixed.</p><div class="row"><button type="button" class="go" id="cp-fb-ok">Done</button></div>';
      box.querySelector('#cp-fb-ok').onclick = close;
    } catch (e) { go.disabled = false; go.textContent = 'Send'; m.textContent = 'Couldn\'t send: ' + e.message; m.style.color = '#b91c1c'; }
  }
  async function inbox() {
    var bx = box.querySelector('.bx');
    bx.innerHTML = '<h3>Feedback inbox</h3><p>Loading…</p>';
    try {
      var r = await fetch('/api/feedback'), d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      var lab = { bug: '🐞', idea: '💡', other: '💬' };
      bx.innerHTML = '<h3>Feedback inbox</h3><p>' + d.open + ' open · newest first. Reply from the email each one came in.</p>' +
        (d.items.length ? d.items.map(function (x) {
          return '<div class="it' + (x.done ? ' dn' : '') + '">' + (lab[x.kind] || '💬') + ' <b>' + esc(x.name || x.email || 'Someone') + '</b>' + (x.siteName ? ' · ' + esc(x.siteName) : '') +
            '<div class="tx">' + esc(x.message) + '</div><small>' + esc(new Date(x.at).toLocaleString()) + (x.email ? ' · <a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a>' : '') +
            (x.page ? ' · <a href="' + esc(x.page) + '" target="_blank" rel="noopener">page</a>' : '') +
            ' · <button type="button" class="ln" data-id="' + esc(x.id) + '" data-d="' + (x.done ? '0' : '1') + '">' + (x.done ? 'Reopen' : 'Mark done') + '</button></small></div>';
        }).join('') : '<p>Nothing yet.</p>') +
        '<div class="row"><button type="button" class="ln" id="cp-fb-back">Back</button><button type="button" class="go" id="cp-fb-c">Close</button></div>';
      bx.querySelectorAll('button[data-id]').forEach(function (b) {
        b.onclick = async function () { await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'done', id: b.dataset.id, done: b.dataset.d === '1' }) }); inbox(); };
      });
      bx.querySelector('#cp-fb-back').onclick = form; bx.querySelector('#cp-fb-c').onclick = close;
    } catch (e) { bx.innerHTML = '<h3>Feedback inbox</h3><p>Couldn\'t load it: ' + esc(e.message) + '</p><div class="row"><button type="button" class="ln" id="cp-fb-back">Back</button></div>'; bx.querySelector('#cp-fb-back').onclick = form; }
  }
  function open() {
    css(); close();
    var A = window.IMSAuth;
    box = document.createElement('div'); box.id = 'cp-fb';
    box.innerHTML = '<div class="bx" role="dialog" aria-label="Send feedback"></div>';
    box.onclick = function (e) { if (e.target === box) close(); };
    document.body.appendChild(box);
    if (A && A.state.configured && !A.state.user) {
      box.querySelector('.bx').innerHTML = '<h3>Send feedback</h3><p>Sign in first so we know who to reply to.</p><div class="row"><button type="button" class="ln" id="cp-fb-x">Cancel</button><a class="go" href="/login" style="text-decoration:none">Sign in</a></div>';
      box.querySelector('#cp-fb-x').onclick = close; return;
    }
    form();
  }
  function mount() {
    if (/^\/login/.test(location.pathname) || document.getElementById('cp-fb-btn')) return;
    css();
    var b = document.createElement('button');
    b.id = 'cp-fb-btn'; b.type = 'button'; b.textContent = '💬 Feedback'; b.title = 'Tell us what\'s broken or what would make CoPublisher better';
    if (document.querySelector('.mnav')) b.className = 'cp-fb-mnav';
    b.onclick = open;
    document.body.appendChild(b);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box) close(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.CPFeedback = { open: open };
})();

// Phone app (PWA): register the service worker on every page so Android and
// iPhone can install CoPublisher to the home screen (public/manifest.json,
// public/sw.js). Best-effort; does nothing in browsers without support.
(function () {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
})();
