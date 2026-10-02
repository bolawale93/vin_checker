// Offline provider: derives what can be read directly from the VIN's structure.
// This is NOT a vehicle record — it only interprets the characters of the VIN.
// Each value carries a basis:
//   decoded   — determined by the VIN standard / WMI assignment
//   estimated — the most likely reading, but the rule is not guaranteed to apply
//   ambiguous — more than one reading is possible; no value is asserted
import { computeCheckDigit, modelYearCandidates } from '../../shared/vin.js';
import { WMI, regionFor, countryFor } from './wmi.js';

/**
 * Resolve the model year from position 10.
 * The code repeats every 30 years (e.g. "H" = 1987 or 2017). For vehicles built
 * for the North American market, 49 CFR 565.15 makes position 7 numeric for
 * 1980-2009 and alphabetic for 2010-2039. A candidate more than one year in the
 * future is impossible and is discarded.
 */
export function resolveModelYear(vin, now = new Date()) {
  const candidates = modelYearCandidates(vin);
  const code = vin[9];
  if (!candidates.length) {
    return { value: null, basis: 'unavailable', candidates, note: `Position 10 ("${code}") is not a standard model-year code.` };
  }
  const maxYear = now.getFullYear() + 1;
  const possible = candidates.filter((y) => y <= maxYear);
  const listed = candidates.join(' or ');
  const checkOk = computeCheckDigit(vin) === vin[8];
  const naWmi = /[1-5]/.test(vin[0]);

  if (checkOk) {
    const byPos7 = /[A-Z]/.test(vin[6]) ? candidates[1] : candidates[0];
    const rule = `position 7 ("${vin[6]}") is ${/[A-Z]/.test(vin[6]) ? 'a letter, which means 2010-2039' : 'a digit, which means 1980-2009'} (49 CFR 565.15)`;
    if (byPos7 > maxYear) {
      return { value: `${listed}`, basis: 'ambiguous', candidates, note: `Code "${code}" = ${listed}; position 7 rule points to a future year, so the year cannot be determined.` };
    }
    if (naWmi) {
      return { value: String(byPos7), basis: 'decoded', candidates, note: `Code "${code}" = ${listed}; resolved because ${rule}.` };
    }
    return {
      value: String(byPos7), basis: 'estimated', candidates,
      note: `Code "${code}" = ${listed}; ${rule}. This rule is mandatory only for vehicles built for North America, so the year is an estimate.`,
    };
  }
  if (possible.length === 1) {
    return {
      value: String(possible[0]), basis: 'estimated', candidates,
      note: `Code "${code}" = ${listed}; ${candidates.find((y) => y > maxYear)} is in the future. Outside North America position 10 is not always a model-year code.`,
    };
  }
  return { value: listed, basis: 'ambiguous', candidates, note: `Code "${code}" can mean ${listed}; the VIN does not show which.` };
}

export default {
  id: 'vin-structure',
  name: 'VIN structure analysis (offline, ISO 3779)',
  trust: 'derived',
  kind: 'decoder',
  recordSource: false, // interprets the VIN only; cannot establish that a vehicle record exists
  coverage: ['specs'],

  async lookup(vin) {
    const wmi = vin.slice(0, 3);
    const entry = WMI[wmi] || null;
    const expected = computeCheckDigit(vin);
    const checkOk = expected === vin[8];
    const year = resolveModelYear(vin);
    const d = (value, note) => (value ? { value, basis: 'decoded', note } : null);

    return {
      status: 'match',
      specs: {
        make: entry?.[0] ? { value: entry[0], basis: 'decoded', note: `From manufacturer code (WMI) ${wmi} — local reference table.` } : null,
        year: year.value ? { value: year.value, basis: year.basis, note: year.note, candidates: year.candidates } : null,
        manufacturer: d(entry ? entry[1] : `Not in local reference table (WMI ${wmi})`, `WMI ${wmi}`),
        country: d(countryFor(vin), 'From VIN positions 1-2 (ISO 3780).'),
        region: d(regionFor(vin[0]), 'From VIN position 1 (ISO 3780).'),
        yearCode: d(year.note),
        checkDigit: d(checkOk ? 'Valid' : `Does not match calculated value (${expected})`),
        wmi: d(wmi),
        vds: d(vin.slice(3, 8), 'Vehicle descriptor — model/body/engine codes are manufacturer-specific and not decoded offline.'),
        plantCode: d(vin[10]),
        serialNumber: d(vin.slice(11)),
      },
    };
  },
};
