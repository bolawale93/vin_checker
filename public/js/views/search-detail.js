// A search (usually a batch): progress, per-VIN results, retries, common case
// details and report downloads.
import { html, mount, $, on, applyWidths } from '../html.js';
import { get, post, put, download } from '../api.js';
import { ctx, canWrite, navigate } from '../app.js';
import {
  toast, outcomePill, searchStatusPill, vehicleStatusPill, sampleBadge, fmtDateTime, fmtLocal, busy, loading,
  errorState, confirmDialog, basisMark, historyPill,
} from '../ui.js';

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'found', label: 'Details found', test: (i) => i.status === 'found' },
  { key: 'no_record', label: 'No record', test: (i) => i.status === 'no_record' },
  { key: 'failed', label: 'Failed', test: (i) => i.status === 'error' || i.status === 'partial' },
  { key: 'invalid', label: 'Invalid', test: (i) => i.status === 'invalid' },
  { key: 'pending', label: 'Pending', test: (i) => i.status === 'queued' || i.status === 'processing' },
  { key: 'flagged', label: 'Flagged status', test: (i) => /stolen|salvage|written off/i.test(i.vehicleStatus || '') },
];

export default async function searchDetailView(el, { id }) {
  let data;
  let timer = null;
  let stopped = false;
  let filter = 'all';
  let text = '';

  async function load() {
    data = await get(`/api/searches/${id}`);
    return data;
  }

  try {
    mount(el, loading('Loading search…'));
    await load();
  } catch (err) {
    mount(el, errorState(err));
    return;
  }

  const s = data.search;
  mount(el, html`
    <div class="crumbs"><a href="#/history">Search history</a> › ${s.reference}</div>
    <div class="page-head">
      <div>
        <h1 tabindex="-1">${s.type === 'batch' ? 'Batch check' : 'VIN check'} <span class="mono">${s.reference}</span></h1>
        <p class="sub" id="head-sub"></p>
      </div>
      <div class="actions" id="head-actions"></div>
    </div>
    <div class="card"><div class="card-body" id="summary"></div></div>
    <div class="card">
      <div class="card-head">
        <h2>Vehicles</h2>
        <input type="search" id="item-filter" placeholder="Filter by VIN, make, model…" aria-label="Filter vehicles" class="grow" maxlength="40">
      </div>
      <div id="items"></div>
    </div>
    <div id="common"></div>`);

  function counts() {
    const c = {};
    for (const i of data.items) c[i.status] = (c[i.status] || 0) + 1;
    return c;
  }

  function renderHead() {
    const s2 = data.search;
    const c = counts();
    const failed = (c.error || 0) + (c.partial || 0);
    const processing = s2.status === 'processing';
    $('#head-sub', el).innerHTML = String(html`${searchStatusPill(s2.status)} ·
      Started ${fmtDateTime(s2.createdAt)} by ${s2.userFullName} (${s2.username})`);
    mount($('#head-actions', el), html`
      ${canWrite() && failed ? html`<button class="btn" data-action="retry-all">Retry ${failed} failed</button>` : ''}
      ${canWrite() && !processing ? html`<button class="btn" data-action="recheck-all" title="Look up every VIN again against the currently configured sources">Re-check all</button>` : ''}
      <button class="btn" data-action="batch-pdf" ${data.items.length ? '' : 'disabled'}>Summary report (PDF)</button>
      <button class="btn btn-primary" data-action="zip" ${processing ? html`disabled title="Available when all lookups are complete"` : ''}>
        Download all reports (ZIP)</button>`);
  }

  function renderSummary() {
    const s2 = data.search;
    const c = counts();
    const total = data.items.length;
    const done = total - (c.queued || 0) - (c.processing || 0);
    const pct = (n) => (total ? Math.round(((n || 0) / total) * 1000) / 10 : 0);
    const hasSample = data.items.some((i) => i.hasSample);
    const notChecked = data.items.filter((i) => i.historyStatus === 'not_checked').length;
    mount($('#summary', el), html`
      ${notChecked ? html`<div class="notice notice-warn"><strong>Accident and damage history not checked</strong>
        No live vehicle-history source was available (none configured, or awaiting account credentials), so accident, damage, theft and ownership history was not checked
        for ${notChecked} vehicle${notChecked === 1 ? '' : 's'}. Make, model and year shown are decoded specifications, not evidence of history.</div>` : ''}
      ${hasSample ? html`<div class="notice notice-bad"><strong>Contains sample data</strong>
        Some results come from the development sample data provider. They are fictitious and must not be relied on.</div>` : ''}
      <div class="inline" aria-live="polite">
        <strong>${done} of ${total} processed</strong>
        ${s2.status === 'processing' ? html`<span class="muted small"><span class="spinner" aria-hidden="true"></span> Lookups in progress — this page updates automatically.</span>` : ''}
      </div>
      <div class="progress mt-1" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Batch progress">
        <span class="p-ok" data-w="${pct(c.found)}"></span>
        <span class="p-warn" data-w="${pct((c.no_record || 0) + (c.partial || 0))}"></span>
        <span class="p-bad" data-w="${pct((c.error || 0) + (c.invalid || 0))}"></span>
        <span class="p-proc" data-w="${pct((c.processing || 0) + (c.queued || 0))}"></span>
      </div>
      <div class="stat-row" role="group" aria-label="Filter by outcome">
        ${FILTERS.map((f) => {
          const n = data.items.filter(f.test).length;
          if (f.key !== 'all' && !n) return '';
          return html`<button type="button" class="stat" data-filter="${f.key}" aria-pressed="${filter === f.key}"><b>${n}</b>${f.label}</button>`;
        })}
      </div>
      <div class="meta-grid">
        <div><span>Case / contract ref.</span>${s2.caseReference || html`<span class="missing">Not recorded</span>`}</div>
        <div><span>Checked by</span>${s2.checkerName}</div>
        <div><span>Location</span>${s2.location || html`<span class="missing">Not recorded</span>`}</div>
        <div><span>Date/time of check</span>${s2.common?.checkedAt ? fmtLocal(s2.common.checkedAt) : fmtDateTime(s2.createdAt)}</div>
        <div><span>Completed</span>${s2.completedAt ? fmtDateTime(s2.completedAt) : '—'}</div>
        ${s2.notes ? html`<div><span>Notes</span>${s2.notes}</div>` : ''}
      </div>`);
    applyWidths($('#summary', el));
  }

  function renderItems() {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
    const t = text.trim().toUpperCase();
    const rows = data.items.filter(f.test).filter((i) => !t || [i.vin, i.vinInput, i.make, i.model, i.year]
      .some((v) => String(v || '').toUpperCase().includes(t)));
    if (!rows.length) {
      mount($('#items', el), html`<div class="empty"><h3>No vehicles match</h3><p>Change the filter to see other results.</p></div>`);
      return;
    }
    mount($('#items', el), html`
      <div class="table-wrap"><table class="data">
        <thead><tr><th>#</th><th>VIN</th><th>Make</th><th>Model</th><th>Year</th><th>History / status</th><th>Lookup outcome</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
        ${rows.map((i) => html`
          <tr class="${i.status === 'invalid' ? '' : 'clickable'}" data-item="${i.id}">
            <td>${i.position}</td>
            <td class="mono nowrap">${i.vin || i.vinInput}${i.validation.warnings?.length ? html` <span class="pill pill-warn" title="${i.validation.warnings.join(' ')}">!</span>` : ''}</td>
            ${['make', 'model', 'year'].map((k) => html`<td>${i[k] ? html`${i[k]}${basisMark(i.summaryMeta?.[k])}` : html`<span class="missing">—</span>`}</td>`)}
            <td>${i.historyStatus && !/stolen|salvage|written off|accident/i.test(i.vehicleStatus || '')
              ? historyPill(i.historyStatus) : vehicleStatusPill(i.vehicleStatus, i.status)}</td>
            <td>${outcomePill(i.status)} ${i.hasSample ? sampleBadge() : ''}
              ${i.message && ['error', 'partial', 'invalid'].includes(i.status) ? html`<div class="small muted">${i.message}</div>` : ''}</td>
            <td class="nowrap">
              ${canWrite() && ['error', 'partial'].includes(i.status) ? html`<button class="btn btn-sm" data-retry="${i.id}">Retry</button>` : ''}
              <a class="btn btn-sm" href="#/searches/${id}/items/${i.id}">Open</a>
            </td>
          </tr>`)}
        </tbody>
      </table></div>`);
  }

  function renderCommon() {
    if (data.search.type !== 'batch') { mount($('#common', el), ''); return; }
    const c = data.search.common || {};
    const opts = (list, v) => html`<option value="">— Not set —</option>${list.map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}`;
    const ro = !canWrite();
    mount($('#common', el), html`
      <form class="card staff" id="common-form" novalidate>
        <div class="card-head"><h2>Common case details for this batch</h2><span class="tag tag-staff">Staff-entered</span></div>
        <div class="card-body">
          <p class="muted small">Enter details that apply to every vehicle in the batch, then apply them. “Fill blanks only” keeps anything already
          entered for an individual vehicle; “Overwrite” replaces it. Vehicle-specific details can still be edited on each vehicle's page.</p>
          <fieldset ${ro ? 'disabled' : ''} class="form-grid">
            <div class="field"><label for="c-checker">Checker name</label><input id="c-checker" type="text" name="checkerName" maxlength="120" value="${c.checkerName || ''}"></div>
            <div class="field"><label for="c-at">Date and time of check</label><input id="c-at" type="datetime-local" name="checkedAt" value="${c.checkedAt || ''}"></div>
            <div class="field"><label for="c-loc">Check location</label><input id="c-loc" type="text" name="location" maxlength="200" value="${c.location || ''}"></div>
            <div class="field"><label for="c-case">Case / contract reference</label><input id="c-case" type="text" name="caseReference" maxlength="100" value="${c.caseReference || ''}"></div>
            <div class="field"><label for="c-cond">Observed vehicle condition</label><select id="c-cond" name="vehicleCondition">${opts(ctx.config.conditionOptions, c.vehicleCondition)}</select></div>
            <div class="field span-all"><label for="c-find">Inspection findings</label><textarea id="c-find" name="inspectionFindings" maxlength="5000" rows="2">${c.inspectionFindings || ''}</textarea></div>
            <div class="field span-all"><label for="c-notes">Supporting notes</label><textarea id="c-notes" name="notes" maxlength="5000" rows="2">${c.notes || ''}</textarea></div>
            <div class="field span-all"><label for="c-ev">Evidence references</label><input id="c-ev" type="text" name="evidenceRefs" maxlength="2000" value="${c.evidenceRefs || ''}"></div>
          </fieldset>
        </div>
        ${ro ? '' : html`<div class="card-foot">
          <button type="button" class="btn btn-staff" data-apply="fill">Save and apply — fill blanks only</button>
          <button type="button" class="btn" data-apply="overwrite">Save and overwrite all vehicles</button>
          <button type="button" class="btn" data-apply="">Save without applying</button>
        </div>`}
      </form>`);
  }

  function renderAll() {
    renderHead();
    renderSummary();
    renderItems();
  }

  async function poll() {
    if (stopped) return;
    try {
      await load();
      renderAll();
    } catch (err) {
      if (err.status === 401) return;
    }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!stopped && data.search.status === 'processing') timer = setTimeout(poll, 1500);
  }

  renderAll();
  renderCommon();
  schedule();

  const offs = [
    on(el, 'click', '[data-filter]', (_e, b) => { filter = b.dataset.filter; renderSummary(); renderItems(); }),
    on(el, 'input', '#item-filter', (e) => { text = e.target.value; renderItems(); }),
    on(el, 'click', 'tr.clickable', (e, tr) => {
      if (e.target.closest('a,button')) return;
      navigate(`/searches/${id}/items/${tr.dataset.item}`);
    }),
    on(el, 'click', '[data-retry]', async (_e, b) => {
      await busy(b, async () => {
        try {
          await post(`/api/searches/${id}/retry`, { itemIds: [Number(b.dataset.retry)] });
          toast('Lookup queued for retry.');
          await load(); renderAll(); schedule();
        } catch (err) { toast(err.message, 'error'); }
      }, 'Retrying');
    }),
    on(el, 'click', '[data-action=retry-all]', async (_e, b) => {
      await busy(b, async () => {
        try {
          const { queued } = await post(`/api/searches/${id}/retry`, {});
          toast(`${queued} lookup${queued === 1 ? '' : 's'} queued for retry.`);
          await load(); renderAll(); schedule();
        } catch (err) { toast(err.message, 'error'); }
      }, 'Retrying');
    }),
    on(el, 'click', '[data-action=recheck-all]', async (_e, b) => {
      if (!(await confirmDialog('Re-check all vehicles?',
        'Every VIN in this search will be looked up again against the currently configured sources. The previous results are replaced; staff-entered details are kept.',
        { confirmLabel: 'Re-check all' }))) return;
      await busy(b, async () => {
        try {
          const { queued } = await post(`/api/searches/${id}/retry`, { recheck: true });
          toast(`${queued} lookup${queued === 1 ? '' : 's'} queued.`);
          await load(); renderAll(); schedule();
        } catch (err) { toast(err.message, 'error'); }
      }, 'Queuing…');
    }),
    on(el, 'click', '[data-action=batch-pdf]', async (_e, b) => {
      await busy(b, async () => {
        try { await download(`/api/searches/${id}/report.pdf?download=1`, `${s.reference}_summary.pdf`); } catch (err) { toast(err.message, 'error'); }
      }, 'Generating…');
    }),
    on(el, 'click', '[data-action=zip]', async (_e, b) => {
      if (b.disabled) return;
      await busy(b, async () => {
        try {
          await download(`/api/searches/${id}/reports.zip`, `${s.reference}_reports.zip`);
          toast('Reports downloaded.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      }, 'Preparing reports…');
    }),
    on(el, 'click', '[data-apply]', async (_e, b) => {
      const mode = b.dataset.apply;
      if (mode === 'overwrite' && !(await confirmDialog('Overwrite vehicle details?',
        'Filled-in fields will replace the matching details on every vehicle in this batch, including details entered individually.',
        { confirmLabel: 'Overwrite all', danger: true }))) return;
      const details = Object.fromEntries(new FormData($('#common-form', el)));
      await busy(b, async () => {
        try {
          const r = await put(`/api/searches/${id}/common`, { details, apply: mode || null });
          toast(mode ? `Saved. ${r.updated} vehicle record${r.updated === 1 ? '' : 's'} updated.` : 'Common details saved.', 'ok');
          await load(); renderAll(); renderCommon();
        } catch (err) { toast(err.message, 'error'); }
      }, 'Saving…');
    }),
  ];

  return () => {
    stopped = true;
    clearTimeout(timer);
    offs.forEach((off) => off());
  };
}
