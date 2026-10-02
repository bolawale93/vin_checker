// VIN searches: create single/batch checks, history, results, staff details,
// retries and report downloads.
import express from 'express';
import archiver from 'archiver';
import { config } from '../config.js';
import { getDb, tx, nowIso } from '../db.js';
import { requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { reviewVinList } from '../../shared/vin.js';
import { pump, retryItems, refreshSearchStatus, RETRYABLE } from '../lookup-queue.js';
import {
  sanitizeDetails, getDetails, saveDetails, changedFields, ValidationError, COMMON_FIELDS, onlyKnownFields,
} from '../details.js';
import { vehicleReportPdf, batchReportPdf } from '../reports/pdf.js';
import { upgradeResult } from '../providers/index.js';
import { getBrand } from '../branding.js';

const router = express.Router();
const canWrite = requireRole('admin', 'staff');

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

function referenceFor(db) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.reportTimezone }).format(new Date()).replaceAll('-', '');
  const prefix = `VC-${day}-`;
  const row = db.prepare('SELECT reference FROM searches WHERE reference LIKE ? ORDER BY reference DESC LIMIT 1').get(`${prefix}%`);
  const next = row ? Number(row.reference.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function loadSearch(id) {
  const s = getDb()
    .prepare(`SELECT s.*, u.username, u.full_name AS user_full_name FROM searches s JOIN users u ON u.id = s.user_id WHERE s.id = ?`)
    .get(Number(id));
  if (s) s.common = s.common_details ? JSON.parse(s.common_details) : {};
  return s;
}

function itemSummary(row) {
  return {
    id: row.id, position: row.position, vin: row.vin, vinInput: row.vin_input,
    validation: JSON.parse(row.validation), status: row.lookup_status, message: row.message, attempts: row.attempts,
    make: row.make, model: row.model, year: row.year, vehicleStatus: row.vehicle_status, hasSample: !!row.has_sample,
    specStatus: row.spec_status, historyStatus: row.history_status,
    summaryMeta: row.summary_meta ? JSON.parse(row.summary_meta) : {},
    retrievedAt: row.retrieved_at, updatedAt: row.updated_at,
  };
}

function searchSummary(s) {
  return {
    id: s.id, reference: s.reference, type: s.type, caseReference: s.case_reference, location: s.location, notes: s.notes,
    checkerName: s.checker_name, userId: s.user_id, username: s.username, userFullName: s.user_full_name,
    status: s.status, total: s.total, createdAt: s.created_at, completedAt: s.completed_at, common: s.common,
  };
}

// ---------------------------------------------------------------------------
// Create a search (single or batch)
// ---------------------------------------------------------------------------
router.post('/', canWrite, (req, res) => {
  const body = req.body || {};
  const type = body.type === 'batch' ? 'batch' : 'single';
  const entries = Array.isArray(body.vins) ? body.vins.map((v) => String(v ?? '')).filter((v) => v.trim()) : [];
  if (!entries.length) return badRequest(res, 'Enter at least one VIN.');
  if (entries.length > config.maxBatchSize) return badRequest(res, `A batch may contain at most ${config.maxBatchSize} VINs.`);
  if (type === 'single' && entries.length !== 1) return badRequest(res, 'A single search must contain exactly one VIN.');

  // Location is optional: staff work from offices in several states.
  const location = str(body.location, 200);
  const caseReference = str(body.caseReference, 100);
  const notes = str(body.notes, 2000);
  const checkerName = str(body.checkerName, 120) || req.user.fullName;
  const checkedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.checkedAt || '') ? body.checkedAt.slice(0, 16) : '';

  const reviewed = reviewVinList(entries, { strictCheckDigit: config.strictCheckDigit });
  const items = reviewed.filter((r) => r.status !== 'duplicate');
  if (type === 'single' && !items[0].valid) {
    return res.status(400).json({ error: `Invalid VIN: ${items[0].errors.join(' ')}`, validation: items[0] });
  }
  const duplicates = reviewed.length - items.length;

  const common = { checkerName, checkedAt, location, caseReference };
  const id = tx((db) => {
    const now = nowIso();
    const reference = referenceFor(db);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO searches (reference, type, case_reference, location, notes, user_id, checker_name, status, total,
                common_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`)
      .run(reference, type, caseReference || null, location || null, notes || null, req.user.id, checkerName, items.length,
        JSON.stringify(common), now);
    const insItem = db.prepare(`INSERT INTO search_items (search_id, position, vin_input, vin, validation, lookup_status,
                                message, vehicle_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insDetails = db.prepare(`INSERT INTO item_details (item_id, data, updated_by, updated_by_name, updated_at)
                                   VALUES (?, ?, ?, ?, ?)`);
    items.forEach((r, i) => {
      const validation = { valid: r.valid, errors: r.errors, warnings: r.warnings };
      const status = r.valid ? 'queued' : 'invalid';
      const info = insItem.run(lastInsertRowid, i + 1, r.input.slice(0, 64), r.vin.slice(0, 64), JSON.stringify(validation), status,
        r.valid ? null : r.errors.join(' '), r.valid ? null : 'Invalid VIN', now);
      insDetails.run(info.lastInsertRowid, JSON.stringify(common), req.user.id, req.user.fullName, now);
    });
    return Number(lastInsertRowid);
  });

  refreshSearchStatus(id);
  const s = loadSearch(id);
  audit(req, 'search.create', {
    entityType: 'search', entityId: s.reference,
    details: {
      type, vins: items.length, invalid: items.filter((r) => !r.valid).length, duplicatesRemoved: duplicates,
      caseReference: caseReference || null, location: location || null, source: str(body.source, 20) || null,
      ...(type === 'single' ? { vin: items[0].vin } : {}),
    },
  });
  pump();
  res.status(201).json({ id, reference: s.reference, duplicatesRemoved: duplicates });
});

// ---------------------------------------------------------------------------
// History / search list with filters
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  if (q.vin) {
    where.push('s.id IN (SELECT search_id FROM search_items WHERE vin LIKE ? OR vin_input LIKE ?)');
    const v = `%${String(q.vin).toUpperCase().replace(/[\s-]/g, '')}%`;
    params.push(v, `%${String(q.vin).trim()}%`);
  }
  if (q.ref) {
    where.push('(s.reference LIKE ? OR s.case_reference LIKE ? OR s.id IN (SELECT i.search_id FROM search_items i JOIN item_details d ON d.item_id = i.id WHERE json_extract(d.data, \'$.caseReference\') LIKE ?))');
    const r = `%${String(q.ref).trim()}%`;
    params.push(r, r, r);
  }
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
  // Day boundaries use the server's local time zone.
  if (isDate(q.from)) { where.push('s.created_at >= ?'); params.push(new Date(`${q.from}T00:00:00`).toISOString()); }
  if (isDate(q.to)) { where.push('s.created_at < ?'); params.push(new Date(new Date(`${q.to}T00:00:00`).getTime() + 86400_000).toISOString()); }
  if (q.userId) { where.push('s.user_id = ?'); params.push(Number(q.userId)); }
  if (q.location) { where.push('s.location LIKE ?'); params.push(`%${String(q.location).trim()}%`); }
  if (q.type === 'single' || q.type === 'batch') { where.push('s.type = ?'); params.push(q.type); }
  if (['processing', 'completed', 'completed_with_errors'].includes(q.status)) { where.push('s.status = ?'); params.push(q.status); }
  const outcomeFilters = {
    found: "lookup_status = 'found'",
    no_record: "lookup_status = 'no_record'",
    invalid: "lookup_status = 'invalid'",
    failed: "lookup_status IN ('error','partial')",
    stolen: "vehicle_status LIKE '%stolen%'",
    salvage: "(vehicle_status LIKE '%salvage%' OR vehicle_status LIKE '%written off%')",
    accident: "vehicle_status LIKE '%accident%'",
    sample: 'has_sample = 1',
  };
  if (outcomeFilters[q.result]) where.push(`s.id IN (SELECT search_id FROM search_items WHERE ${outcomeFilters[q.result]})`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const page = Math.max(1, Number(q.page) || 1);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) n FROM searches s ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(`SELECT s.*, u.username, u.full_name AS user_full_name FROM searches s JOIN users u ON u.id = s.user_id
              ${whereSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);

  const ids = rows.map((r) => r.id);
  const counts = {};
  const firstItem = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const c of db.prepare(`SELECT search_id, lookup_status s, COUNT(*) n, MAX(has_sample) sample FROM search_items
                                WHERE search_id IN (${ph}) GROUP BY search_id, lookup_status`).all(...ids)) {
      counts[c.search_id] ??= { sample: false };
      counts[c.search_id][c.s] = c.n;
      if (c.sample) counts[c.search_id].sample = true;
    }
    for (const r of db.prepare(`SELECT search_id, vin, make, model, year, vehicle_status FROM search_items
                                WHERE search_id IN (${ph}) AND position = 1`).all(...ids)) firstItem[r.search_id] = r;
  }
  let matchedVins = {};
  if (q.vin && ids.length) {
    const v = `%${String(q.vin).toUpperCase().replace(/[\s-]/g, '')}%`;
    for (const r of db.prepare(`SELECT search_id, vin FROM search_items WHERE search_id IN (${ids.map(() => '?').join(',')}) AND vin LIKE ?`).all(...ids, v)) {
      (matchedVins[r.search_id] ??= []).push(r.vin);
    }
  }
  res.json({
    total, page, pageSize,
    rows: rows.map((r) => {
      loadCommon(r);
      return {
        ...searchSummary(r),
        counts: counts[r.id] || {},
        first: r.type === 'single' ? firstItem[r.id] || null : null,
        matchedVins: matchedVins[r.id] || [],
      };
    }),
  });
});

function loadCommon(r) {
  r.common = r.common_details ? JSON.parse(r.common_details) : {};
}

// ---------------------------------------------------------------------------
// Single search with item statuses (polled for progress)
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const s = loadSearch(req.params.id);
  if (!s) return res.status(404).json({ error: 'Search not found.' });
  const items = getDb().prepare('SELECT * FROM search_items WHERE search_id = ? ORDER BY position').all(s.id);
  res.json({ search: searchSummary(s), items: items.map(itemSummary) });
});

function loadItem(searchId, itemId) {
  const row = getDb().prepare('SELECT * FROM search_items WHERE id = ? AND search_id = ?').get(Number(itemId), Number(searchId));
  if (row) row.result = row.result ? upgradeResult(JSON.parse(row.result)) : null;
  return row;
}

router.get('/:id/items/:itemId', (req, res) => {
  const s = loadSearch(req.params.id);
  const item = s && loadItem(s.id, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Vehicle record not found.' });
  const nav = getDb()
    .prepare(`SELECT (SELECT id FROM search_items WHERE search_id = ? AND position < ? ORDER BY position DESC LIMIT 1) prev,
                     (SELECT id FROM search_items WHERE search_id = ? AND position > ? ORDER BY position ASC LIMIT 1) next`)
    .get(s.id, item.position, s.id, item.position);
  res.json({
    search: searchSummary(s),
    item: { ...itemSummary(item), result: item.result },
    details: getDetails(item.id),
    nav,
  });
});

// ---------------------------------------------------------------------------
// Staff-entered details
// ---------------------------------------------------------------------------
router.put('/:id/items/:itemId/details', canWrite, (req, res) => {
  const s = loadSearch(req.params.id);
  const item = s && loadItem(s.id, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Vehicle record not found.' });
  let data;
  try {
    data = sanitizeDetails(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(res, err.message);
    throw err;
  }
  const before = getDetails(item.id).data;
  const after = { ...before, ...data };
  saveDetails(item.id, after, req.user);
  const changed = changedFields(before, after);
  if (changed.length) {
    audit(req, 'details.update', { entityType: 'vehicle', entityId: `${s.reference}#${item.position} ${item.vin}`, details: { fields: changed } });
  }
  res.json({ details: getDetails(item.id), changed });
});

