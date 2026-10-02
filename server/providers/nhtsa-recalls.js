// NHTSA Recalls API (US Department of Transportation). Official, free, public.
// Recalls are issued for a make / model / model year, NOT for an individual VIN,
// so results are reported as model-level information and never as evidence of
// this vehicle's history. Whether a recall remedy was completed on this VIN
// must be confirmed with the manufacturer.
//
// Runs after the decoders, because it needs make, model and year. It only uses
// values confirmed by an external provider (not offline VIN estimates).
import { config } from '../config.js';

function isoDate(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(ddmmyyyy || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ddmmyyyy || null;
}

export default {
  id: 'nhtsa-recalls',
  name: 'NHTSA Recalls API (US DOT) — model-level',
  trust: 'verified',
  kind: 'model-level',
  recordSource: false, // model-level data cannot establish a record for this VIN
  phase: 2,
  coverage: ['recalls'],

  async lookup(_vin, { specs }) {
    const make = specs.make?.provider;
    const model = specs.model?.provider;
    const year = specs.year?.provider;
    if (!make || !model || !year) {
      return {
        status: 'skipped',
        reason: 'Needs make, model and year confirmed by a decoding provider; these were not available.',
      };
    }
    const url = `${config.nhtsa.recallsUrl}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(config.nhtsa.timeoutMs), headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'NHTSA Recalls did not respond in time.' : `Could not reach NHTSA Recalls (${err.cause?.code || err.message}).`);
    }
    // The API answers 400 when it has no data for the make/model/year combination.
    if (res.status === 400 || res.status === 404) return { status: 'no_match', recalls: [], query: `${year} ${make} ${model}` };
    if (!res.ok) throw new Error(`NHTSA Recalls returned HTTP ${res.status}.`);
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.results)) throw new Error('NHTSA Recalls returned an unreadable response.');
    return {
      status: 'match',
      query: `${year} ${make} ${model}`,
      recalls: body.results.map((r) => ({
        date: isoDate(r.ReportReceivedDate),
        campaign: r.NHTSACampaignNumber,
        component: r.Component,
        summary: r.Summary,
        consequence: r.Consequence,
        remedy: r.Remedy,
        manufacturer: r.Manufacturer,
        parkIt: !!r.parkIt,
      })),
    };
  },
};
