// Shared UI helpers: toasts, dialogs, labels, formatting, status pills.
import { html, esc } from './html.js';

export function toast(message, type = 'info', ms = 4500) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Show a modal dialog. `body` is template output; resolves with the form data,
 * or null if cancelled. If `onSubmit` is given it runs first; an error it
 * throws is shown inside the dialog and the dialog stays open.
 */
export function dialog({ title, body, submitLabel = 'Save', danger = false, cancelLabel = 'Cancel', onSubmit = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = String(html`
      <form method="dialog" novalidate>
        <div class="card-head"><h2>${title}</h2></div>
        <div class="card-body">${body}<div class="notice notice-bad hidden" data-error role="alert"></div></div>
        <div class="card-foot justify-end">
          <button type="button" class="btn" data-cancel>${cancelLabel}</button>
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>
        </div>
      </form>`);
    document.body.appendChild(d);
    const form = d.querySelector('form');
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!onSubmit) return close(data);
      const btn = form.querySelector('button[type=submit]');
      const errEl = d.querySelector('[data-error]');
      btn.disabled = true;
      try {
        await onSubmit(data);
        close(data);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    });
    d.showModal();
    d.querySelector('input,select,textarea')?.focus();
  });
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return dialog({ title, body: html`<p>${message}</p>`, submitLabel: confirmLabel, danger }).then((r) => !!r);
}

export const OUTCOME = {
  queued: { label: 'Pending', cls: 'pill-neutral' },
  processing: { label: 'Checking…', cls: 'pill-info' },
  found: { label: 'Details found', cls: 'pill-ok' },
  partial: { label: 'Partial — source error', cls: 'pill-warn' },
  no_record: { label: 'No external record', cls: 'pill-warn' },
  error: { label: 'Lookup failed', cls: 'pill-bad' },
  invalid: { label: 'Invalid VIN', cls: 'pill-bad' },
};

export const SEARCH_STATUS = {
  processing: { label: 'Processing', cls: 'pill-info' },
  completed: { label: 'Completed', cls: 'pill-ok' },
  completed_with_errors: { label: 'Completed — some lookups failed', cls: 'pill-warn' },
};

export function outcomePill(status) {
  const o = OUTCOME[status] || { label: status, cls: 'pill-neutral' };
  return html`<span class="pill ${o.cls}">${status === 'processing' ? html`<span class="spinner" aria-hidden="true"></span>` : ''}${o.label}</span>`;
}

export function searchStatusPill(status) {
  const o = SEARCH_STATUS[status] || { label: status, cls: 'pill-neutral' };
  return html`<span class="pill ${o.cls}">${o.label}</span>`;
}

export function vehicleStatusPill(text, outcome) {
  if (!text) return html`<span class="missing">—</span>`;
  let cls = 'pill-neutral';
  if (/stolen|written off|salvage/i.test(text)) cls = 'pill-bad';
  else if (/accident|recovered|flood/i.test(text)) cls = 'pill-warn';
  else if (/no adverse/i.test(text)) cls = 'pill-ok';
  if (['invalid', 'error', 'no_record'].includes(outcome)) cls = 'pill-neutral';
  return html`<span class="pill wrap ${cls}">${text}</span>`;
}

export const BASIS = {
  confirmed: { label: 'Confirmed', cls: 'pill-ok', title: 'Returned by more than one source, which agree' },
  provider: { label: 'Provider', cls: 'pill-info', title: 'Returned by an external provider' },
  decoded: { label: 'Decoded from VIN', cls: 'pill-neutral', title: 'Determined from the VIN characters by the VIN standard' },
  estimated: { label: 'Estimated', cls: 'pill-warn', title: 'Most likely reading of the VIN; not guaranteed' },
  ambiguous: { label: 'Ambiguous', cls: 'pill-warn', title: 'The VIN allows more than one value' },
  sample: { label: 'Sample', cls: 'pill-sample', title: 'Fictitious development data — not verified' },
};

export function basisPill(spec) {
  if (!spec) return html`<span class="pill pill-neutral">Unavailable</span>`;
  if (spec.conflict) return html`<span class="pill pill-bad" title="Sources disagree">Conflict</span>`;
  const b = BASIS[spec.basis] || { label: spec.basis, cls: 'pill-neutral' };
  const label = spec.basis === 'confirmed' ? `Confirmed · ${spec.agreeing} sources` : b.label;
  return html`<span class="pill ${b.cls}" title="${b.title || ''}">${label}</span>`;
}

/** Small marker after a summary value: (dec.), (est.), (!) conflict. */
export function basisMark(meta) {
  if (!meta) return '';
  if (meta.conflict) return html` <span class="pill pill-bad" title="Sources disagree — open the vehicle">!</span>`;
  const short = { decoded: 'dec.', estimated: 'est.', sample: 'sample' }[meta.basis];
  return short ? html` <span class="basis-mark" title="${BASIS[meta.basis]?.title || ''}">${short}</span>` : '';
}

export const HISTORY = {
  records: { label: 'History records found', cls: 'pill-warn' },
  no_records: { label: 'No history records returned', cls: 'pill-ok' },
  not_found: { label: 'Not in history sources', cls: 'pill-neutral' },
  failed: { label: 'History check failed', cls: 'pill-bad' },
  partial: { label: 'History check incomplete', cls: 'pill-warn' },
  not_checked: { label: 'History not checked', cls: 'pill-neutral' },
};
export function historyPill(status) {
  if (!status) return '';
  const h = HISTORY[status] || { label: status, cls: 'pill-neutral' };
  return html`<span class="pill ${h.cls}">${h.label}</span>`;
}

export const sampleBadge = () => html`<span class="pill pill-sample" title="Development sample data — fictitious and not verified">SAMPLE</span>`;

export const TRUST = {
  verified: 'Authorised source',
  unverified: 'Unverified source',
  sample: 'SAMPLE DATA — not verified',
  derived: 'Derived from VIN (not a record)',
};

export function sourceLabel(src) {
  if (!src) return html`<span class="src">—</span>`;
  const cls = src.trust === 'sample' ? 'sample' : src.trust === 'derived' ? 'derived' : '';
  const name = src.trust === 'sample' ? 'Sample data (not verified)' : src.trust === 'derived' ? 'VIN structure analysis' : src.name;
  return html`<span class="src ${cls}" title="${src.name} · retrieved ${fmtDateTime(src.retrievedAt)}">${name}${src.trust === 'unverified' ? ' (unverified)' : ''}</span>`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtLocal(v) {
  return v ? String(v).replace('T', ' ').slice(0, 16) : '';
}

/** Current local time as a datetime-local value. */
export function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function loading(text = 'Loading…') {
  return html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span> ${text}</div>`;
}

export function errorState(err, retryLabel = 'Try again') {
  return html`<div class="card"><div class="empty"><h3>Something went wrong</h3><p>${err?.message || err}</p>
    <button class="btn" data-action="reload">${retryLabel}</button></div></div>`;
}

export function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`vinchk.${key}`);
    localStorage.setItem(`vinchk.${key}`, value);
  } catch { /* storage unavailable */ }
  return null;
}

/** Run an async action with a busy state on a button. */
export async function busy(btn, fn, label) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label || btn.textContent.trim())}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}
