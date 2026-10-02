// Vehicle profile: best-supported vehicle details (each with its basis and
// source), specification and history check status reported separately,
// VIN-level history, model-level recalls, VIN structure analysis, and the
// staff-entered inspection record.
import { html, mount, $, on } from '../html.js';
import { get, post, put, download } from '../api.js';
import { ctx, canWrite } from '../app.js';
import {
  toast, outcomePill, vehicleStatusPill, sampleBadge, sourceLabel, fmtDateTime, busy, loading, errorState, TRUST,
  basisPill, historyPill, confirmDialog,
} from '../ui.js';

const SPEC_LABELS = {
  make: 'Make', model: 'Model', year: 'Model year', trim: 'Trim', series: 'Series', bodyType: 'Body type',
  vehicleType: 'Vehicle type', engine: 'Engine', fuelType: 'Fuel type', electrification: 'Electrification',
  transmission: 'Transmission', driveType: 'Drive type', steering: 'Steering', colour: 'Colour', doors: 'Doors',
  seats: 'Seats', gvwr: 'Gross vehicle weight rating', manufacturerName: 'Manufacturer (registered)',
  plant: 'Assembly plant', plantCountry: 'Plant country', country: 'Country of manufacture',
  manufacturer: 'Manufacturer (WMI table)', region: 'Region of manufacture', yearCode: 'Model-year code',
  checkDigit: 'Check digit', wmi: 'WMI', vds: 'Vehicle descriptor (VDS)', plantCode: 'Plant code', serialNumber: 'Serial number',
};
const PROFILE_SPECS = ['make', 'model', 'year', 'trim', 'series', 'bodyType', 'vehicleType', 'engine', 'fuelType',
  'electrification', 'transmission', 'driveType', 'steering', 'colour', 'doors', 'seats', 'gvwr', 'manufacturerName',
  'plant', 'plantCountry', 'country'];
const ESSENTIAL = ['make', 'model', 'year', 'bodyType', 'engine'];
const STRUCTURE_SPECS = ['manufacturer', 'region', 'yearCode', 'checkDigit', 'wmi', 'vds', 'plantCode', 'serialNumber'];

const SPEC_STATUS = {
  provider: { cls: 'ok', text: 'Decoded by an external provider. Each value below shows how it was established.' },
  failed: { cls: 'bad', text: 'The external decoder failed. Values below come from VIN structure analysis only — retry the lookup.' },
  sample: { cls: 'warn', text: 'Only development sample data returned specifications. They are fictitious and not verified.' },
  not_found: { cls: 'warn', text: 'The external decoder did not recognise this VIN. Values below come from VIN structure analysis only.' },
  vin_only: { cls: 'warn', text: 'No external decoder is configured. Values below come from VIN structure analysis only.' },
};
const HISTORY_STATUS = {
  records: { cls: 'warn', text: 'Records were returned by a live history source — see the history sections below.' },
  no_records: { cls: 'ok', text: 'The configured history source(s) returned no records. This does not prove the vehicle has never been damaged.' },
  not_found: { cls: 'warn', text: 'This VIN was not found in the configured history source(s). This does not prove the vehicle has no history.' },
  failed: { cls: 'bad', text: 'The history source(s) returned an error, so history could not be checked. Retry the lookup.' },
  partial: { cls: 'warn', text: 'Some history sources failed, so history may be incomplete. Retry the lookup.' },
  not_checked: {
    cls: 'bad',
    text: 'Not checked. Accident, damage, theft and ownership history has not been checked against any live source. VIN decoding is not evidence either way.',
  },
};

