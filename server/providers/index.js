// Provider registry, multi-source lookup and result aggregation.
//
// A provider is an object with:
//   id, name, trust ('verified' | 'unverified' | 'sample' | 'derived'),
//   kind ('decoder' | 'history' | 'model-level'),
//   recordSource (true if a match establishes that the source holds data for this VIN),
//   coverage (categories it can supply), phase (1 default; 2 = runs after decoders),
//   configured?(), missing?() and async lookup(vin, ctx).
// lookup() returns { status: 'match' | 'no_match' | 'skipped', specs?, <category arrays>?, notes? }
// or throws an Error for a failure that should be retryable.
import { config } from '../config.js';
import vinStructure from './vin-structure.js';
import sample from './sample.js';
import nhtsaVpic from './nhtsa-vpic.js';
import nhtsaRecalls from './nhtsa-recalls.js';
import vinaudit from './vinaudit.js';
import { createHttpProvider } from './http.js';

const STATIC = {
  [vinStructure.id]: vinStructure, [sample.id]: sample, [nhtsaVpic.id]: nhtsaVpic, [nhtsaRecalls.id]: nhtsaRecalls,
  [vinaudit.id]: vinaudit,
};
const httpCache = new Map();

function getProvider(id) {
  if (STATIC[id]) return STATIC[id];
  if (id === 'http' || id.startsWith('http:')) {
    if (!httpCache.has(id)) httpCache.set(id, createHttpProvider(id));
    return httpCache.get(id);
  }
  return null;
}

/** VIN-level history categories (what happened to this vehicle). */
export const HISTORY_KEYS = ['accidents', 'statusRecords', 'ownership', 'maintenance'];

export const CATEGORIES = [
  { key: 'accidents', label: 'Accident and damage records' },
  { key: 'statusRecords', label: 'Theft, recovery, salvage and write-off records' },
  { key: 'ownership', label: 'Ownership and registration history' },
  { key: 'maintenance', label: 'Maintenance and inspection history' },
  { key: 'recalls', label: 'Safety recalls for this model', modelLevel: true },
];

export const SPEC_LABELS = {
  make: 'Make', model: 'Model', year: 'Model year', trim: 'Trim', series: 'Series', bodyType: 'Body type',
  vehicleType: 'Vehicle type', engine: 'Engine', fuelType: 'Fuel type', electrification: 'Electrification',
  transmission: 'Transmission', driveType: 'Drive type', steering: 'Steering', colour: 'Colour', doors: 'Doors',
  seats: 'Seats', gvwr: 'Gross vehicle weight rating', manufacturerName: 'Manufacturer (registered)',
  plant: 'Assembly plant', plantCountry: 'Plant country',
  manufacturer: 'Manufacturer (WMI table)', region: 'Region of manufacture', country: 'Country of manufacture',
  wmi: 'WMI', yearCode: 'Model-year code', vds: 'Vehicle descriptor (VDS)', checkDigit: 'Check digit',
  plantCode: 'Plant code', serialNumber: 'Serial number',
};

/** Specification keys shown in the main vehicle profile (in this order). */
export const PROFILE_SPECS = ['make', 'model', 'year', 'trim', 'series', 'bodyType', 'vehicleType', 'engine', 'fuelType',
  'electrification', 'transmission', 'driveType', 'steering', 'colour', 'doors', 'seats', 'gvwr', 'manufacturerName',
  'plant', 'plantCountry', 'country'];
export const ESSENTIAL_SPECS = ['make', 'model', 'year', 'bodyType', 'engine'];
/** Structural details shown only in the VIN structure section. */
export const STRUCTURE_SPECS = ['manufacturer', 'region', 'yearCode', 'checkDigit', 'wmi', 'vds', 'plantCode', 'serialNumber'];
const CONFLICT_KEYS = ['make', 'model', 'year'];

export const BASIS_LABELS = {
  provider: 'From provider',
  confirmed: 'Confirmed by multiple sources',
  decoded: 'Decoded from VIN',
  estimated: 'Estimated from VIN',
  ambiguous: 'Ambiguous — cannot be determined',
  sample: 'Sample data — not verified',
};

export function activeProviders() {
  return config.providers
    .map(getProvider)
    .filter(Boolean)
    .filter((p) => (p.configured ? p.configured() : true));
}

