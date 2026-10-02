// Background processing of VIN lookups. Every VIN is its own database row and
// is processed independently, so one failure never blocks the others. Work is
// persisted, so queued lookups resume if the server restarts.
import { config } from './config.js';
import { getDb, nowIso } from './db.js';
import { lookupVin, summaryFields } from './providers/index.js';

let active = 0;
let pumping = false;

export const RETRYABLE = ['error', 'partial'];

export function resumePending() {
  getDb().prepare("UPDATE search_items SET lookup_status = 'queued' WHERE lookup_status = 'processing'").run();
  pump();
}

export function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const db = getDb();
    while (active < config.lookupConcurrency) {
      const item = db
        .prepare("SELECT id, search_id, vin FROM search_items WHERE lookup_status = 'queued' ORDER BY search_id, position LIMIT 1")
        .get();
      if (!item) break;
      db.prepare("UPDATE search_items SET lookup_status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), item.id);
      active++;
      processItem(item).finally(() => {
        active--;
        pump();
      });
    }
  } finally {
    pumping = false;
  }
}

async function processItem(item) {
  const db = getDb();
  try {
    const result = await lookupVin(item.vin);
    const s = summaryFields(result);
    db.prepare(`UPDATE search_items SET lookup_status = ?, message = ?, make = ?, model = ?, year = ?, vehicle_status = ?,
                has_sample = ?, result = ?, retrieved_at = ?, updated_at = ?, spec_status = ?, history_status = ?, summary_meta = ?
                WHERE id = ?`)
      .run(result.outcome, result.message, s.make, s.model, s.year, result.vehicleStatus, result.hasSample ? 1 : 0,
        JSON.stringify(result), nowIso(), nowIso(), result.specStatus, result.historyStatus, JSON.stringify(s.meta), item.id);
  } catch (err) {
    db.prepare("UPDATE search_items SET lookup_status = 'error', message = ?, vehicle_status = 'Lookup failed', updated_at = ? WHERE id = ?")
      .run(`Unexpected error: ${String(err?.message || err).slice(0, 300)}`, nowIso(), item.id);
  }
  refreshSearchStatus(item.search_id);
}

export function refreshSearchStatus(searchId) {
  const db = getDb();
  const counts = db
    .prepare('SELECT lookup_status s, COUNT(*) n FROM search_items WHERE search_id = ? GROUP BY lookup_status')
    .all(searchId);
  const c = Object.fromEntries(counts.map((r) => [r.s, r.n]));
  const pending = (c.queued || 0) + (c.processing || 0);
  let status;
  if (pending) status = 'processing';
  else if (c.error || c.partial) status = 'completed_with_errors';
  else status = 'completed';
  const prev = db.prepare('SELECT status FROM searches WHERE id = ?').get(searchId)?.status;
  if (status === 'processing') {
    db.prepare('UPDATE searches SET status = ?, completed_at = NULL WHERE id = ?').run(status, searchId);
  } else if (prev === 'processing') {
    db.prepare('UPDATE searches SET status = ?, completed_at = ? WHERE id = ?').run(status, nowIso(), searchId);
  } else {
    db.prepare('UPDATE searches SET status = ? WHERE id = ?').run(status, searchId);
  }
  return status;
}

/** Statuses that a full re-check (fresh lookup against current sources) may re-queue. */
export const RECHECKABLE = ['found', 'partial', 'no_record', 'error'];

/**
 * Re-queue items. By default only failed items; with recheck=true, every
 * completed (non-invalid) item is looked up again against the current sources.
 * Returns the number of items queued.
 */
export function retryItems(searchId, itemIds = null, { recheck = false } = {}) {
  const db = getDb();
  const statuses = recheck ? RECHECKABLE : RETRYABLE;
  const placeholders = statuses.map(() => '?').join(',');
  let sql = `UPDATE search_items SET lookup_status = 'queued', message = NULL, updated_at = ?
             WHERE search_id = ? AND lookup_status IN (${placeholders})`;
  const params = [nowIso(), searchId, ...statuses];
  if (itemIds?.length) {
    sql += ` AND id IN (${itemIds.map(() => '?').join(',')})`;
    params.push(...itemIds.map(Number));
  }
  const { changes } = db.prepare(sql).run(...params);
  if (changes) {
    refreshSearchStatus(searchId);
    pump();
  }
  return changes;
}
