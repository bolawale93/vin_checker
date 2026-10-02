// Shared labels and formatting for reports and API responses.
import { config } from '../config.js';

export const OUTCOME_LABELS = {
  queued: 'Pending',
  processing: 'Processing',
  found: 'Vehicle details found',
  partial: 'Partial — some sources failed',
  no_record: 'No external record found',
  error: 'Lookup failed',
  invalid: 'Invalid VIN',
};

export const TRUST_LABELS = {
  verified: 'Authorised / official source',
  unverified: 'Unverified source',
  sample: 'SAMPLE DATA — not verified',
  derived: 'Derived from VIN characters (not a vehicle record)',
};

export const BASIS_TEXT = {
  confirmed: 'Confirmed by multiple sources',
  provider: 'From provider',
  decoded: 'Decoded from VIN',
  estimated: 'Estimated from VIN',
  ambiguous: 'Ambiguous',
  sample: 'Sample — not verified',
};
export const BASIS_SHORT = { decoded: 'dec.', estimated: 'est.', sample: 'sample' };

export const SPEC_STATUS_TEXT = {
  provider: 'Decoded by an external provider.',
  failed: 'The external decoder failed — values shown are from VIN structure analysis only. Retry the lookup.',
  sample: 'Only development sample data returned specifications (not verified).',
  not_found: 'External decoder(s) did not recognise this VIN — values shown are from VIN structure analysis only.',
  vin_only: 'No external decoder is configured — values shown are from VIN structure analysis only.',
};

export const HISTORY_STATUS_TEXT = {
  records: 'History records were returned by a live source (see below).',
  no_records: 'The configured history source(s) returned no records. This does not prove the vehicle has never been damaged.',
  not_found: 'This VIN was not found in the configured history source(s). This does not prove the vehicle has no history.',
  failed: 'The history source(s) returned an error. History could not be checked — retry the lookup.',
  partial: 'Some history sources failed; history may be incomplete. Retry the lookup.',
  not_checked: 'NOT CHECKED — accident, damage, theft and ownership history has not been checked against any live source. VIN decoding is not evidence of accident history.',
};

const names = (sources, statuses) => sources.filter((s) => statuses.includes(s.status)).map((s) => s.name).join(', ');

/** Explanation for a category with no records to show. */
export function stateText(rec, { modelLevel = false } = {}) {
  const src = rec.sources || [];
  const sampleNote = rec.sampleOnly ? ' Only development sample data covers this category — no live source was checked.' : '';
  switch (rec.state) {
    case 'none':
      return modelLevel
        ? `No recalls were returned by ${names(src, ['match'])} for this model.`
        : `No records were returned by ${names(src, ['match'])}. This does not prove that no such event occurred.${sampleNote}`;
    case 'not_found':
      return `This vehicle was not found in ${names(src, ['no_match'])}.${sampleNote}`;
    case 'failed':
      return `Could not be retrieved: ${src.filter((s) => s.status === 'error').map((s) => `${s.name} — ${s.error}`).join('; ')}. Retry the lookup.`;
    case 'skipped':
      return `Not checked: ${src.filter((s) => s.reason).map((s) => s.reason).join(' ') || 'prerequisites not met.'}`;
    default:
      return 'Not checked — no configured data source covers this information.';
  }
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const s = new Intl.DateTimeFormat(config.reportLocale, {
    timeZone: config.reportTimezone, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${s} (${config.reportTimezone})`;
}

/** Staff-entered "YYYY-MM-DDTHH:mm" local value. */
export function fmtLocalDateTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 16);
}

export function sourceShort(src) {
  if (!src) return '—';
  if (src.trust === 'sample') return 'Sample data (not verified)';
  if (src.trust === 'unverified') return `${src.name} (unverified)`;
  if (src.trust === 'derived') return 'VIN structure analysis';
  return src.name;
}
