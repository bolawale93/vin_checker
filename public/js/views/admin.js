// Administration: users and roles, audit log, branding and provider status.
import { html, mount, $, on } from '../html.js';
import { get, post, put, patch, del, qs } from '../api.js';
import { ctx, navigate, refreshPublic } from '../app.js';
import { toast, dialog, confirmDialog, fmtDateTime, loading, busy } from '../ui.js';

const ROLE_INFO = {
  admin: 'Administrator — all functions, including users, audit log and settings',
  staff: 'Staff — run checks, record inspection details, download reports',
  viewer: 'Viewer — read-only access to history and reports',
};

export default async function adminView(el, { tab = 'users' }, query) {
  mount(el, html`
    <div class="page-head"><div><h1 tabindex="-1">Administration</h1></div></div>
    <div class="card">
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="${tab === 'users'}" data-tab="users">Users and roles</button>
        <button role="tab" aria-selected="${tab === 'audit'}" data-tab="audit">Audit log</button>
        <button role="tab" aria-selected="${tab === 'settings'}" data-tab="settings">Branding and data sources</button>
      </div>
      <div id="admin-body">${loading()}</div>
    </div>`);
  const body = $('#admin-body', el);
  const offs = [on(el, 'click', '[data-tab]', (_e, b) => navigate(`/admin/${b.dataset.tab}`))];
  const views = { users: usersTab, audit: auditTab, settings: settingsTab };
  try {
    const off = await views[tab](body, query);
    if (off) offs.push(off);
  } catch (err) {
    mount(body, html`<div class="empty"><h3>Could not load</h3><p>${err.message}</p></div>`);
  }
  return () => offs.forEach((o) => o());
}

