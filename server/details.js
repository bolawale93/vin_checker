// Staff-entered inspection / case details. Stored separately from provider
// data so the two can never be confused.
import { getDb, nowIso } from './db.js';

export const CONDITION_OPTIONS = ['Good', 'Fair', 'Poor', 'Damaged', 'Not roadworthy', 'Not inspected'];

export const DETAIL_FIELDS = {
  checkerName: { label: 'Checker name', max: 120 },
  checkedAt: { label: 'Date and time of check', type: 'datetime' },
  location: { label: 'Check location', max: 200 },
  caseReference: { label: 'Case / contract reference', max: 100 },
  vehicleCondition: { label: 'Observed vehicle condition', options: CONDITION_OPTIONS },
  inspectionFindings: { label: 'Inspection findings', max: 5000 },
  notes: { label: 'Supporting notes', max: 5000 },
  evidenceRefs: { label: 'Evidence references', max: 2000 },
};

// Fields that can be applied across a batch (all of them).
export const COMMON_FIELDS = Object.keys(DETAIL_FIELDS);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export class ValidationError extends Error {}

function cleanField(key, value) {
  const def = DETAIL_FIELDS[key];
  const s = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  if (def.options && !def.options.includes(s)) throw new ValidationError(`${def.label}: invalid option.`);
  if (def.type === 'date' && !DATE_RE.test(s)) throw new ValidationError(`${def.label}: use YYYY-MM-DD.`);
  if (def.type === 'datetime' && !DATETIME_RE.test(s)) throw new ValidationError(`${def.label}: invalid date/time.`);
  if (def.max && s.length > def.max) throw new ValidationError(`${def.label}: maximum ${def.max} characters.`);
  return s;
}

/** Validate and normalise a details payload. Unknown keys are dropped. */
export function sanitizeDetails(input, { fields = Object.keys(DETAIL_FIELDS) } = {}) {
  const out = {};
  for (const key of fields) {
    if (input && key in input) out[key] = cleanField(key, input[key]);
  }
  return out;
}

/** Keep only currently supported fields (drops any legacy keys). */
export function onlyKnownFields(data) {
  return Object.fromEntries(Object.entries(data || {}).filter(([k]) => k in DETAIL_FIELDS));
}

export function getDetails(itemId) {
  const row = getDb().prepare('SELECT * FROM item_details WHERE item_id = ?').get(itemId);
  if (!row) return { data: {}, updatedAt: null, updatedByName: null };
  return { data: onlyKnownFields(JSON.parse(row.data)), updatedAt: row.updated_at, updatedByName: row.updated_by_name };
}

export function saveDetails(itemId, data, user) {
  getDb()
    .prepare(`INSERT INTO item_details (item_id, data, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(item_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by,
              updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`)
    .run(itemId, JSON.stringify(onlyKnownFields(data)), user?.id ?? null, user?.fullName ?? null, nowIso());
}

/** Fields that differ between two detail objects (for the audit log). */
export function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? '') !== JSON.stringify(after?.[k] ?? ''));
}
