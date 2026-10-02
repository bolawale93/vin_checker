// NHTSA vPIC VIN decoder (US Department of Transportation). Official, free,
// public API — no key required. Uses the public internet; disable it by
// removing "nhtsa-vpic" from DATA_PROVIDERS if agency policy does not allow that.
// vPIC decodes specifications from manufacturer submissions. It provides NO
// accident, ownership or other history.
import { config } from '../config.js';

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s !== 'Not Applicable' && s !== '0' && s !== 'null' ? s : null;
};
const join = (parts, sep = ' ') => parts.filter(Boolean).join(sep) || null;

export function mapVpic(r) {
  const errorCodes = String(r.ErrorCode ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const notes = [];
  if (errorCodes.some((c) => c !== '0')) notes.push(`vPIC: ${clean(r.ErrorText) || 'decode warning'}`);
  if (clean(r.AdditionalErrorText)) notes.push(`vPIC: ${clean(r.AdditionalErrorText)}`);
  if (!clean(r.Make)) return { status: 'no_match', notes };

  const litres = clean(r.DisplacementL) ? `${Number(r.DisplacementL).toFixed(1)}L` : null;
  const cyl = clean(r.EngineCylinders) ? `${r.EngineCylinders}-cyl` : null;
  const hp = clean(r.EngineHP) ? `${Math.round(Number(r.EngineHP))} hp` : null;
  return {
    status: 'match',
    notes,
    specs: {
      make: clean(r.Make),
      model: clean(r.Model),
      year: clean(r.ModelYear),
      trim: join([clean(r.Trim), clean(r.Trim2)], ' / '),
      series: join([clean(r.Series), clean(r.Series2)], ' / '),
      bodyType: clean(r.BodyClass),
      vehicleType: clean(r.VehicleType),
      doors: clean(r.Doors),
      seats: clean(r.Seats),
      engine: join([litres, clean(r.EngineConfiguration), cyl, hp, clean(r.EngineModel) && `(${clean(r.EngineModel)})`]),
      fuelType: join([clean(r.FuelTypePrimary), clean(r.FuelTypeSecondary)], ' / '),
      electrification: clean(r.ElectrificationLevel),
      transmission: join([clean(r.TransmissionStyle), clean(r.TransmissionSpeeds) && `${r.TransmissionSpeeds}-speed`], ', '),
      driveType: clean(r.DriveType),
      steering: clean(r.SteeringLocation),
      gvwr: clean(r.GVWR),
      manufacturerName: clean(r.Manufacturer),
      plant: join([clean(r.PlantCity), clean(r.PlantState), clean(r.PlantCountry)], ', '),
    },
  };
}

export default {
  id: 'nhtsa-vpic',
  name: 'NHTSA vPIC VIN decoder (US DOT)',
  trust: 'verified',
  kind: 'decoder',
  recordSource: true,
  coverage: ['specs'],

  async lookup(vin) {
    const url = `${config.nhtsa.url}/${encodeURIComponent(vin)}?format=json`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(config.nhtsa.timeoutMs), headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'NHTSA vPIC did not respond in time.' : `Could not reach NHTSA vPIC (${err.cause?.code || err.message}).`);
    }
    if (!res.ok) throw new Error(`NHTSA vPIC returned HTTP ${res.status}.`);
    const r = (await res.json().catch(() => null))?.Results?.[0];
    if (!r) throw new Error('NHTSA vPIC returned an unreadable response.');
    return mapVpic(r);
  },
};