// ---------------------------------------------------------------------------
async function usersTab(body) {
  async function render() {
    const { users } = await get('/api/admin/users');
    mount(body, html`
      <div class="card-body inline">
        <button class="btn btn-primary" data-action="add-user">+ Add user</button>
        <span class="muted small">New users must change their password at first sign-in. Disabling a user signs them out immediately.</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${users.map((u) => html`
          <tr>
            <td><strong>${u.fullName}</strong>${u.id === ctx.user.id ? html` <span class="pill pill-info">You</span>` : ''}</td>
            <td class="mono">${u.username}</td>
            <td><select data-role="${u.id}" aria-label="Role for ${u.username}">
              ${['admin', 'staff', 'viewer'].map((r) => html`<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`)}</select></td>
            <td>${u.active ? html`<span class="pill pill-ok">Active</span>` : html`<span class="pill pill-neutral">Disabled</span>`}
              ${u.mustChangePassword ? html`<div class="small muted">Must change password</div>` : ''}</td>
            <td class="nowrap">${u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : html`<span class="missing">Never</span>`}</td>
            <td class="nowrap">${fmtDateTime(u.createdAt)}</td>
            <td class="nowrap">
              <button class="btn btn-sm" data-rename="${u.id}" data-name="${u.fullName}">Rename</button>
              <button class="btn btn-sm" data-reset="${u.id}" data-username="${u.username}">Reset password</button>
              <button class="btn btn-sm ${u.active ? 'btn-danger' : ''}" data-toggle="${u.id}" data-active="${u.active ? '1' : ''}" data-username="${u.username}">${u.active ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>`)}</tbody>
      </table></div>
      <div class="card-body small muted">${Object.entries(ROLE_INFO).map(([k, v]) => html`<div><strong>${k}</strong>: ${v.split(' — ')[1]}</div>`)}</div>`);
  }
  await render();

  const withValidate = (opts, onSubmit) => dialog({ ...opts, onSubmit });

  const offs = [
    on(body, 'click', '[data-action=add-user]', async () => {
      const r = await withValidate({
        title: 'Add user',
        submitLabel: 'Create user',
        body: html`<div class="form-grid">
          <div class="field span-all"><label for="nu-name" class="req">Full name</label><input id="nu-name" name="fullName" type="text" maxlength="120" required></div>
          <div class="field"><label for="nu-user" class="req">Username</label><input id="nu-user" name="username" type="text" maxlength="64" autocomplete="off" required></div>
          <div class="field"><label for="nu-role" class="req">Role</label><select id="nu-role" name="role">
            <option value="staff">Staff</option><option value="viewer">Viewer (read-only)</option><option value="admin">Administrator</option></select></div>
          <div class="field span-all"><label for="nu-pw" class="req">Temporary password</label><input id="nu-pw" name="password" type="password" autocomplete="new-password" required>
            <span class="hint">At least 10 characters with three of: lowercase, uppercase, digits, symbols. The user must change it at first sign-in.</span></div>
        </div>`,
      }, (data) => post('/api/admin/users', { fullName: data.fullName, username: data.username, role: data.role, password: data.password }));
      if (r) { toast('User created.', 'ok'); await render(); }
    }),
    on(body, 'change', '[data-role]', async (_e, s) => {
      try {
        await patch(`/api/admin/users/${s.dataset.role}`, { role: s.value });
        toast('Role updated. The user has been signed out so the change takes effect.', 'ok');
      } catch (err) { toast(err.message, 'error'); }
      await render();
    }),
    on(body, 'click', '[data-rename]', async (_e, b) => {
      const r = await withValidate({
        title: 'Rename user',
        body: html`<div class="field"><label for="rn">Full name</label><input id="rn" name="fullName" type="text" maxlength="120" value="${b.dataset.name}"></div>`,
      }, (data) => patch(`/api/admin/users/${b.dataset.rename}`, { fullName: data.fullName }));
      if (r) { toast('Name updated.', 'ok'); await render(); }
    }),
    on(body, 'click', '[data-reset]', async (_e, b) => {
      const r = await withValidate({
        title: `Reset password — ${b.dataset.username}`,
        submitLabel: 'Reset password',
        body: html`<div class="field"><label for="rp">New temporary password</label><input id="rp" name="password" type="password" autocomplete="new-password">
          <span class="hint">The user will be signed out and must choose a new password at next sign-in.</span></div>`,
      }, (data) => post(`/api/admin/users/${b.dataset.reset}/password`, { password: data.password }));
      if (r) toast('Password reset.', 'ok');
    }),
    on(body, 'click', '[data-toggle]', async (_e, b) => {
      const active = !!b.dataset.active;
      if (active && !(await confirmDialog('Disable user?', `${b.dataset.username} will be signed out and unable to sign in. Their past checks remain in the history.`, { confirmLabel: 'Disable', danger: true }))) return;
      try {
        await patch(`/api/admin/users/${b.dataset.toggle}`, { active: !active });
        toast(active ? 'User disabled.' : 'User enabled.', 'ok');
      } catch (err) { toast(err.message, 'error'); }
      await render();
    }),
  ];
  return () => offs.forEach((o) => o());
}

// ---------------------------------------------------------------------------
const ACTION_LABELS = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in', 'auth.logout': 'Signed out', 'auth.password_change': 'Changed own password',
  'search.create': 'Ran VIN check', 'search.retry': 'Retried lookups', 'details.update': 'Edited vehicle details',
  'details.apply_common': 'Applied batch details', 'details.common_update': 'Saved batch details', 'report.vehicle': 'Generated vehicle report',
  'report.batch': 'Generated batch report', 'report.zip': 'Downloaded report pack (ZIP)', 'user.create': 'Created user', 'user.update': 'Updated user',
  'user.password_reset': 'Reset user password', 'user.admin_reset_cli': 'Admin reset via CLI', 'settings.update': 'Changed settings',
  'settings.logo_upload': 'Uploaded logo', 'settings.logo_remove': 'Removed logo',
};