router.put('/:id/common', canWrite, (req, res) => {
  const s = loadSearch(req.params.id);
  if (!s) return res.status(404).json({ error: 'Search not found.' });
  const mode = req.body?.apply;
  if (mode && !['fill', 'overwrite'].includes(mode)) return badRequest(res, 'Invalid apply mode.');
  let common;
  try {
    common = sanitizeDetails(req.body?.details || {}, { fields: COMMON_FIELDS });
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(res, err.message);
    throw err;
  }
  const merged = onlyKnownFields({ ...s.common, ...common });
  let updated = 0;
  tx((db) => {
    db.prepare('UPDATE searches SET common_details = ? WHERE id = ?').run(JSON.stringify(merged), s.id);
    if (merged.caseReference !== undefined) db.prepare('UPDATE searches SET case_reference = ? WHERE id = ?').run(merged.caseReference || null, s.id);
    if (merged.location) db.prepare('UPDATE searches SET location = ? WHERE id = ?').run(merged.location, s.id);
    if (merged.checkerName) db.prepare('UPDATE searches SET checker_name = ? WHERE id = ?').run(merged.checkerName, s.id);
    if (mode) {
      const items = db.prepare('SELECT id FROM search_items WHERE search_id = ?').all(s.id);
      for (const { id } of items) {
        const before = getDetails(id).data;
        const after = { ...before };
        for (const [k, v] of Object.entries(common)) {
          if (!v) continue;
          if (mode === 'overwrite' || !after[k]) after[k] = v;
        }
        if (changedFields(before, after).length) {
          saveDetails(id, after, req.user);
          updated++;
        }
      }
    }
  });
  audit(req, mode ? 'details.apply_common' : 'details.common_update', {
    entityType: 'search', entityId: s.reference,
    details: { fields: Object.keys(common).filter((k) => common[k]), mode: mode || null, vehiclesUpdated: updated },
  });
  res.json({ common: merged, updated });
});