export function providerStatus() {
  return config.providers.map((id) => {
    const p = getProvider(id);
    if (!p) return { id, name: id, active: false, problem: 'Unknown provider id' };
    const ok = p.configured ? p.configured() : true;
    return {
      id, name: p.name, trust: p.trust, kind: p.kind, coverage: p.coverage, recordSource: p.recordSource,
      active: ok, problem: ok ? null : `Not configured: ${p.missing?.() || 'missing URL or credentials'}`,
    };
  });
}

/** Whether any live (non-sample) provider covering VIN-level history is active. */
export function liveHistoryConfigured() {
  return activeProviders().some((p) => p.trust !== 'sample' && p.coverage.some((c) => HISTORY_KEYS.includes(c)));
}

/** History providers listed in DATA_PROVIDERS that are waiting for credentials. */
export function pendingHistoryProviders() {
  return config.providers
    .map(getProvider)
    .filter((p) => p && p.trust !== 'sample' && p.coverage.some((c) => HISTORY_KEYS.includes(c)))
    .filter((p) => p.configured && !p.configured())
    .map((p) => ({ id: p.id, name: p.name, missing: p.missing?.() || 'credentials not set' }));
}

const TIMEOUT_MS = 30_000;
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Lookup timed out.')), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function run(p, vin, ctx) {
  const started = new Date().toISOString();
  try {
    const data = await withTimeout(p.lookup(vin, ctx), TIMEOUT_MS);
    const status = ['match', 'no_match', 'skipped'].includes(data?.status) ? data.status : 'no_match';
    return { p, retrievedAt: new Date().toISOString(), status, data: data || {} };
  } catch (err) {
    return { p, retrievedAt: started, status: 'error', data: {}, error: String(err?.message || err).slice(0, 300) };
  }
}

/** Query every active provider for one VIN and merge the results. */
export async function lookupVin(vin) {
  const providers = activeProviders();
  const phase1 = await Promise.all(providers.filter((p) => (p.phase || 1) === 1).map((p) => run(p, vin, {})));
  // Phase 2 (e.g. recalls) receives the best provider-confirmed specs.
  const specs = mergeSpecs(phase1);
  const ctx = { specs: Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { provider: bestProviderValue(s) }])) };
  const phase2 = await Promise.all(providers.filter((p) => p.phase === 2).map((p) => run(p, vin, ctx)));
  return aggregate([...phase1, ...phase2]);
}

const srcRef = (r) => ({ id: r.p.id, name: r.p.name, trust: r.p.trust, retrievedAt: r.retrievedAt });

function basisFor(trust, given) {
  if (trust === 'sample') return 'sample';
  if (trust === 'derived') return given || 'decoded';
  return 'provider';
}
const RANK = { provider: 4, decoded: 3, estimated: 2, sample: 1, ambiguous: 0 };
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function agrees(key, a, b) {
  if (key === 'year') {
    const ya = a.candidates?.length && a.basis === 'ambiguous' ? a.candidates.map(String) : [String(a.value)];
    const yb = b.candidates?.length && b.basis === 'ambiguous' ? b.candidates.map(String) : [String(b.value)];
    return ya.some((y) => yb.includes(y));
  }
  const x = norm(a.value);
  const y = norm(b.value);
  if (!x || !y) return true;
  return x === y || (key === 'model' && (x.includes(y) || y.includes(x)));
}

function bestProviderValue(spec) {
  const c = spec.candidates.find((x) => x.basis === 'provider' && x.source.trust !== 'sample');
  return c ? c.value : null;
}

/** Merge specification values from all sources, keeping every candidate. */
export function mergeSpecs(responses) {
  const byKey = {};
  for (const r of responses) {
    if (r.status !== 'match' || !r.data.specs) continue;
    for (const [k, raw] of Object.entries(r.data.specs)) {
      if (raw == null || raw === '') continue;
      const obj = typeof raw === 'object' ? raw : { value: raw };
      if (obj.value == null || obj.value === '') continue;
      (byKey[k] ??= []).push({
        value: String(obj.value),
        basis: basisFor(r.p.trust, obj.basis),
        note: obj.note || null,
        candidates: obj.candidates || null,
        trustRank: r.p.trust === 'verified' ? 1 : 0,
        source: srcRef(r),
      });
    }
  }
  const specs = {};
  for (const [k, list] of Object.entries(byKey)) {
    list.sort((a, b) => (RANK[b.basis] - RANK[a.basis]) || (b.trustRank - a.trustRank));
    const primary = list[0];
    const comparable = list.filter((c) => c.basis !== 'ambiguous' || k === 'year');
    let conflict = false;
    if (CONFLICT_KEYS.includes(k)) {
      conflict = comparable.some((a, i) => comparable.slice(i + 1).some((b) => !agrees(k, a, b)));
    }
    const agreeing = list.filter((c) => agrees(k, primary, c)).length;
    let basis = primary.basis;
    if (basis === 'provider' && !conflict && agreeing >= 2) basis = 'confirmed';
    specs[k] = {
      value: primary.value,
      basis,
      note: primary.note,
      source: primary.source,
      agreeing,
      conflict,
      candidates: list.map(({ trustRank: _rank, ...c }) => c),
    };
  }
  return specs;
}

