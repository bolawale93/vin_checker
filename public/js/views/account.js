// My account: change password. Also used for the forced first-login change.
import { html, mount, $ } from '../html.js';
import { post } from '../api.js';
import { ctx } from '../app.js';
import { toast, busy } from '../ui.js';

export default function accountView(el, params = {}) {
  const forced = !!params.forced;
  const u = ctx.user;
  mount(el, html`
    ${forced ? html`<h1 tabindex="-1">Set a new password</h1>
      <p class="agency">Welcome, ${u.fullName}. You must choose a new password before continuing.</p>`
      : html`<div class="page-head"><div><h1 tabindex="-1">My account</h1>
        <p class="sub">${u.fullName} · ${u.username} · role: ${u.role}</p></div></div>`}
    <form class="${forced ? '' : 'card'}" id="pw-form" novalidate>
      ${forced ? '' : html`<div class="card-head"><h2>Change password</h2></div>`}
      <div class="${forced ? '' : 'card-body'}">
        <div class="form-grid">
          <div class="field span-all"><label for="cur" class="req">Current password</label><input id="cur" type="password" name="currentPassword" autocomplete="current-password" required></div>
          <div class="field"><label for="np" class="req">New password</label><input id="np" type="password" name="newPassword" autocomplete="new-password" required></div>
          <div class="field"><label for="np2" class="req">Confirm new password</label><input id="np2" type="password" name="confirm" autocomplete="new-password" required></div>
        </div>
        <p class="hint small mt-1">At least 10 characters, including three of: lowercase, uppercase, digits, symbols. Must not contain your username.</p>
        <div class="notice notice-bad hidden" id="pw-error" role="alert"></div>
      </div>
      <div class="${forced ? 'inline' : 'card-foot'}">
        <button class="btn btn-primary" type="submit">Change password</button>
        ${forced ? html`<button class="btn" type="button" data-action="logout">Sign out</button>` : ''}
      </div>
    </form>`);

  $('#pw-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const err = $('#pw-error', el);
    err.classList.add('hidden');
    if (f.newPassword !== f.confirm) {
      err.textContent = 'The new passwords do not match.';
      err.classList.remove('hidden');
      return;
    }
    await busy(e.target.querySelector('button[type=submit]'), async () => {
      try {
        await post('/api/auth/password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
        toast('Password changed.', 'ok');
        e.target.reset();
        if (forced) {
          ctx.user.mustChangePassword = false;
          await params.onDone();
        }
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    }, 'Saving…');
  });
}
