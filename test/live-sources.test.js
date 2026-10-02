// Live check against the real NHTSA vPIC and Recalls APIs (public internet).
// Skipped automatically when the APIs cannot be reached. Set SKIP_LIVE_TESTS=1 to skip.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VIN_CHECKER_ENV_FILE = 'does-not-exist.env';
process.env.DATA_PROVIDERS = 'vin-structure,nhtsa-vpic,nhtsa-recalls';
process.env.ENABLE_SAMPLE_DATA = 'false';

async function reachable() {
  if (process.env.SKIP_LIVE_TESTS) return false;
  try {
    const r = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/car?format=json', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

const live = await reachable();

test('LIVE regression 2T3WFREV2HW391791 via NHTSA vPIC + Recalls', { skip: !live && 'NHTSA APIs not reachable' }, async () => {
  const { lookupVin, summaryFields } = await import('../server/providers/index.js');
  const r = await lookupVin('2T3WFREV2HW391791');
  const vpic = r.sources.find((s) => s.id === 'nhtsa-vpic');
  assert.equal(vpic.status, 'match', vpic.error || '');
  assert.equal(r.outcome, 'found');
  const s = summaryFields(r);
  assert.equal(s.make.toUpperCase(), 'TOYOTA');
  assert.equal(s.model, 'RAV4');
  assert.equal(s.year, '2017');
  assert.equal(r.specs.make.basis, 'confirmed');
  assert.equal(r.specs.year.basis, 'confirmed');
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.historyStatus, 'not_checked');
  const recalls = r.sources.find((s) => s.id === 'nhtsa-recalls');
  assert.equal(recalls.status, 'match', recalls.error || recalls.reason || '');
  assert.ok(r.records.recalls.items.length >= 1);
});

test('LIVE: other VINs from the agency sample sheet decode', { skip: !live && 'NHTSA APIs not reachable' }, async () => {
  const { lookupVin, summaryFields } = await import('../server/providers/index.js');
  const expected = {
    '4T1BK3DB5BU425236': ['TOYOTA', 'Avalon', '2011'],
    '2HNYD28837H527737': ['ACURA', 'MDX', '2007'],
  };
  for (const [vin, [make, model, year]] of Object.entries(expected)) {
    const r = await lookupVin(vin);
    const vpic = r.sources.find((x) => x.id === 'nhtsa-vpic');
    assert.equal(vpic.status, 'match', `${vin}: vPIC ${vpic.status} ${vpic.error || ''}`);
    const s = summaryFields(r);
    assert.equal(s.make.toUpperCase(), make, vin);
    assert.equal(s.model.toUpperCase(), model.toUpperCase(), vin);
    assert.equal(s.year, year, vin);
  }
});
