// Searchable history of single and batch checks.
import { html, mount, $, on } from '../html.js';
import { get, qs } from '../api.js';
import { navigate } from '../app.js';
import { searchStatusPill, outcomePill, vehicleStatusPill, sampleBadge, fmtDateTime, loading } from '../ui.js';

const RESULT_OPTIONS = [
  ['', 'Any result'], ['found', 'Record found'], ['no_record', 'No record found'], ['failed', 'Lookup failed'],
  ['invalid', 'Invalid VIN'], ['stolen', 'Reported stolen'], ['salvage', 'Salvage / written off'], ['accident', 'Accident record'],
  ['sample', 'Contains sample data'],
];
const STATUS_OPTIONS = [['', 'Any status'], ['processing', 'Processing'], ['completed', 'Completed'], ['completed_with_errors', 'Completed with failures']];
const FIELDS = ['vin', 'ref', 'from', 'to', 'userId', 'location', 'status', 'result', 'type', 'page'];

export default async function historyView(el, _params, query) {
  const f = Object.fromEntries(FIELDS.map((k) => [k, query.get(k) || '']));
  let users = [];
  try {
    users = (await get('/api/admin/users/directory')).users;
  } catch { /* filter falls back to empty list */ }

  const sel = (name, options, value) => html`<select name="${name}" id="h-${name}">${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`)}</select>`;

  mount(el, html`
    <div class="page-head">
      <div><h1 tabindex="-1">Search history</h1><p class="sub">All single and batch VIN checks. Open a check to review results and download reports.</p></div>
      <a class="btn btn-primary" href="#/">New VIN search</a>
    </div>
    <form class="card" id="filters" role="search">
      <div class="card-body">
        <div class="form-grid">
          <div class="field"><label for="h-vin">VIN</label><input id="h-vin" name="vin" type="search" value="${f.vin}" placeholder="Full or partial VIN" class="mono"></div>
          <div class="field"><label for="h-ref">Search or case reference</label><input id="h-ref" name="ref" type="search" value="${f.ref}" placeholder="VC-… or case number"></div>
          <div class="field"><label for="h-from">From date</label><input id="h-from" name="from" type="date" value="${f.from}"></div>
          <div class="field"><label for="h-to">To date</label><input id="h-to" name="to" type="date" value="${f.to}"></div>
          <div class="field"><label for="h-userId">Staff member</label>
            ${sel('userId', [['', 'Anyone'], ...users.map((u) => [u.id, `${u.fullName} (${u.username})`])], f.userId)}</div>
          <div class="field"><label for="h-location">Location</label><input id="h-location" name="location" type="search" value="${f.location}"></div>
          <div class="field"><label for="h-status">Search status</label>${sel('status', STATUS_OPTIONS, f.status)}</div>
          <div class="field"><label for="h-result">Vehicle result</label>${sel('result', RESULT_OPTIONS, f.result)}</div>
          <div class="field"><label for="h-type">Type</label>${sel('type', [['', 'Single and batch'], ['single', 'Single'], ['batch', 'Batch']], f.type)}</div>
        </div>
      </div>
      <div class="card-foot">
        <button class="btn btn-primary" type="submit">Apply filters</button>
        <button class="btn" type="button" data-action="clear">Clear</button>
      </div>
    </form>
    <div class="card" id="results">${loading('Loading history…')}</div>`);

  const form = $('#filters', el);
  const apply = (page = 1) => {
    const params = Object.fromEntries(new FormData(form));
    params.page = page > 1 ? page : '';
    navigate(`/history${qs(params)}`);
  };

  let data;
  try {
    data = await get(`/api/searches${qs({ ...f, pageSize: 25 })}`);
  } catch (err) {
    mount($('#results', el), html`<div class="empty"><h3>Could not load history</h3><p>${err.message}</p><button class="btn" data-action="reload">Try again</button></div>`);
    return;
  }

  const filtered = FIELDS.some((k) => k !== 'page' && f[k]);
  if (!data.rows.length) {
    mount($('#results', el), filtered
      ? html`<div class="empty"><h3>No checks match these filters</h3><p>Try widening the date range or clearing some filters.</p></div>`
      : html`<div class="empty"><h3>No VIN checks yet</h3><p>Checks you and your colleagues run will appear here.</p><a class="btn btn-primary" href="#/">Run a VIN check</a></div>`);
  } else {
    const pages = Math.ceil(data.total / data.pageSize);
    mount($('#results', el), html`
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Reference</th><th>Type</th><th>Vehicle(s)</th><th>Case ref.</th><th>Checked by</th><th>Location</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>
          ${data.rows.map((r) => {
            const c = r.counts || {};
            return html`<tr class="clickable" data-id="${r.id}">
              <td class="mono nowrap"><a href="#/searches/${r.id}">${r.reference}</a></td>
              <td>${r.type === 'batch' ? html`<span class="pill pill-info">Batch · ${r.total}</span>` : html`<span class="pill pill-neutral">Single</span>`}</td>
              <td>${r.type === 'single' && r.first
                ? html`<div class="mono">${r.first.vin || '—'}</div><div class="small">${[r.first.year, r.first.make, r.first.model].filter(Boolean).join(' ') || ''}</div>
                   <div>${outcomePill(Object.keys(c).find((k) => k !== 'sample'))} ${vehicleStatusPill(r.first.vehicle_status)}</div>`
                : html`<div class="small">
                    ${c.found ? html`<span class="pill pill-ok">${c.found} found</span> ` : ''}
                    ${c.no_record ? html`<span class="pill pill-warn">${c.no_record} no record</span> ` : ''}
                    ${(c.error || 0) + (c.partial || 0) ? html`<span class="pill pill-bad">${(c.error || 0) + (c.partial || 0)} failed</span> ` : ''}
                    ${c.invalid ? html`<span class="pill pill-bad">${c.invalid} invalid</span> ` : ''}
                    ${(c.queued || 0) + (c.processing || 0) ? html`<span class="pill pill-info">${(c.queued || 0) + (c.processing || 0)} pending</span>` : ''}
                  </div>
                  ${r.matchedVins.length ? html`<div class="small mono muted">Matches: ${r.matchedVins.slice(0, 3).join(', ')}${r.matchedVins.length > 3 ? '…' : ''}</div>` : ''}`}
                ${c.sample ? sampleBadge() : ''}</td>
              <td>${r.caseReference || html`<span class="missing">—</span>`}</td>
              <td>${r.checkerName}<div class="small muted">${r.username}</div></td>
              <td>${r.location || '—'}</td>
              <td class="nowrap">${fmtDateTime(r.createdAt)}</td>
              <td>${searchStatusPill(r.status)}</td>
            </tr>`;
          })}
        </tbody>
      </table></div>
      <div class="pager">
        <span>${data.total} check${data.total === 1 ? '' : 's'} · page ${data.page} of ${pages}</span>
        <span class="inline">
          <button class="btn btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>‹ Previous</button>
          <button class="btn btn-sm" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>Next ›</button>
        </span>
      </div>`);
  }

  // Single checks open straight to the vehicle page.
  const singleItem = {};
  for (const r of data.rows) if (r.type === 'single') singleItem[r.id] = true;

  const offs = [
    on(el, 'submit', '#filters', (e) => { e.preventDefault(); apply(1); }),
    on(el, 'click', '[data-action=clear]', () => navigate('/history')),
    on(el, 'click', '[data-page]', (_e, b) => apply(Number(b.dataset.page))),
    on(el, 'click', 'tr.clickable', async (e, tr) => {
      if (e.target.closest('a,button')) return;
      const sid = tr.dataset.id;
      if (singleItem[sid]) {
        try {
          const { items } = await get(`/api/searches/${sid}`);
          navigate(`/searches/${sid}/items/${items[0].id}`);
        } catch { navigate(`/searches/${sid}`); }
      } else navigate(`/searches/${sid}`);
    }),
  ];
  return () => offs.forEach((off) => off());
}
