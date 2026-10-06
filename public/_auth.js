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
  var STATE = { ready: false, configured: false, user: null, role: null, access: null, byline: null, site: null, client: null, preview: false };

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
        }
      }
    } catch (e) { /* never block a request over auth plumbing */ }
    return rawFetch(input, init);
  };

  // fetch() wrapper that adds the bearer token when we have one.
  async function authFetch(url, opts) {
    opts = opts || {};
    var t = await token();
    if (t) {
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t });
    }
    return rawFetch(url, opts);
  }

  // Call once on page load. Resolves when it's safe to render the page.
  async function guard(opts) {
    opts = opts || {};
    try {
      var t = await token();
      var r = await fetch('/api/me', { headers: t ? { Authorization: 'Bearer ' + t } : {} });
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
    wrap.appendChild(who); wrap.appendChild(out);
    containerEl.appendChild(wrap);
  }

  window.IMSAuth = {
    state: STATE,
    guard: guard,
    authFetch: authFetch,
    token: token,
    signOut: signOut,
    showHealthBanner: showHealthBanner,
    mountMenu: mountMenu,
    isPublisher: function () { return STATE.role === 'publisher'; },
    isEditor: function () { return STATE.role === 'publisher' || STATE.role === 'editor'; }
  };
})();

// Phone app (PWA): register the service worker on every page so Android and
// iPhone can install CoPublisher to the home screen (public/manifest.json,
// public/sw.js). Best-effort; does nothing in browsers without support.
(function () {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
})();
