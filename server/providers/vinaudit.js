// VinAudit vehicle-history provider (NMVTIS-approved data provider, USA/Canada).
// Docs: https://data.vinaudit.com/docs/api/vin/vehicle-history
//
// Supplies: accident/crash reports, salvage-auction damage listings, theft and
// recovery (NICB), junk/salvage/insurance total-loss records (NMVTIS), title
// brands (flood, rebuilt, odometer…), title/odometer history, liens and sale
// listings. Requires a paid VinAudit API account (key + username + password),
// set by an administrator in the app or via VINAUDIT_* environment variables.
//
// Flow: GET /v2/query (returns a report id) → GET /v2/pullreport (the report).
// VinAudit returns the same report for the same id within 90 days without a
// new charge, so ids are stored and reused for VINAUDIT_REUSE_DAYS.
import { config } from '../config.js';
import { getDb, getSetting, nowIso } from '../db.js';

// NMVTIS title brand codes (source: Texas DMV "NMVTIS to Texas Conversion Chart", rev. 12/2020).
export const NMVTIS_BRANDS = {
  '01': 'Flood damage', '02': 'Fire damage', '04': 'Salt water damage', '07': 'Dismantled', '08': 'Junk',
  '09': 'Rebuilt', '10': 'Reconstructed', '11': 'Salvage (damage or not specified)', '16': 'Salvage retention',
  '23': 'Warranty return', '28': 'Street rod', '30': 'Replica', '31': 'Totaled', '32': 'Owner retained',
  '34': 'Memorandum copy', '38': 'Prior owner retained', '43': 'VIN replaced by new state-assigned VIN',
  '45': 'Gray market', '47': 'Manufacturer buy back', '50': 'Salvage (reasons other than damage or stolen)',
  '52': 'Prior non-repairable / repaired', '53': 'Crushed', '56': 'Export only vehicle', '68': 'Odometer: actual',
  '69': 'Odometer: not actual', '70': 'Odometer: not actual — tampering verified', '71': 'Exempt from odometer disclosure',
  '72': 'Odometer exceeds mechanical limits', '73': 'Odometer may be altered', '74': 'Odometer replaced',
  '76': 'Odometer discrepancy', '77': 'Call title division', '90': 'Pending junk automobile (CARS.gov)',
  '91': 'Junk automobile (CARS.gov)',
};

const ERRORS = {
  unauthorized_request: 'VinAudit rejected the credentials (unauthorized_request). Check the API key, username and password, and that the account has API access.',
  billing_limit_exceeded: 'VinAudit account balance or billing limit reached (billing_limit_exceeded). Top up the account, then retry.',
  rate_limit_exceeded: 'VinAudit usage limit reached (rate_limit_exceeded). Retry later.',
  incomplete_report: 'NMVTIS was temporarily unavailable to VinAudit (incomplete_report). Retry later.',
  failed_request: 'VinAudit rejected the request (failed_request).',
  invalid_test_vin: 'VinAudit is in test mode and this VIN is not an approved test VIN. Switch the mode to production.',
};

const SETTING_KEYS = ['key', 'user', 'pass', 'mode'];

/** Effective settings: environment variables take precedence over values saved in the app. */
export function vinauditSettings() {
  const s = { url: config.vinaudit.url, reuseDays: config.vinaudit.reuseDays, timeoutMs: config.vinaudit.timeoutMs, fromEnv: {} };
  for (const k of SETTING_KEYS) {
    const env = config.vinaudit[k];
    s[k] = env || getSetting(`provider.vinaudit.${k}`, '') || '';
    s.fromEnv[k] = !!env;
  }
  s.mode = s.mode === 'test' ? 'test' : '';
  return s;
}

function missingFields(s) {
  return [['key', 'API key'], ['user', 'username'], ['pass', 'password']].filter(([k]) => !s[k]).map(([, l]) => l);
}