const CATEGORIES = [
  {
    key: 'accidents', title: 'Accident and damage records',
    cols: [['Date', (r) => r.date], ['Severity', (r) => r.severity], ['Description', (r) => r.description],
      ['Location', (r) => r.location], ['Reference', (r) => r.reference]],
  },
  {
    key: 'statusRecords', title: 'Theft, recovery, salvage and write-off records',
    cols: [['Date', (r) => r.date], ['Type', (r) => html`<strong>${r.type}</strong>`], ['Description', (r) => r.description],
      ['Authority', (r) => r.jurisdiction], ['Reference', (r) => r.reference]],
  },
  {
    key: 'ownership', title: 'Ownership and registration history',
    cols: [['#', (r) => r.sequence], ['From', (r) => r.startDate], ['To', (r) => r.endDate || 'Current'],
      ['Purchase date', (r) => r.purchaseDate], ['Owner type', (r) => r.ownerType], ['Region', (r) => r.region], ['Odometer', (r) => r.odometer]],
  },
  {
    key: 'maintenance', title: 'Maintenance and inspection history',
    cols: [['Date', (r) => r.date], ['Type', (r) => r.type], ['Description', (r) => r.description],
      ['Result', (r) => r.result], ['Odometer', (r) => r.odometer], ['Facility', (r) => r.facility]],
  },
];
const RECALL_COLS = [['Reported', (r) => r.date], ['Campaign', (r) => r.campaign], ['Component', (r) => r.component],
  ['Summary', (r) => html`${r.summary}${r.remedy ? html`<div class="spec-note"><strong>Remedy:</strong> ${r.remedy}</div>` : ''}${r.parkIt ? html`<div class="spec-conflict">Park-it advisory issued</div>` : ''}`]];

const cell = (v) => (v == null || v === '' ? html`<span class="missing">—</span>` : v);
const names = (src, statuses) => src.filter((s) => statuses.includes(s.status)).map((s) => s.name).join(', ');

function stateText(rec, modelLevel) {
  const src = rec.sources || [];
  const sampleNote = rec.sampleOnly ? ' Only development sample data covers this category — no live source was checked.' : '';
  switch (rec.state) {
    case 'none':
      return modelLevel ? `No recalls were returned by ${names(src, ['match'])} for this model.`
        : `No records were returned by ${names(src, ['match'])}. This does not prove that no such event occurred.${sampleNote}`;
    case 'not_found': return `This vehicle was not found in ${names(src, ['no_match'])}.${sampleNote}`;
    case 'failed': return `Could not be retrieved: ${src.filter((s) => s.status === 'error').map((s) => `${s.name} — ${s.error}`).join('; ')}. Retry the lookup.`;
    case 'skipped': return `Not checked: ${src.filter((s) => s.reason).map((s) => s.reason).join(' ') || 'prerequisites not met.'}`;
    default: return 'Not checked — no configured data source covers this information.';
  }
}