function categoryState(covering, key) {
  const items = [];
  let answered = false;
  for (const r of covering) {
    if (r.status === 'match' && Array.isArray(r.data[key])) {
      answered = true;
      for (const item of r.data[key]) items.push({ ...item, _source: srcRef(r) });
    }
  }
  items.sort((a, b) => String(a.date || a.startDate || '').localeCompare(String(b.date || b.startDate || '')));
  let state;
  if (items.length) state = 'records';
  else if (answered) state = 'none';
  else if (covering.some((r) => r.status === 'error')) state = 'failed';
  else if (covering.some((r) => r.status === 'no_match')) state = 'not_found';
  else if (covering.some((r) => r.status === 'skipped')) state = 'skipped';
  else state = 'unavailable';
  return { state, items };
}

export function aggregate(responses) {
  const sources = responses.map((r) => ({
    id: r.p.id, name: r.p.name, trust: r.p.trust, kind: r.p.kind || null, recordSource: !!r.p.recordSource,
    coverage: r.p.coverage, retrievedAt: r.retrievedAt, status: r.status, error: r.error || null,
    reason: r.data?.reason || null, notes: r.data?.notes || [], query: r.data?.query || null,
  }));

  const specs = mergeSpecs(responses);

  const records = {};
  for (const { key } of CATEGORIES) {
    const covering = responses.filter((r) => r.p.coverage.includes(key));
    const all = categoryState(covering, key);
    const live = covering.filter((r) => r.p.trust !== 'sample');
    records[key] = {
      ...all,
      // State considering real (non-sample) sources only.
      liveState: categoryState(live, key).state,
      sampleOnly: covering.length > 0 && live.length === 0,
      sources: covering.map((r) => ({ ...srcRef(r), status: r.status, error: r.error || null, reason: r.data?.reason || null })),
    };
  }

  // --- Specification status --------------------------------------------------
  const decoders = responses.filter((r) => r.p.coverage.includes('specs') && r.p.trust !== 'derived');
  const liveDecoders = decoders.filter((r) => r.p.trust !== 'sample');
  let specStatus;
  if (liveDecoders.some((r) => r.status === 'match' && r.data.specs)) specStatus = 'provider';
  else if (liveDecoders.some((r) => r.status === 'error')) specStatus = 'failed';
  else if (decoders.some((r) => r.status === 'match' && r.data.specs)) specStatus = 'sample';
  else if (liveDecoders.length) specStatus = 'not_found';
  else specStatus = 'vin_only';

  // --- History status (VIN-level, live sources only) ---------------------------
  const liveHistory = responses.filter((r) => r.p.trust !== 'sample' && r.p.coverage.some((c) => HISTORY_KEYS.includes(c)));
  let historyStatus;
  if (!liveHistory.length) historyStatus = 'not_checked';
  else if (HISTORY_KEYS.some((k) => records[k].liveState === 'records')) historyStatus = 'records';
  else if (liveHistory.every((r) => r.status === 'error')) historyStatus = 'failed';
  else if (liveHistory.some((r) => r.status === 'error')) historyStatus = 'partial';
  else if (HISTORY_KEYS.some((k) => records[k].liveState === 'none')) historyStatus = 'no_records';
  else historyStatus = 'not_found';

  // --- Overall lookup outcome ----------------------------------------------------
  const external = responses.filter((r) => r.p.trust !== 'derived');
  const recordResponses = responses.filter((r) => r.p.recordSource);
  const matched = recordResponses.filter((r) => r.status === 'match');
  const errored = external.filter((r) => r.status === 'error');
  let outcome;
  let message = null;
  if (!recordResponses.length) {
    outcome = errored.length ? 'error' : 'no_record';
    message = 'No external vehicle-data provider is configured. Only the VIN structure could be analysed.';
  } else if (matched.length && errored.length) {
    outcome = 'partial';
    message = `Some sources failed: ${errored.map((r) => `${r.p.name} — ${r.error}`).join('; ')}`;
  } else if (matched.length) {
    outcome = 'found';
  } else if (errored.length) {
    outcome = 'error';
    message = errored.map((r) => `${r.p.name}: ${r.error}`).join('; ');
  } else {
    outcome = 'no_record';
    message = 'No matching record was found in the configured external sources.';
  }

  const hasSample = responses.some((r) => r.p.trust === 'sample' && r.status === 'match');
  const conflicts = Object.entries(specs).filter(([, s]) => s.conflict).map(([k]) => k);
  const result = {
    version: 2, sources, specs, records, outcome, message, hasSample, specStatus, historyStatus, conflicts,
    liveHistoryConfigured: liveHistory.length > 0,
    // Explains *why* history was not checked (e.g. provider awaiting credentials).
    pendingHistoryProviders: historyStatus === 'not_checked' ? pendingHistoryProviders() : [],
  };
  result.vehicleStatus = deriveVehicleStatus(result);
  return result;
}