// ---------------------------------------------------------------------------
// Retry failed lookups
// ---------------------------------------------------------------------------
router.post('/:id/retry', canWrite, (req, res) => {
  const s = loadSearch(req.params.id);
  if (!s) return res.status(404).json({ error: 'Search not found.' });
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.filter((n) => Number.isInteger(Number(n))) : null;
  const recheck = req.body?.recheck === true;
  const queued = retryItems(s.id, itemIds, { recheck });
  if (!queued) {
    return badRequest(res, recheck
      ? 'Nothing to re-check. Lookups still in progress and invalid VINs cannot be re-checked.'
      : `Nothing to retry. Only items with outcome ${RETRYABLE.join(' or ')} can be retried.`);
  }
  audit(req, recheck ? 'search.recheck' : 'search.retry', { entityType: 'search', entityId: s.reference, details: { items: queued } });
  res.json({ queued });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_');

async function buildVehiclePdf(s, item, req, generatedAt) {
  return vehicleReportPdf({
    brand: getBrand(), search: s, item, details: getDetails(item.id),
    generatedBy: `${req.user.fullName} (${req.user.username})`, generatedAt,
    reportRef: `${s.reference}-${String(item.position).padStart(3, '0')}`,
  });
}

async function buildBatchPdf(s, req, generatedAt) {
  const items = getDb().prepare('SELECT * FROM search_items WHERE search_id = ? ORDER BY position').all(s.id)
    .map((r) => ({
      ...r,
      result: r.result ? upgradeResult(JSON.parse(r.result)) : null,
      summaryMeta: r.summary_meta ? JSON.parse(r.summary_meta) : {},
    }));
  const pdf = await batchReportPdf({
    brand: getBrand(), search: s, items, common: s.common,
    generatedBy: `${req.user.fullName} (${req.user.username})`, generatedAt, reportRef: `${s.reference}-SUMMARY`,
  });
  return { pdf, items };
}

function sendPdf(res, buf, filename, download) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(buf);
}

router.get('/:id/items/:itemId/report.pdf', async (req, res) => {
  const s = loadSearch(req.params.id);
  const item = s && loadItem(s.id, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Vehicle record not found.' });
  const pdf = await buildVehiclePdf(s, item, req, nowIso());
  audit(req, 'report.vehicle', { entityType: 'vehicle', entityId: `${s.reference}#${item.position} ${item.vin}` });
  sendPdf(res, pdf, `${safeName(s.reference)}_${safeName(item.vin || `item${item.position}`)}.pdf`, req.query.download === '1');
});

router.get('/:id/report.pdf', async (req, res) => {
  const s = loadSearch(req.params.id);
  if (!s) return res.status(404).json({ error: 'Search not found.' });
  const { pdf } = await buildBatchPdf(s, req, nowIso());
  audit(req, 'report.batch', { entityType: 'search', entityId: s.reference });
  sendPdf(res, pdf, `${safeName(s.reference)}_summary.pdf`, req.query.download === '1');
});

router.get('/:id/reports.zip', async (req, res) => {
  const s = loadSearch(req.params.id);
  if (!s) return res.status(404).json({ error: 'Search not found.' });
  if (s.status === 'processing') {
    return res.status(409).json({ error: 'This search is still processing. Download the reports when all lookups are complete.' });
  }
  const generatedAt = nowIso();
  const { pdf: summary, items } = await buildBatchPdf(s, req, generatedAt);
  const vehicles = items.filter((i) => i.lookup_status !== 'invalid');
  const files = [];
  for (const item of vehicles) {
    files.push({
      name: `vehicles/${String(item.position).padStart(3, '0')}_${safeName(item.vin)}.pdf`,
      buf: await buildVehiclePdf(s, item, req, generatedAt),
    });
  }
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${safeName(s.reference)}_reports.zip"`);
  res.set('Cache-Control', 'no-store');
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  zip.append(summary, { name: `${safeName(s.reference)}_summary.pdf` });
  for (const f of files) zip.append(f.buf, { name: f.name });
  const skipped = items.length - vehicles.length;
  zip.append(
    [
      `Search reference: ${s.reference}`,
      `Generated: ${generatedAt} by ${req.user.fullName} (${req.user.username})`,
      `Summary report: ${safeName(s.reference)}_summary.pdf`,
      `Vehicle reports: ${files.length}`,
      skipped ? `Invalid VINs without an individual report: ${skipped} (listed in the summary report)` : '',
      items.some((i) => i.has_sample) ? 'WARNING: contains development SAMPLE DATA — not verified.' : '',
    ].filter(Boolean).join('\r\n') + '\r\n',
    { name: 'README.txt' },
  );
  await zip.finalize();
  audit(req, 'report.zip', { entityType: 'search', entityId: s.reference, details: { vehicleReports: files.length } });
});

export default router;
