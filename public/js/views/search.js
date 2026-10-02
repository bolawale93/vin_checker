// New VIN check: single VIN, pasted batch, or CSV upload, with pre-submit review.
import { html, mount, $, $$, on } from '../html.js';
import { post, get } from '../api.js';
import { ctx, canWrite, navigate } from '../app.js';
import { toast, nowLocalInput, storage, busy } from '../ui.js';
import { validateVin, reviewVinList, splitVinText, extractVinsFromCsv, normalizeVin } from '/shared/vin.js';

const STATUS_PILL = {
  valid: html`<span class="pill pill-ok">Valid</span>`,
  warning: html`<span class="pill pill-warn">Valid — check digit warning</span>`,
  invalid: html`<span class="pill pill-bad">Invalid</span>`,
  duplicate: html`<span class="pill pill-neutral">Duplicate</span>`,
};

export default function searchView(el, _params, query) {
  if (!canWrite()) {
    mount(el, html`<div class="page-head"><div><h1 tabindex="-1">VIN search</h1></div></div>
      <div class="card"><div class="empty"><h3>Read-only account</h3>
      <p>Your role (${ctx.user.role}) can view search history and download reports, but cannot run new checks.</p>
      <p><a class="btn btn-primary" href="#/history">Open search history</a></p></div></div>`);
    return;
  }

  const opts = { strictCheckDigit: ctx.config.strictCheckDigit };
  const max = ctx.config.maxBatchSize;
  const state = { mode: query.get('mode') || 'single', entries: [], reviewing: false, csvInfo: null };

  mount(el, html`
    <div class="page-head">
      <div>
        <h1 tabindex="-1">VIN search</h1>
        <p class="sub">Check one vehicle, or up to ${max} vehicles in a batch. Each VIN is validated before any lookup is made.</p>
      </div>
    </div>
    <form id="search-form" novalidate>
      <div class="card">
        <div class="tabs" role="tablist" aria-label="Search type">
          <button type="button" role="tab" data-mode="single">Single VIN</button>
          <button type="button" role="tab" data-mode="paste">Batch — paste VINs</button>
          <button type="button" role="tab" data-mode="csv">Batch — upload CSV</button>
        </div>
        <div class="card-body">
          <section data-panel="single">
            <div class="field">
              <label for="vin" class="req">Vehicle Identification Number (VIN)</label>
              <input id="vin" class="vin-input" type="text" name="vin" maxlength="40" autocomplete="off" spellcheck="false"
                placeholder="17 characters, e.g. 1HGCV1F36JA000202" aria-describedby="vin-feedback">
              <div id="vin-feedback" class="hint" aria-live="polite">Letters I, O and Q are not used in VINs. Spaces and dashes are removed automatically.</div>
            </div>
          </section>

          <section data-panel="paste" class="hidden">
            <div class="field">
              <label for="vin-list">Paste VINs — one per line, or separated by commas</label>
              <textarea id="vin-list" class="vin-list" spellcheck="false" placeholder="1HGCV1F36JA000202&#10;2T1BURHE4FC000101, 5NPD84LFXLH000404"></textarea>
              <div class="hint" id="paste-count">0 entries</div>
            </div>
            <div class="inline mt-1"><button type="button" class="btn btn-primary" data-action="review-paste">Review VINs</button></div>
          </section>

          <section data-panel="csv" class="hidden">
            <label class="dropzone" id="dropzone" for="csv-file">
              <strong>Choose a CSV file</strong> or drag it here<br>
              <span class="muted small">A column headed “VIN” is used if present; otherwise the first column. Maximum ${max} VINs.</span>
            </label>
            <input id="csv-file" type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only">
            <div id="csv-info" class="mt-1"></div>
          </section>

          <section id="review" class="hidden mt-1" aria-live="polite"></section>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Check details</h2><span class="tag tag-staff">Staff-entered</span></div>
        <div class="card-body">
          <div class="form-grid">
            <div class="field"><label for="location">Check location <span class="muted small">(optional)</span></label>
              <input id="location" type="text" name="location" maxlength="200" placeholder="e.g. Abuja office"></div>
            <div class="field"><label for="caseReference">Case / contract reference</label>
              <input id="caseReference" type="text" name="caseReference" maxlength="100"></div>
            <div class="field"><label for="checkerName" class="req">Checker name</label>
              <input id="checkerName" type="text" name="checkerName" maxlength="120"></div>
            <div class="field"><label for="checkedAt">Date and time of check</label>
              <input id="checkedAt" type="datetime-local" name="checkedAt"></div>
            <div class="field span-all" data-batch-only><label for="notes">Batch notes</label>
              <textarea id="notes" name="notes" maxlength="2000" rows="2" placeholder="Optional — e.g. operation name or instructions"></textarea></div>
          </div>
          <p class="hint small mt-1 mb-0">These details are recorded against every vehicle in the check and appear on the reports. They can be edited per vehicle afterwards.</p>
        </div>
        <div class="card-foot">
          <div class="notice notice-bad hidden grow mb-0" id="form-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-lg" id="submit-btn">Check VIN</button>
        </div>
      </div>
    </form>`);

  const form = $('#search-form', el);
  form.checkerName.value = ctx.user.fullName;
  form.checkedAt.value = nowLocalInput();
  form.location.value = storage('lastLocation') || '';

  function setMode(mode) {
    state.mode = mode;
    $$('[role=tab]', el).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
    $$('[data-panel]', el).forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== mode || (state.reviewing && mode !== 'single')));
    $$('[data-batch-only]', el).forEach((p) => p.classList.toggle('hidden', mode === 'single'));
    const reviewing = state.reviewing && mode !== 'single';
    $('#review', el).classList.toggle('hidden', !reviewing);
    if (mode === 'csv' && reviewing) $('[data-panel=csv]', el).classList.remove('hidden');
    if (mode === 'csv' && reviewing) $('#dropzone', el).classList.add('hidden');
    else $('#dropzone', el).classList.remove('hidden');
    updateSubmit();
    hideError();
  }

  function showError(msg) {
    const e = $('#form-error', el);
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function hideError() { $('#form-error', el).classList.add('hidden'); }

  // ----- Single VIN live validation -----
  const vinInput = form.vin;
  vinInput.addEventListener('input', () => {
    const raw = vinInput.value;
    const fb = $('#vin-feedback', el);
    if (!raw.trim()) {
      fb.className = 'hint';
      fb.textContent = 'Letters I, O and Q are not used in VINs. Spaces and dashes are removed automatically.';
      return;
    }
    const r = validateVin(raw, opts);
    const n = normalizeVin(raw).length;
    if (!r.valid) {
      fb.className = 'hint';
      fb.innerHTML = String(html`<span class="pill pill-bad">Invalid</span> ${n}/17 characters. ${r.errors.join(' ')}`);
    } else if (r.warnings.length) {
      fb.className = 'hint';
      fb.innerHTML = String(html`<span class="pill pill-warn">Check digit warning</span> ${r.warnings.join(' ')}`);
    } else {
      fb.className = 'hint';
      fb.innerHTML = String(html`<span class="pill pill-ok">Valid format</span> 17/17 characters, check digit correct.`);
    }
  });

  // ----- Paste -----
  const listArea = $('#vin-list', el);
  listArea.addEventListener('input', () => {
    const n = splitVinText(listArea.value).length;
    $('#paste-count', el).textContent = `${n} ${n === 1 ? 'entry' : 'entries'}${n > max ? ` — exceeds the ${max} VIN limit` : ''}`;
  });

  function startReview(entries, info = null) {
    if (!entries.length) {
      toast('No VINs found to review.', 'error');
      return;
    }
    state.entries = entries;
    state.csvInfo = info;
    state.reviewing = true;
    renderReview();
    setMode(state.mode);
  }

  function reviewed() {
    return reviewVinList(state.entries, opts);
  }

  function renderReview() {
    const list = reviewed();
    const c = { valid: 0, warning: 0, invalid: 0, duplicate: 0 };
    list.forEach((r) => c[r.status]++);
    const includeInvalid = $('#include-invalid', el)?.checked ?? true;
    mount($('#review', el), html`
      <div class="card-head mb-0">
        <div>
          <h2>Review ${list.length} ${list.length === 1 ? 'entry' : 'entries'}</h2>
          ${state.csvInfo ? html`<p class="muted small mb-0">From ${state.csvInfo.name}: ${state.csvInfo.rowCount} data rows, VINs read from ${state.csvInfo.column}.</p>` : ''}
        </div>
        <button type="button" class="btn btn-sm" data-action="edit-list">${state.mode === 'csv' ? 'Choose another file' : 'Edit list'}</button>
      </div>
      <div class="review-summary mt-1">
        <span class="pill pill-ok">${c.valid} valid</span>
        ${c.warning ? html`<span class="pill pill-warn">${c.warning} with check-digit warning</span>` : ''}
        ${c.invalid ? html`<span class="pill pill-bad">${c.invalid} invalid</span>` : ''}
        ${c.duplicate ? html`<span class="pill pill-neutral">${c.duplicate} duplicate${c.duplicate > 1 ? 's' : ''} (will be skipped)</span>` : ''}
      </div>
      ${list.length > max ? html`<div class="notice notice-bad"><strong>Too many VINs</strong>A batch may contain at most ${max} VINs. Remove ${list.length - max} or split the list.</div>` : ''}
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>#</th><th>Entered</th><th>VIN (normalised)</th><th>Result</th><th>Issue</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${list.map((r, i) => html`
              <tr class="row-${r.status}">
                <td>${r.index}</td>
                <td class="mono">${r.input}</td>
                <td class="mono">${r.vin || '—'}</td>
                <td>${STATUS_PILL[r.status]}</td>
                <td class="small">${r.status === 'duplicate' ? `Same as entry #${r.duplicateOf}` : [...r.errors, ...r.warnings].join(' ') || ''}</td>
                <td><button type="button" class="btn btn-sm btn-danger" data-remove="${i}" aria-label="Remove entry ${r.index}">Remove</button></td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      ${c.invalid ? html`<label class="checkbox mt-1"><input type="checkbox" id="include-invalid" ${includeInvalid ? 'checked' : ''}>
        <span>Record invalid entries in the batch (listed as “Invalid VIN” on the batch report; no lookup is made). Untick to leave them out.</span></label>` : ''}
      ${c.invalid ? html`<div class="notice notice-warn mt-1 mb-0">Correct invalid entries at source if possible — an invalid VIN cannot be looked up.</div>` : ''}`);
    updateSubmit();
  }

  function toSubmit() {
    const includeInvalid = $('#include-invalid', el)?.checked ?? true;
    return reviewed().filter((r) => r.status !== 'duplicate' && (includeInvalid || r.status !== 'invalid'));
  }

  function updateSubmit() {
    const btn = $('#submit-btn', el);
    if (state.mode === 'single') {
      btn.textContent = 'Check VIN';
      btn.disabled = false;
      return;
    }
    if (!state.reviewing) {
      btn.textContent = 'Review VINs first';
      btn.disabled = true;
      return;
    }
    const items = toSubmit();
    const lookups = items.filter((r) => r.valid).length;
    btn.textContent = `Start batch check — ${lookups} VIN${lookups === 1 ? '' : 's'}`;
    btn.disabled = lookups === 0 || items.length > max;
  }

  // ----- CSV -----
  const fileInput = $('#csv-file', el);
  async function readFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('The file is larger than 2 MB. Split it into smaller batches.', 'error');
      return;
    }
    const text = await file.text();
    const { vins, column, rowCount } = extractVinsFromCsv(text);
    if (!vins.length) {
      mount($('#csv-info', el), html`<div class="notice notice-bad"><strong>No VINs found</strong>The file ${file.name} has no readable rows.</div>`);
      return;
    }
    mount($('#csv-info', el), '');
    startReview(vins, { name: file.name, column, rowCount });
  }
  fileInput.addEventListener('change', () => readFile(fileInput.files[0]));
  const dz = $('#dropzone', el);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    readFile(e.dataTransfer.files[0]);
  });

  // ----- Events -----
  const offs = [
    on(el, 'click', '[role=tab]', (_e, t) => {
      if (state.mode !== t.dataset.mode) {
        state.reviewing = false;
        mount($('#review', el), '');
      }
      setMode(t.dataset.mode);
    }),
    on(el, 'click', '[data-action=review-paste]', () => startReview(splitVinText(listArea.value))),
    on(el, 'click', '[data-action=edit-list]', () => {
      state.reviewing = false;
      if (state.mode === 'csv') fileInput.value = '';
      setMode(state.mode);
      if (state.mode === 'paste') listArea.value = state.entries.join('\n');
    }),
    on(el, 'click', '[data-remove]', (_e, b) => {
      state.entries.splice(Number(b.dataset.remove), 1);
      if (!state.entries.length) {
        state.reviewing = false;
        setMode(state.mode);
      } else renderReview();
    }),
    on(el, 'change', '#include-invalid', () => updateSubmit()),
  ];

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const location = form.location.value.trim();
    const checkerName = form.checkerName.value.trim();
    const base = {
      location, checkerName, caseReference: form.caseReference.value.trim(), checkedAt: form.checkedAt.value,
    };
    if (state.mode === 'single') {
      const r = validateVin(vinInput.value, opts);
      if (!r.valid) {
        showError(r.vin ? `This VIN is not valid: ${r.errors.join(' ')}` : 'Enter a VIN.');
        vinInput.focus();
        return;
      }
      if (!checkerName) { showError('Enter the checker name.'); form.checkerName.focus(); return; }
      await busy($('#submit-btn', el), async () => {
        try {
          const { id } = await post('/api/searches', { ...base, type: 'single', vins: [r.vin], source: 'single' });
          if (location) storage('lastLocation', location);
          const { items } = await get(`/api/searches/${id}`);
          navigate(`/searches/${id}/items/${items[0].id}`);
        } catch (err) {
          showError(err.message);
        }
      }, 'Checking…');
      return;
    }
    if (!state.reviewing) { showError('Review the VINs before starting the batch.'); return; }
    if (!checkerName) { showError('Enter the checker name.'); form.checkerName.focus(); return; }
    const items = toSubmit();
    await busy($('#submit-btn', el), async () => {
      try {
        const res = await post('/api/searches', {
          ...base, type: 'batch', notes: form.notes.value.trim(), vins: items.map((r) => r.input), source: state.mode,
        });
        if (location) storage('lastLocation', location);
        toast(`Batch ${res.reference} started.`, 'ok');
        navigate(`/searches/${res.id}`);
      } catch (err) {
        showError(err.message);
      }
    }, 'Starting batch…');
  });

  setMode(['single', 'paste', 'csv'].includes(state.mode) ? state.mode : 'single');
  vinInput.focus();
  return () => offs.forEach((off) => off());
}