export default async function vehicleView(el, { id, itemId }) {
  let data;
  let timer = null;
  let stopped = false;
  let dirty = false;

  async function load() {
    data = await get(`/api/searches/${id}/items/${itemId}`);
  }
  try {
    mount(el, loading('Loading vehicle…'));
    await load();
  } catch (err) {
    mount(el, errorState(err));
    return;
  }

  const pending = () => ['queued', 'processing'].includes(data.item.status);

  function specRow(k, s) {
    if (!s) {
      return html`<tr><th scope="row">${SPEC_LABELS[k]}</th><td class="missing">Not available from configured sources</td>
        <td>${basisPill(null)}</td><td>—</td></tr>`;
    }
    const agreeingSources = (s.candidates || []).filter((c) => !s.conflict && c.value != null);
    return html`<tr>
      <th scope="row">${SPEC_LABELS[k] || k}</th>
      <td>${s.basis === 'ambiguous' ? html`<span class="missing">Undetermined:</span> ${s.value}` : s.value}
        ${s.note && s.source?.trust === 'derived' ? html`<div class="spec-note">${s.note}</div>` : ''}
        ${s.conflict ? html`<div class="spec-conflict"><strong>Sources disagree:</strong>
          ${s.candidates.map((c, i) => html`${i ? ' vs ' : ''}“${c.value}” (${sourceLabel(c.source)})`)}.
          Verify against the vehicle and its documents.</div>` : ''}</td>
      <td>${basisPill(s)}</td>
      <td>${s.conflict ? sourceLabel(s.source) : agreeingSources.map((c, i) => html`${i ? html`<br>` : ''}${sourceLabel(c.source)}`)}</td>
    </tr>`;
  }

  function render() {
    const { search: s, item: i, nav } = data;
    const r = i.result;
    const specs = r?.specs || {};
    const best = (k) => (specs[k] && specs[k].basis !== 'ambiguous' ? specs[k].value : null);
    const headline = [best('year'), best('make'), best('model')].filter(Boolean).join(' ');
    const flagged = /stolen|salvage|written off|accident/i.test(i.vehicleStatus || '');
    const recheckable = ['found', 'partial', 'no_record', 'error'].includes(i.status);
    mount(el, html`
      <div class="crumbs"><a href="#/history">Search history</a> ›
        ${s.type === 'batch' ? html`<a href="#/searches/${s.id}">${s.reference}</a> › Vehicle ${i.position} of ${s.total}` : s.reference}</div>

      <div class="card">
        <div class="card-body">
          <div class="vin-hero">
            <div>
              <div class="muted small">Vehicle Identification Number</div>
              <h1 class="vin" tabindex="-1">${i.vin || i.vinInput}</h1>
              <div class="headline">${headline || html`<span class="missing">Make / model / year could not be determined</span>`}
                ${headline && !best('model') ? html`<span class="muted small"> — model not available from configured sources</span>` : ''}</div>
              <div class="inline mt-1">${outcomePill(i.status)} ${r ? historyPill(r.historyStatus) : ''}
                ${flagged ? vehicleStatusPill(i.vehicleStatus, i.status) : ''} ${i.hasSample ? sampleBadge() : ''}
                ${r?.conflicts?.length ? html`<span class="pill pill-bad">Conflicting source data</span>` : ''}</div>
            </div>
            <div class="actions">
              ${s.type === 'batch' ? html`
                <a class="btn btn-sm ${nav.prev ? '' : 'hidden'}" href="#/searches/${s.id}/items/${nav.prev}">‹ Previous</a>
                <a class="btn btn-sm ${nav.next ? '' : 'hidden'}" href="#/searches/${s.id}/items/${nav.next}">Next ›</a>` : ''}
              ${canWrite() && ['error', 'partial'].includes(i.status) ? html`<button class="btn" data-action="retry">Retry lookup</button>` : ''}
              ${canWrite() && recheckable && !['error', 'partial'].includes(i.status) ? html`<button class="btn" data-action="recheck" title="Look up this VIN again against the currently configured sources">Re-check</button>` : ''}
              <a class="btn" href="/api/searches/${s.id}/items/${i.id}/report.pdf" target="_blank" rel="noopener">View PDF</a>
              <button class="btn btn-primary" data-action="pdf">Download report (PDF)</button>
            </div>
          </div>
          <div class="meta-grid">
            <div><span>Search reference</span>${s.type === 'batch' ? html`<a href="#/searches/${s.id}">${s.reference}</a>` : s.reference}</div>
            <div><span>Searched by</span>${s.userFullName} (${s.username})</div>
            <div><span>Searched at</span>${fmtDateTime(s.createdAt)}</div>
            <div><span>Data retrieved</span>${i.retrievedAt ? fmtDateTime(i.retrievedAt) : '—'}</div>
            <div><span>Lookup attempts</span>${i.attempts}</div>
          </div>
        </div>
      </div>

      ${i.hasSample ? html`<div class="notice notice-bad"><strong>Sample data — not verified</strong>
        Some information on this page comes from the development sample data provider. It is fictitious and must not be used for any official purpose.</div>` : ''}
      ${i.validation.warnings?.length ? html`<div class="notice notice-warn"><strong>VIN warning</strong>${i.validation.warnings.join(' ')}</div>` : ''}
      ${statusNotice(i)}

      ${r ? html`
        <section class="card">
          <div class="card-head"><h2>What was checked</h2></div>
          <div class="card-body check-summary">
            <div class="${SPEC_STATUS[r.specStatus]?.cls || ''}">
              <h3>Vehicle specifications</h3>${SPEC_STATUS[r.specStatus]?.text || '—'}
            </div>
            <div class="${HISTORY_STATUS[r.historyStatus]?.cls || ''}">
              <h3>Accident, damage and theft history</h3>${HISTORY_STATUS[r.historyStatus]?.text || '—'}
              ${r.historyStatus === 'not_checked' ? html`<div class="spec-note"><strong>Reason:</strong>
                ${r.pendingHistoryProviders?.length
                  ? `${r.pendingHistoryProviders.map((p) => p.name).join(', ')} is set up but waiting for account credentials.`
                  : 'no authorised vehicle-history provider is configured.'}</div>` : ''}
              ${r.historyStatus === 'not_checked' && ctx.user.role === 'admin' ? html`<div class="spec-note">Enter provider credentials in
                <a href="#/admin/settings">Administration › Branding and data sources</a>, then use Re-check.</div>` : ''}
            </div>
            ${r.conflicts?.length ? html`<div class="bad"><h3>Conflicting values</h3>Sources disagree on
              ${r.conflicts.map((k) => SPEC_LABELS[k] || k).join(', ')}. Both values are shown below; verify against the vehicle and its documents.</div>` : ''}
          </div>
        </section>` : ''}

      <div class="layout-profile">
        <div>
          ${r ? html`
            <section class="card">
              <div class="card-head"><h2>Vehicle details and specifications</h2><span class="tag tag-ext">Decoded / external data</span></div>
              <div class="table-wrap"><table class="data">
                <thead><tr><th>Field</th><th>Value</th><th>Basis</th><th>Source</th></tr></thead>
                <tbody>${[...new Set([...ESSENTIAL, ...PROFILE_SPECS.filter((k) => specs[k])])].map((k) => specRow(k, specs[k]))}</tbody>
              </table></div>
              <div class="card-body small muted">
                <strong>Decoded from VIN</strong>: fixed by the VIN standard or manufacturer code.
                <strong>Estimated</strong>: most likely reading, not guaranteed. <strong>Provider</strong>: returned by an external source.
                <strong>Confirmed</strong>: several sources agree. Hover a source for its retrieval time.
              </div>
            </section>

            ${CATEGORIES.map((c) => categoryCard(c, r.records?.[c.key]))}
            ${r.records?.recalls && r.records.recalls.state !== 'unavailable' ? recallsCard(r.records.recalls) : ''}

            ${STRUCTURE_SPECS.some((k) => specs[k]) ? html`
              <section class="card">
                <div class="card-head"><h2>VIN structure analysis</h2><span class="tag tag-derived">Derived — not a record</span></div>
                <div class="card-body">
                  <p class="muted small">Interpreted offline from the characters of the VIN (ISO 3779 / 49 CFR 565). It describes what the VIN encodes and is not evidence of vehicle history.</p>
                  <table class="kv"><tbody>
                    ${STRUCTURE_SPECS.filter((k) => specs[k]).map((k) => html`<tr><th>${SPEC_LABELS[k]}</th><td>${specs[k].value}</td></tr>`)}
                  </tbody></table>
                </div>
              </section>` : ''}

            <section class="card">
              <div class="card-head"><h2>Data sources and retrieval</h2></div>
              <div class="table-wrap"><table class="data">
                <thead><tr><th>Source</th><th>Trust level</th><th>Result</th><th>Retrieved</th></tr></thead>
                <tbody>
                  ${(r.sources || []).map((src) => html`<tr>
                    <td><strong>${src.name}</strong></td>
                    <td>${src.trust === 'sample' ? html`<span class="pill pill-sample">${TRUST.sample}</span>` : TRUST[src.trust] || src.trust}</td>
                    <td>${({ match: 'Data returned', no_match: 'No matching record', skipped: html`Not queried — ${src.reason || ''}` })[src.status]
                      || html`<span class="pill pill-bad">Error</span> <span class="small">${src.error}</span>`}
                      ${(src.notes || []).map((n) => html`<div class="spec-note">${n}</div>`)}</td>
                    <td class="nowrap">${fmtDateTime(src.retrievedAt)}</td>
                  </tr>`)}
                </tbody>
              </table></div>
            </section>` : pending() ? html`<div class="card"><div class="loading"><span class="spinner"></span> Looking up this VIN…</div></div>` : ''}
        </div>
        <div id="staff-panel"></div>
      </div>`);
    renderStaff();
  }

  function statusNotice(i) {
    if (i.status === 'invalid') {
      return html`<div class="notice notice-bad"><strong>Invalid VIN</strong>The value entered (<span class="mono">${i.vinInput}</span>) is not a valid VIN.
        ${i.validation.errors.join(' ')} No data sources were queried.</div>`;
    }
    if (i.status === 'no_record') return html`<div class="notice notice-warn"><strong>No external record found</strong>${i.message || ''}
      Any details shown come from VIN structure analysis only.</div>`;
    if (i.status === 'error') return html`<div class="notice notice-bad"><strong>Lookup failed</strong>${i.message || ''} ${canWrite() ? 'Use “Retry lookup” to try again.' : ''}</div>`;
    if (i.status === 'partial') return html`<div class="notice notice-warn"><strong>Some sources failed</strong>${i.message || ''}</div>`;
    return '';
  }

  function recordsTable(cols, items) {
    return html`<div class="table-wrap"><table class="data">
      <thead><tr>${cols.map(([h]) => html`<th>${h}</th>`)}<th>Source / retrieved</th></tr></thead>
      <tbody>${items.map((row) => html`<tr>${cols.map(([h, fn]) => html`<td class="${/^(Date|From|To|Purchase date|Reported)$/.test(h) ? 'date' : ''}">${cell(fn(row))}</td>`)}
        <td>${sourceLabel(row._source)}<div class="spec-note">${fmtDateTime(row._source?.retrievedAt)}</div></td></tr>`)}</tbody>
    </table></div>`;
  }

  function categoryCard(c, rec) {
    const state = rec?.state || 'unavailable';
    return html`<section class="card">
      <div class="card-head"><h2>${c.title}</h2><span class="tag tag-ext">Vehicle history</span></div>
      ${state === 'records' ? recordsTable(c.cols, rec.items)
        : html`<div class="card-body"><div class="section-state ${['failed', 'unavailable'].includes(state) ? 'failed' : ''}">${stateText(rec || { state }, false)}</div></div>`}
    </section>`;
  }

  function recallsCard(rec) {
    return html`<section class="card">
      <div class="card-head"><h2>Safety recalls for this model</h2><span class="tag tag-derived">Model-level — not VIN-specific</span></div>
      <div class="card-body small muted">Recalls are issued for a make, model and year (US market data), not for this specific VIN.
        Whether a remedy was carried out on this vehicle must be confirmed with the manufacturer.</div>
      ${rec.state === 'records' ? recordsTable(RECALL_COLS, rec.items)
        : html`<div class="card-body"><div class="section-state ${rec.state === 'failed' ? 'failed' : ''}">${stateText(rec, true)}</div></div>`}
    </section>`;
  }

  function renderStaff() {
    const d = data.details.data || {};
    const ro = !canWrite();
    const opts = (list, v) => html`<option value="">— Not recorded —</option>${list.map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}`;
    mount($('#staff-panel', el), html`
      <form class="card staff" id="details-form" novalidate>
        <div class="card-head"><h2>Inspection and case details</h2><span class="tag tag-staff">Staff-entered</span></div>
        <div class="card-body">
          <p class="muted small">Recorded by agency staff — not from an external data source.
            ${data.details.updatedAt ? html`Last updated ${fmtDateTime(data.details.updatedAt)} by ${data.details.updatedByName || 'unknown'}.` : ''}</p>
          <fieldset ${ro ? 'disabled' : ''}>
            <div class="form-grid">
              <div class="field"><label for="d-checker">Checker name</label><input id="d-checker" type="text" name="checkerName" maxlength="120" value="${d.checkerName || ''}"></div>
              <div class="field"><label for="d-at">Date and time of check</label><input id="d-at" type="datetime-local" name="checkedAt" value="${d.checkedAt || ''}"></div>
              <div class="field"><label for="d-loc">Check location <span class="muted small">(optional)</span></label><input id="d-loc" type="text" name="location" maxlength="200" value="${d.location || ''}"></div>
              <div class="field"><label for="d-case">Case / contract reference</label><input id="d-case" type="text" name="caseReference" maxlength="100" value="${d.caseReference || ''}"></div>
              <div class="field"><label for="d-cond">Observed vehicle condition</label><select id="d-cond" name="vehicleCondition">${opts(ctx.config.conditionOptions, d.vehicleCondition)}</select></div>
              <div class="field span-all"><label for="d-find">Inspection findings</label><textarea id="d-find" name="inspectionFindings" maxlength="5000" rows="4"
                placeholder="What was seen on the vehicle supplied, e.g. condition, VIN plate match, visible damage">${d.inspectionFindings || ''}</textarea></div>
              <div class="field span-all"><label for="d-notes">Supporting notes</label><textarea id="d-notes" name="notes" maxlength="5000" rows="3">${d.notes || ''}</textarea></div>
              <div class="field span-all"><label for="d-ev">Evidence references</label><input id="d-ev" type="text" name="evidenceRefs" maxlength="2000" value="${d.evidenceRefs || ''}"
                placeholder="e.g. photo IDs, exhibit numbers, document references"></div>
            </div>
          </fieldset>
          ${ro ? html`<p class="muted small mt-1 mb-0">Your role is read-only.</p>` : ''}
        </div>
        ${ro ? '' : html`<div class="card-foot"><button type="submit" class="btn btn-staff">Save details</button><span class="muted small" id="save-state"></span></div>`}
      </form>`);
  }

  function collectDetails() {
    return Object.fromEntries(new FormData($('#details-form', el)));
  }

  async function poll() {
    if (stopped) return;
    try {
      await load();
      if (!pending()) {
        // Keep unsaved staff edits when the lookup completes.
        const draft = dirty ? collectDetails() : null;
        render();
        if (draft) restoreDraft(draft);
      }
    } catch { /* keep polling */ }
    if (pending()) timer = setTimeout(poll, 1200);
  }

  function restoreDraft(draft) {
    const form = $('#details-form', el);
    for (const [k, v] of Object.entries(draft)) if (form.elements[k]) form.elements[k].value = v;
    dirty = true;
  }

  async function requeue(b, body, label) {
    await busy(b, async () => {
      try {
        await post(`/api/searches/${id}/retry`, body);
        toast('Lookup queued.');
        await load();
        render();
        clearTimeout(timer);
        timer = setTimeout(poll, 800);
      } catch (err) { toast(err.message, 'error'); }
    }, label);
  }

  render();
  if (pending()) timer = setTimeout(poll, 800);

  const offs = [
    on(el, 'input', '#details-form', () => { dirty = true; const s = $('#save-state', el); if (s) s.textContent = 'Unsaved changes'; }),
    on(el, 'submit', '#details-form', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      await busy(btn, async () => {
        try {
          const r = await put(`/api/searches/${id}/items/${itemId}/details`, collectDetails());
          data.details = r.details;
          dirty = false;
          renderStaff();
          toast(r.changed.length ? 'Details saved.' : 'No changes to save.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      }, 'Saving…');
    }),
    on(el, 'click', '[data-action=pdf]', async (_e, b) => {
      if (dirty && canWrite()) toast('You have unsaved details — save them to include them in the report.', 'error');
      await busy(b, async () => {
        try { await download(`/api/searches/${id}/items/${itemId}/report.pdf?download=1`, 'report.pdf'); } catch (err) { toast(err.message, 'error'); }
      }, 'Generating…');
    }),
    on(el, 'click', '[data-action=retry]', (_e, b) => requeue(b, { itemIds: [Number(itemId)] }, 'Retrying…')),
    on(el, 'click', '[data-action=recheck]', async (_e, b) => {
      if (!(await confirmDialog('Re-check this VIN?', 'The VIN will be looked up again against the currently configured sources and the previous result replaced. Staff-entered details are kept.', { confirmLabel: 'Re-check' }))) return;
      await requeue(b, { itemIds: [Number(itemId)], recheck: true }, 'Queuing…');
    }),
  ];

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  return () => {
    stopped = true;
    clearTimeout(timer);
    offs.forEach((off) => off());
    window.removeEventListener('beforeunload', beforeUnload);
    if (dirty) toast('Unsaved inspection details were discarded.', 'error');
  };
}
