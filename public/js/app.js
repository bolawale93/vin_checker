// Application shell, authentication flow and hash router.
import { html, mount, $, on } from './html.js';
import { get, post, setAuthHandlers, ApiError } from './api.js';
import { toast, loading } from './ui.js';

export const ctx = { user: null, config: null, pub: null };

const ROUTES = [
  { re: /^\/$/, view: 'search', nav: 'search' },
  { re: /^\/searches\/(\d+)$/, view: 'search-detail', nav: 'history', params: ['id'] },
  { re: /^\/searches\/(\d+)\/items\/(\d+)$/, view: 'vehicle', nav: 'history', params: ['id', 'itemId'] },
  { re: /^\/history$/, view: 'history', nav: 'history' },
  { re: /^\/admin(?:\/(users|audit|settings))?$/, view: 'admin', nav: 'admin', params: ['tab'], role: 'admin' },
  { re: /^\/account$/, view: 'account', nav: 'account' },
];

let cleanup = null;
let routeToken = 0;

export const canWrite = () => ['admin', 'staff'].includes(ctx.user?.role);

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  return { path: path || '/', query: new URLSearchParams(query) };
}

async function route() {
  if (!ctx.user) return;
  const token = ++routeToken;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { path, query } = parseHash();
  const view = $('#view');
  let match = null;
  let route = null;
  for (const r of ROUTES) {
    match = r.re.exec(path);
    if (match) { route = r; break; }
  }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === route?.nav));
  if (!route) {
    mount(view, html`<div class="card"><div class="empty"><h3>Page not found</h3><p><a href="#/">Go to VIN search</a></p></div></div>`);
    return;
  }
  if (route.role && ctx.user.role !== route.role) {
    mount(view, html`<div class="card"><div class="empty"><h3>Access restricted</h3><p>This area is available to administrators only.</p></div></div>`);
    return;
  }
  const params = {};
  (route.params || []).forEach((p, i) => { params[p] = match[i + 1]; });
  mount(view, loading());
  try {
    const mod = await import(`./views/${route.view}.js`);
    if (token !== routeToken) return;
    const result = await mod.default(view, params, query);
    if (token !== routeToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    view.querySelector('h1')?.focus?.({ preventScroll: true });
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    mount(view, html`<div class="card"><div class="empty"><h3>Unable to load this page</h3><p>${err.message}</p>
      <button class="btn" data-action="reload">Try again</button></div></div>`);
  }
}

function renderShell() {
  const { user, config, pub } = ctx;
  const logo = pub.hasLogo
    ? html`<img src="/api/branding/logo" alt="">`
    : html`<span class="brand-logo-ph" aria-hidden="true">LOGO</span>`;
  mount($('#app'), html`
    ${pub.classification ? html`<div class="classification">${pub.classification}</div>` : ''}
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/">${logo}
          <span class="brand-text">
            <span class="brand-agency">${config.agencyName || 'Agency name not configured'}</span>
            <span class="brand-app">VIN Checker</span>
          </span>
        </a>
        <nav class="nav" aria-label="Main">
          <a href="#/" data-nav="search">VIN search</a>
          <a href="#/history" data-nav="history">Search history</a>
          ${user.role === 'admin' ? html`<a href="#/admin/users" data-nav="admin">Administration</a>` : ''}
        </nav>
        <div class="userbox">
          <a href="#/account" data-nav="account" title="My account">${user.fullName}</a>
          <span class="role">${user.role}</span>
          <button class="btn btn-sm btn-primary" data-action="logout">Sign out</button>
        </div>
      </div>
    </header>
    ${config.sampleMode ? html`<div class="sample-banner" role="note"><div><strong>Development sample data is enabled.</strong>
      Results labelled SAMPLE are fictitious test records and are not verified vehicle information.
      An administrator can connect an authorised data provider — see the README.</div></div>` : ''}
    <main id="view" tabindex="-1"></main>`);
}

function renderLogin(message) {
  const { pub } = ctx;
  mount($('#app'), html`
    <div class="login-wrap">
      <div class="login-card">
        ${pub.hasLogo ? html`<div class="logo"><img src="/api/branding/logo" alt="Agency logo"></div>` : ''}
        <h1>VIN Checker</h1>
        <p class="agency">${pub.agencyName || 'Authorised staff only'}</p>
        ${message ? html`<div class="notice notice-info">${message}</div>` : ''}
        ${pub.needsSetup ? html`<div class="notice notice-warn"><strong>No accounts yet</strong>
          Create the first administrator on the server with <code>npm run create-admin</code>.</div>` : ''}
        <form id="login-form" novalidate>
          <div class="field"><label for="u">Username</label><input type="text" id="u" name="username" autocomplete="username" required autofocus></div>
          <div class="field"><label for="p">Password</label><input type="password" id="p" name="password" autocomplete="current-password" required></div>
          <div class="notice notice-bad hidden" id="login-error" role="alert"></div>
          <button class="btn btn-primary btn-lg" type="submit">Sign in</button>
        </form>
        <p class="muted small mt-1">Use of this system is restricted to authorised personnel. Activity is recorded.</p>
      </div>
    </div>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = $('#login-error');
    err.classList.add('hidden');
    btn.disabled = true;
    try {
      const { user } = await post('/api/auth/login', Object.fromEntries(new FormData(e.target)));
      ctx.user = user;
      await afterLogin();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderForcedPasswordChange() {
  mount($('#app'), html`<div class="login-wrap"><div class="login-card" id="forced"></div></div>`);
  const mod = await import('./views/account.js');
  await mod.default($('#forced'), { forced: true, onDone: afterLogin });
}

async function afterLogin() {
  if (ctx.user.mustChangePassword) return renderForcedPasswordChange();
  try {
    ctx.config = await get('/api/config');
  } catch (err) {
    if (err instanceof ApiError && err.data?.code === 'MUST_CHANGE_PASSWORD') {
      ctx.user.mustChangePassword = true;
      return renderForcedPasswordChange();
    }
    throw err;
  }
  ctx.user = ctx.config.user;
  renderShell();
  route();
}

export async function refreshPublic() {
  ctx.pub = await get('/api/public');
}

async function boot() {
  setAuthHandlers({
    onAuthLost: () => {
      if (!ctx.user) return;
      ctx.user = null;
      if (cleanup) { cleanup(); cleanup = null; }
      renderLogin('Your session has ended. Please sign in again.');
    },
    onMustChangePassword: () => {
      if (ctx.user) { ctx.user.mustChangePassword = true; renderForcedPasswordChange(); }
    },
  });
  try {
    await refreshPublic();
  } catch (err) {
    mount($('#app'), html`<div class="login-wrap"><div class="login-card"><h1>VIN Checker</h1>
      <div class="notice notice-bad">${err.message}</div></div></div>`);
    return;
  }
  try {
    ctx.user = (await get('/api/auth/me')).user;
  } catch {
    return renderLogin();
  }
  await afterLogin();
}

// Global actions
on(document, 'click', '[data-action=logout]', async () => {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  ctx.user = null;
  if (cleanup) { cleanup(); cleanup = null; }
  renderLogin('You have signed out.');
});
on(document, 'click', '[data-action=reload]', () => route());

window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(e.reason?.message || 'Unexpected error', 'error');
});

boot();