async function call(endpoint, params, s) {
  const qs = new URLSearchParams({ ...params, key: s.key, user: s.user, pass: s.pass, format: 'json' });
  if (s.mode) qs.set('mode', s.mode);
  let res;
  try {
    res = await fetch(`${s.url}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(s.timeoutMs), headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'VinAudit did not respond in time.' : `Could not reach VinAudit (${err.cause?.code || err.message}).`);
  }
  if (!res.ok) throw new Error(`VinAudit returned HTTP ${res.status}.`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('VinAudit returned an unreadable response.');
  return body;
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const join = (parts, sep = ' ') => parts.filter((p) => p != null && String(p).trim() !== '').join(sep) || null;
const where = (city, state) => join([city, state], ', ');

/** Map a VinAudit /v2/pullreport JSON body to the normalised record format. */
export function mapReport(r) {
  const a = r.attributes || {};
  const accidents = [];
  for (const x of r.accidents || []) {
    accidents.push({
      date: x.date || null,
      severity: null,
      description: join([
        'Crash report',
        x.manner_of_collision && `— manner of collision: ${x.manner_of_collision}`,
        x.source_name && `(reported by ${x.source_name}${where(x.source_city, x.source_state) ? `, ${where(x.source_city, x.source_state)}` : ''})`,
      ]),
      location: null,
      reference: x.report_id || null,
    });
  }
  for (const x of r.salvage || []) {
    accidents.push({
      date: x.date || null,
      severity: 'Salvage auction',
      description: join([
        x.primary_damage && `Primary damage: ${x.primary_damage}`,
        x.secondary_damage && `Secondary damage: ${x.secondary_damage}`,
        x.sale_document && `Sale document: ${x.sale_document}`,
        x.odometer && `Odometer: ${x.odometer}`,
      ], '; ') || 'Salvage auction listing',
      location: x.location || null,
      reference: x.listing_id ? `Listing ${x.listing_id}` : null,
    });
  }

  const statusRecords = [];
  for (const x of r.thefts || []) {
    statusRecords.push({
      date: x.date_of_theft || x.date || null,
      type: 'Theft',
      description: join([`Theft record${x.theft_status ? ` (status: ${x.theft_status})` : ''}`, x.source_name && `— ${x.source_name}`]),
      jurisdiction: x.theft_reported_state || null,
      reference: x.report_id || null,
    });
    if (x.date_of_recovery) {
      statusRecords.push({
        date: x.date_of_recovery, type: 'Recovery', description: `Recovered${x.source_name ? ` — ${x.source_name}` : ''}`,
        jurisdiction: x.theft_reported_state || null, reference: x.report_id || null,
      });
    }
  }
  for (const x of r.jsi || []) {
    const insurance = /insur/i.test(x.record_type || '');
    statusRecords.push({
      date: x.date || null,
      type: insurance ? 'Insurance total loss' : (x.record_type || 'Junk / salvage'),
      description: join([
        x.brander_name && `Reported by ${x.brander_name}${where(x.brander_city, x.brander_state) ? ` (${where(x.brander_city, x.brander_state)})` : ''}`,
        x.vehicle_disposition && `disposition: ${x.vehicle_disposition}`,
        x.intended_for_export && `intended for export: ${x.intended_for_export}`,
      ], '; '),
      jurisdiction: x.brander_state || null,
      reference: x.brander_code || null,
    });
  }
  for (const x of r.checks || []) {
    const code = String(x.brand_code ?? '').padStart(2, '0');
    statusRecords.push({
      date: x.date || null,
      type: `Title brand: ${NMVTIS_BRANDS[code] || `code ${code}`}`,
      description: join([`NMVTIS brand ${code}`, x.brander_name && `applied by ${x.brander_type ? `${x.brander_type} ` : ''}${x.brander_name}`]),
      jurisdiction: x.brander_code || null,
      reference: `NMVTIS ${code}`,
    });
  }
  for (const x of r.lien || []) {
    statusRecords.push({ date: x.date || null, type: 'Lien', description: `Lien recorded${x.agency ? ` — ${x.agency}` : ''}`, jurisdiction: null, reference: null });
  }

  const titles = [...(r.titles || [])].sort((p, q) => String(p.date).localeCompare(String(q.date)));
  const unit = (u) => ({ M: 'mi', K: 'km' })[u] || u || '';
  const ownership = titles.map((t, i) => ({
    sequence: i + 1,
    startDate: t.date || null,
    endDate: titles[i + 1]?.date || null,
    purchaseDate: null,
    ownerType: truthy(t.current) ? 'Title record (current)' : 'Title record',
    region: t.state || null,
    odometer: t.meter ? `${Number(t.meter).toLocaleString('en-US')} ${unit(t.meter_unit)}`.trim() : null,
  }));
  for (const x of r.sale || []) {
    ownership.push({
      sequence: null, startDate: null, endDate: null, purchaseDate: x.date || null,
      ownerType: `Sale listing${x.seller_type ? ` (${x.seller_type})` : ''}${x.listing_price ? ` — ${x.listing_price}` : ''}`,
      region: where(x.seller_city, x.seller_state), odometer: null,
    });
  }

  return {
    status: 'match',
    specs: {
      make: a.make, model: a.model, year: a.year, trim: a.trim, engine: a.engine, bodyType: a.style,
      vehicleType: a.type, plantCountry: a.made_in, seats: a.standard_seating,
    },
    accidents,
    statusRecords,
    ownership,
  };
}

function refFor(vin) {
  return getDb().prepare("SELECT * FROM provider_refs WHERE provider = 'vinaudit' AND vin = ?").get(vin);
}
function saveRef(vin, ref) {
  getDb().prepare(`INSERT INTO provider_refs (provider, vin, ref, created_at) VALUES ('vinaudit', ?, ?, ?)
                   ON CONFLICT(provider, vin) DO UPDATE SET ref = excluded.ref, created_at = excluded.created_at, reported_at = NULL`)
    .run(vin, ref, nowIso());
}
function dropRef(vin) {
  getDb().prepare("DELETE FROM provider_refs WHERE provider = 'vinaudit' AND vin = ?").run(vin);
}

/**
 * Credential check used by "Test connection". Calls /v2/query only, which
 * decodes the VIN and returns a report id but does not generate a report.
 * Check your VinAudit agreement for how queries are billed.
 */
export async function testConnection(vin) {
  const s = vinauditSettings();
  const missing = missingFields(s);
  if (missing.length) return { ok: false, message: `Missing: ${missing.join(', ')}.` };
  try {
    const q = await call('query', { vin }, s);
    if (truthy(q.success)) {
      const at = q.attributes || {};
      return { ok: true, message: `Connected. VinAudit decoded ${vin} as ${join([at.year, at.make, at.model]) || 'a vehicle'}.`, mode: s.mode || 'production' };
    }
    if (q.error === 'no_records') return { ok: true, message: `Connected. VinAudit has no records for ${vin}.`, mode: s.mode || 'production' };
    return { ok: false, message: ERRORS[q.error] || `VinAudit error: ${q.error_message || q.error}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

export default {
  id: 'vinaudit',
  name: 'VinAudit vehicle history (NMVTIS-approved)',
  trust: 'verified',
  kind: 'history',
  recordSource: true,
  coverage: ['specs', 'accidents', 'statusRecords', 'ownership'],

  configured() {
    return missingFields(vinauditSettings()).length === 0;
  },
  missing() {
    const m = missingFields(vinauditSettings());
    return m.length ? `VinAudit ${m.join(', ')} not set (Administration › Branding and data sources, or VINAUDIT_* in .env)` : null;
  },

  async lookup(vin) {
    const s = vinauditSettings();
    if (missingFields(s).length) throw new Error('VinAudit credentials are not configured.');

    const notes = [];
    const existing = refFor(vin);
    const fresh = existing && s.reuseDays > 0 && Date.now() - Date.parse(existing.created_at) < s.reuseDays * 86400_000;
    let id = fresh ? existing.ref : null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!id) {
        const q = await call('query', { vin }, s);
        if (!truthy(q.success)) {
          if (q.error === 'no_records') return { status: 'no_match', notes: ['VinAudit: no records for this VIN.'] };
          if (q.error === 'invalid_vin') return { status: 'no_match', notes: ['VinAudit: not accepted as a valid 17-character VIN.'] };
          throw new Error(ERRORS[q.error] || `VinAudit error: ${q.error_message || q.error || 'unknown'}`);
        }
        id = String(q.id);
        saveRef(vin, id);
      } else {
        notes.push(`Reused VinAudit report ${id} requested ${existing.created_at.slice(0, 10)} (no new charge).`);
      }
      const r = await call('pullreport', { id, vin }, s);
      if (truthy(r.success)) {
        getDb().prepare("UPDATE provider_refs SET reported_at = ? WHERE provider = 'vinaudit' AND vin = ?").run(nowIso(), vin);
        const mapped = mapReport(r);
        mapped.notes = [...notes, `VinAudit report ${r.id || id}${r.date ? ` generated ${r.date}` : ''}.`];
        return mapped;
      }
      if (r.error === 'no_records') return { status: 'no_match', notes: ['VinAudit: no records for this VIN.'] };
      if (['expired_report', 'unexpected_input', 'missing_report'].includes(r.error) && attempt === 0) {
        dropRef(vin); // stale id — request a new report once
        id = null;
        notes.length = 0;
        continue;
      }
      throw new Error(ERRORS[r.error] || `VinAudit error: ${r.error_message || r.error || 'unknown'}`);
    }
    throw new Error('VinAudit report could not be generated.');
  },
};