/** Summarise history into a short label. Never implies "clean" without data. */
export function deriveVehicleStatus(result) {
  const st = result.records.statusRecords;
  const flags = [];
  if (st.state === 'records') {
    const items = st.items;
    const t = (x) => String(x.type || '').toLowerCase();
    const lastTheft = items.filter((x) => t(x).includes('theft') || t(x).includes('stolen')).map((x) => x.date || '').sort().pop();
    const lastRecovery = items.filter((x) => t(x).includes('recover')).map((x) => x.date || '').sort().pop();
    if (lastTheft !== undefined) {
      if (lastRecovery !== undefined && lastRecovery >= lastTheft) flags.push('Recovered after theft');
      else flags.push('Reported stolen');
    }
    if (items.some((x) => /write|total loss/.test(t(x)))) flags.push('Written off');
    if (items.some((x) => t(x).includes('salvage'))) flags.push('Salvage');
    for (const x of items) {
      const label = String(x.type || '').trim();
      if (label && !/theft|stolen|recover|write|total loss|salvage/i.test(label) && !flags.includes(label)) flags.push(label);
    }
  }
  if (result.records.accidents.state === 'records') flags.push('Accident record(s)');
  const sampleTag = HISTORY_KEYS.some((k) => result.records[k].sampleOnly && result.records[k].state === 'records') ? ' (sample data)' : '';
  if (flags.length) return flags.join('; ') + sampleTag;
  switch (result.historyStatus) {
    case 'no_records': return 'No adverse records returned';
    case 'not_found': return 'Not found in history sources';
    case 'failed': return 'History check failed';
    case 'partial': return 'History check incomplete';
    default: return 'History not checked';
  }
}

/**
 * Summary fields stored on the item row for listing, filtering and reports.
 * Ambiguous values (e.g. a model year that could be 1987 or 2017) are not used.
 */
export function summaryFields(result) {
  const s = result.specs || {};
  const meta = {};
  const pick = (k) => {
    const v = s[k];
    if (!v || v.basis === 'ambiguous') return null;
    meta[k] = { basis: v.basis, conflict: !!v.conflict, source: v.source?.name };
    return v.value;
  };
  return { make: pick('make'), model: pick('model'), year: pick('year'), meta };
}

/** Normalise results stored before multi-source aggregation (version 1). */
export function upgradeResult(result) {
  if (!result || result.version === 2) return result;
  for (const s of Object.values(result.specs || {})) {
    s.basis ??= basisFor(s.source?.trust, s.source?.trust === 'derived' ? 'decoded' : null);
    s.candidates ??= [{ value: s.value, basis: s.basis, source: s.source }];
    s.conflict ??= false;
  }
  for (const c of CATEGORIES) {
    result.records ??= {};
    result.records[c.key] ??= { state: 'unavailable', items: [], sources: [] };
  }
  result.specStatus ??= 'vin_only';
  result.historyStatus ??= 'not_checked';
  result.conflicts ??= [];
  return result;
}
