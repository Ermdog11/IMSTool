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
  var STATE = { ready: false, configured: false, user: null, role: null, byline: null, site: null, client: null, preview: false };

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

  // fetch() wrapper that adds the bearer token when we have one.
  async function authFetch(url, opts) {
    opts = opts || {};
    var t = await token();
    if (t) {
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t });
    }
    return fetch(url, opts);
  }

  // Call once on page load. Resolves when it's safe to render the page.
  async function guard(opts) {
    opts = opts || {};
    try {
      var t = await token();
      var r = await fetch('/api/me', { headers: t ? { Authorization: 'Bearer ' + t } : {} });
      var me = await r.json();

      STATE.configured = !!me.configured;
      if (!me.configured) { STATE.ready = true; return STATE; }        // login not switched on -> business as usual

      if (!me.authenticated) {
        var isPublicPath = PUBLIC_PATHS.indexOf(location.pathname) !== -1;
        if (opts.noRedirect || isPublicPath) { STATE.ready = true; STATE.preview = isPublicPath; return STATE; }
        var next = encodeURIComponent(location.pathname + location.search);
        location.replace('/login?next=' + next);
        return new Promise(function () {});                            // never resolves; page is navigating away
      }

      STATE.user = me.user || null;
      STATE.role = me.role || null;
      STATE.byline = me.byline || null;
      STATE.site = me.site || null;
      STATE.ready = true;
      return STATE;
    } catch (e) {
      // Fail open — never trap the user behind a broken guard.
      console.warn('[IMSAuth] guard failed open:', e && e.message);
      STATE.ready = true;
      return STATE;
    }
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
    mountMenu: mountMenu,
    isPublisher: function () { return STATE.role === 'publisher'; },
    isEditor: function () { return STATE.role === 'publisher' || STATE.role === 'editor'; }
  };
})();