async function auditTab(body, query) {
  const f = { action: query.get('action') || '', user: query.get('user') || '', q: query.get('q') || '', from: query.get('from') || '', to: query.get('to') || '', page: query.get('page') || '' };
  const data = await get(`/api/admin/audit${qs(f)}`);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const summary = (d) => {
    if (!d) return '';
    return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
  };
  mount(body, html`
    <form class="card-body" id="audit-filters">
      <div class="form-grid">
        <div class="field"><label for="a-action">Action</label><select id="a-action" name="action"><option value="">All actions</option>
          ${data.actions.map((a) => html`<option value="${a}" ${a === f.action ? 'selected' : ''}>${ACTION_LABELS[a] || a}</option>`)}</select></div>
        <div class="field"><label for="a-user">User</label><input id="a-user" name="user" type="search" value="${f.user}"></div>
        <div class="field"><label for="a-q">Reference / VIN / details</label><input id="a-q" name="q" type="search" value="${f.q}"></div>
        <div class="field"><label for="a-from">From</label><input id="a-from" name="from" type="date" value="${f.from}"></div>
        <div class="field"><label for="a-to">To</label><input id="a-to" name="to" type="date" value="${f.to}"></div>
      </div>
      <div class="inline mt-1"><button class="btn btn-primary" type="submit">Filter</button><a class="btn" href="#/admin/audit">Clear</a>
        <span class="muted small">The audit log is append-only and cannot be edited from the application.</span></div>
    </form>
    ${data.rows.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Subject</th><th>Details</th><th>IP address</th></tr></thead>
      <tbody>${data.rows.map((r) => html`<tr>
        <td class="nowrap">${fmtDateTime(r.at)}</td>
        <td>${r.username || html`<span class="missing">—</span>`}</td>
        <td><span class="pill ${r.action.includes('failed') ? 'pill-bad' : 'pill-neutral'}">${ACTION_LABELS[r.action] || r.action}</span></td>
        <td class="mono small">${r.entity_id || ''}</td>
        <td><div class="details-json">${summary(r.details)}</div></td>
        <td class="small">${r.ip || ''}</td>
      </tr>`)}</tbody></table></div>
      <div class="pager"><span>${data.total} entries · page ${data.page} of ${pages}</span>
        <span class="inline">
          <button class="btn btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>‹ Previous</button>
          <button class="btn btn-sm" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>Next ›</button></span></div>`
      : html`<div class="empty"><h3>No audit entries match</h3></div>`}`);

  const go = (page) => {
    const params = Object.fromEntries(new FormData($('#audit-filters', body)));
    params.page = page > 1 ? page : '';
    navigate(`/admin/audit${qs(params)}`);
  };
  const offs = [
    on(body, 'submit', '#audit-filters', (e) => { e.preventDefault(); go(1); }),
    on(body, 'click', '[data-page]', (_e, b) => go(Number(b.dataset.page))),
  ];
  return () => offs.forEach((o) => o());
}

// ---------------------------------------------------------------------------
const COVERAGE = {
  specs: 'specifications', accidents: 'accidents', statusRecords: 'theft/salvage/write-off status',
  ownership: 'ownership', maintenance: 'maintenance/inspections', recalls: 'model-level recalls',
};

async function settingsTab(body) {
  let { brand, hasLogo } = await get('/api/admin/settings');
  const va = await get('/api/admin/providers/vinaudit');
  ctx.config = await get('/api/config'); // fresh provider status
  const providers = ctx.config.providers;
  const logoUrl = () => `/api/branding/logo?t=${Date.now()}`;

  mount(body, html`
    <form class="card-body" id="brand-form" novalidate>
      <h2>Agency branding</h2>
      <p class="muted small">Shown in the application header and on every PDF report.</p>
      <div class="form-grid">
        <div class="field span-all"><label for="b-name">Agency name</label><input id="b-name" name="agencyName" type="text" maxlength="300" value="${brand.agencyName}"></div>
        <div class="field span-all"><label for="b-sub">Department / address line</label><input id="b-sub" name="agencySubtitle" type="text" maxlength="300" value="${brand.agencySubtitle}"></div>
        <div class="field"><label for="b-class">Protective marking</label><input id="b-class" name="classification" type="text" maxlength="300" value="${brand.classification}" placeholder="e.g. OFFICIAL — SENSITIVE">
          <span class="hint">Shown as a banner in the app and in report headers and footers.</span></div>
        <div class="field"><label for="b-foot">Report footer text</label><input id="b-foot" name="footerText" type="text" maxlength="300" value="${brand.footerText}" placeholder="e.g. For authorised use only"></div>
      </div>
      <div class="inline mt-1"><button class="btn btn-primary" type="submit">Save branding</button></div>
    </form>
    <div class="card-body">
      <h3>Logo</h3>
      <p class="muted small">PNG or JPEG, up to 2 MB. A square or landscape logo on a white or transparent background works best.</p>
      <div class="inline">
        <div id="logo-preview">${hasLogo ? html`<img src="${logoUrl()}" alt="Current logo" class="logo-preview">` : html`<span class="brand-logo-ph logo-ph-dark">No logo</span>`}</div>
        <label class="btn" for="logo-file">Upload logo…</label>
        <input id="logo-file" type="file" accept="image/png,image/jpeg" class="sr-only">
        ${hasLogo ? html`<button class="btn btn-danger" data-action="remove-logo">Remove logo</button>` : ''}
      </div>
    </div>
    <div class="card-body">
      <h2>Data sources</h2>
      <p class="muted small">Providers are configured on the server in the <code>.env</code> file (never in the browser). See “Connecting a data provider” in the README.</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Provider</th><th>Trust level</th><th>Provides</th><th>Status</th></tr></thead>
        <tbody>${providers.map((p) => html`<tr>
          <td><strong>${p.name}</strong><div class="small muted mono">${p.id}</div></td>
          <td>${p.trust === 'sample' ? html`<span class="pill pill-sample">Sample — not verified</span>` : p.trust === 'derived' ? 'Derived from VIN' : p.trust === 'verified' ? 'Authorised source' : p.trust || '—'}</td>
          <td class="small">${(p.coverage || []).map((c) => COVERAGE[c] || c).join(', ')}</td>
          <td>${p.active ? html`<span class="pill pill-ok">Active</span>` : html`<span class="pill pill-bad">Inactive</span> <span class="small">${p.problem}</span>`}</td>
        </tr>`)}</tbody>
      </table></div>
      ${!ctx.config.liveHistoryConfigured ? html`<div class="notice notice-warn mt-1 mb-0"><strong>No live vehicle-history provider is connected.</strong>
        ${providers.some((p) => p.active && p.kind === 'decoder' && p.trust !== 'derived') ? 'VINs are decoded (make, model, year, specifications), but' : 'Checks can only analyse VIN structure, and'}
        accident, damage, theft and ownership history is reported as “not checked”. Connecting a history source needs an authorised provider
        agreement and credentials — enter VinAudit credentials below, or configure another authorised provider on the server
        (<code>HISTORY_API_*</code> / <code>HTTP_&lt;NAME&gt;_*</code>).</div>` : ''}
    </div>
    <form class="card-body" id="vinaudit-form" novalidate>
      <h2>Accident, damage and theft history — VinAudit</h2>
      <p class="muted small">VinAudit is an NMVTIS-approved data provider for vehicles titled in the <strong>USA and Canada</strong>
        (most imported used vehicles). Reports include police crash records, theft and recovery (NICB), junk/salvage/insurance
        total-loss records, salvage-auction damage, title brands (flood, rebuilt, odometer), title and odometer history, and liens.
        It is a <strong>paid service</strong>: create an API-enabled account at vinaudit.com, then enter its credentials here.
        Vehicles never titled in the USA or Canada will return “no records”.</p>
      ${!va.enabledInConfig ? html`<div class="notice notice-warn">“vinaudit” is not in <code>DATA_PROVIDERS</code> in the server's .env, so it will not be queried even with credentials. Add it and restart.</div>` : ''}
      <div class="form-grid">
        <div class="field"><label for="va-key">API key</label>
          <input id="va-key" name="key" type="password" autocomplete="off" ${va.fields.key.fromEnv ? 'disabled' : ''}
            placeholder="${va.fields.key.set ? '•••••••• saved — type to replace' : 'Not set'}">
          ${va.fields.key.fromEnv ? html`<span class="hint">Set in the server .env</span>` : ''}</div>
        <div class="field"><label for="va-user">Username</label>
          <input id="va-user" name="user" type="text" autocomplete="off" value="${va.user}" ${va.fields.user.fromEnv ? 'disabled' : ''} placeholder="Not set"></div>
        <div class="field"><label for="va-pass">Password</label>
          <input id="va-pass" name="pass" type="password" autocomplete="new-password" ${va.fields.pass.fromEnv ? 'disabled' : ''}
            placeholder="${va.fields.pass.set ? '•••••••• saved — type to replace' : 'Not set'}"></div>
        <div class="field"><label for="va-mode">Mode</label>
          <select id="va-mode" name="mode">
            <option value="production" ${va.mode === 'production' ? 'selected' : ''}>Production (real reports, billed)</option>
            <option value="test" ${va.mode === 'test' ? 'selected' : ''}>Test (VinAudit test VINs only)</option>
          </select></div>
      </div>
      <div class="inline mt-1">
        <button class="btn btn-primary" type="submit">Save credentials</button>
        <span class="pill ${va.configured ? 'pill-ok' : 'pill-neutral'}">${va.configured ? 'Credentials saved' : 'Not configured'}</span>
      </div>
      <div class="inline mt-1">
        <input id="va-test-vin" type="text" class="mono input-vin-short" maxlength="17" value="2T3WFREV2HW391791" aria-label="VIN for connection test">
        <button class="btn" type="button" data-action="va-test" ${va.configured ? '' : 'disabled'}>Test connection</button>
      </div>
      <div id="va-result" class="mt-1" aria-live="polite"></div>
      <p class="hint small mt-1 mb-0">Credentials are stored on the server only and are never shown again in the browser. Each vehicle report pulled
        from VinAudit is billed to your account; a report is reused for repeat checks of the same VIN within 7 days.</p>
    </form>`);

  const offs = [
    on(body, 'submit', '#brand-form', async (e) => {
      e.preventDefault();
      await busy(e.target.querySelector('button[type=submit]'), async () => {
        try {
          ({ brand } = await put('/api/admin/settings', Object.fromEntries(new FormData(e.target))));
          ctx.config.agencyName = brand.agencyName;
          await refreshPublic();
          const el = document.querySelector('.brand-agency');
          if (el) el.textContent = brand.agencyName || 'Agency name not configured';
          toast('Branding saved.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      }, 'Saving…');
    }),
    on(body, 'submit', '#vinaudit-form', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await busy(e.target.querySelector('button[type=submit]'), async () => {
        try {
          const saved = await put('/api/admin/providers/vinaudit', { key: f.key || '', user: f.user || '', pass: f.pass || '', mode: f.mode });
          toast(saved.configured ? 'VinAudit credentials saved. Use “Test connection” to verify them.' : 'Saved. VinAudit still needs an API key, username and password.', 'ok');
          navigate('/admin/settings'); // re-render with fresh provider status
        } catch (err) { toast(err.message, 'error'); }
      }, 'Saving…');
    }),
    on(body, 'click', '[data-action=va-test]', async (_e, b) => {
      const out = $('#va-result', body);
      await busy(b, async () => {
        try {
          const r = await post('/api/admin/providers/vinaudit/test', { vin: $('#va-test-vin', body).value });
          mount(out, html`<div class="notice ${r.ok ? 'notice-ok' : 'notice-bad'} mb-0"><strong>${r.ok ? 'Connection verified' : 'Connection failed'}</strong>${r.message}</div>`);
        } catch (err) {
          mount(out, html`<div class="notice notice-bad mb-0">${err.message}</div>`);
        }
      }, 'Testing…');
    }),
    on(body, 'change', '#logo-file', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Logo must be 2 MB or smaller.', 'error'); return; }
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      try {
        await post('/api/admin/settings/logo', { dataUrl });
        toast('Logo uploaded.', 'ok');
        await refreshPublic();
        location.reload();
      } catch (err) { toast(err.message, 'error'); }
    }),
    on(body, 'click', '[data-action=remove-logo]', async () => {
      if (!(await confirmDialog('Remove logo?', 'Reports will show an empty logo placeholder.', { confirmLabel: 'Remove', danger: true }))) return;
      try {
        await del('/api/admin/settings/logo');
        await refreshPublic();
        location.reload();
      } catch (err) { toast(err.message, 'error'); }
    }),
  ];
  return () => offs.forEach((o) => o());
}
