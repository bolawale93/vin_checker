// Offline tests of VIN decoding, source mapping and multi-source aggregation.
// Regression VIN: 2T3WFREV2HW391791 (2017 Toyota RAV4 XLE, built in Canada).
import './support/isolated-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vinStructure, { resolveModelYear } from '../server/providers/vin-structure.js';
import { mapVpic } from '../server/providers/nhtsa-vpic.js';
import { aggregate, summaryFields } from '../server/providers/index.js';
import { computeCheckDigit } from '../shared/vin.js';

const VIN = '2T3WFREV2HW391791';
const vpicFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/vpic-2T3WFREV2HW391791.json', import.meta.url), 'utf8')).Results[0];

const provider = (id, trust, coverage, extra = {}) => ({ id, name: id, trust, coverage, recordSource: trust !== 'derived', ...extra });
const resp = (p, status, data = {}, error) => ({ p, status, data, error, retrievedAt: '2026-09-29T10:00:00.000Z' });

const structure = provider('vin-structure', 'derived', ['specs'], { recordSource: false });
const vpic = provider('nhtsa-vpic', 'verified', ['specs'], { kind: 'decoder' });
const history = provider('http:nvr', 'verified', ['accidents', 'statusRecords', 'ownership']);
const sampleP = provider('sample', 'sample', ['specs', 'accidents', 'statusRecords', 'ownership', 'maintenance']);

test('regression: model year of 2T3WFREV2HW391791 resolves to 2017 by the position 7 rule', () => {
  const y = resolveModelYear(VIN, new Date('2026-09-29'));
  assert.equal(y.value, '2017');
  assert.equal(y.basis, 'decoded');
  assert.deepEqual(y.candidates, [1987, 2017]);
  assert.match(y.note, /1987 or 2017/);
});

test('regression: offline structure analysis decodes make Toyota but not the model', async () => {
  const r = await vinStructure.lookup(VIN);
  assert.equal(r.specs.make.value, 'Toyota');
  assert.equal(r.specs.make.basis, 'decoded');
  assert.equal(r.specs.year.value, '2017');
  assert.equal(r.specs.model, undefined, 'model cannot be decoded offline and must not be invented');
  assert.equal(r.specs.country.value, 'Canada');
});

test('regression: offline-only result populates make and year in the profile summary', async () => {
  const result = aggregate([resp(structure, 'match', await vinStructure.lookup(VIN))]);
  const s = summaryFields(result);
  assert.equal(s.make, 'Toyota');
  assert.equal(s.year, '2017');
  assert.equal(s.model, null);
  assert.equal(s.meta.make.basis, 'decoded');
  assert.equal(result.specStatus, 'vin_only');
  assert.equal(result.historyStatus, 'not_checked');
  assert.equal(result.vehicleStatus, 'History not checked');
});

test('regression: vPIC mapping of the real response', () => {
  const m = mapVpic(vpicFixture);
  assert.equal(m.status, 'match');
  assert.equal(m.specs.make, 'TOYOTA');
  assert.equal(m.specs.model, 'RAV4');
  assert.equal(m.specs.year, '2017');
  assert.match(m.specs.trim, /XLE/);
  assert.match(m.specs.engine, /2\.5L/);
  assert.match(m.specs.plant, /WOODSTOCK/);
  assert.deepEqual(m.notes, []);
});

test('regression: vPIC + structure agree → confirmed make/year; model from provider; history not checked', async () => {
  const result = aggregate([
    resp(structure, 'match', await vinStructure.lookup(VIN)),
    resp(vpic, 'match', mapVpic(vpicFixture)),
  ]);
  assert.equal(result.outcome, 'found');
  assert.equal(result.specs.make.basis, 'confirmed');
  assert.equal(result.specs.make.agreeing, 2);
  assert.equal(result.specs.year.basis, 'confirmed');
  assert.equal(result.specs.model.value, 'RAV4');
  assert.equal(result.specs.model.basis, 'provider');
  assert.equal(result.specs.make.source.id, 'nhtsa-vpic', 'provider value preferred over offline decode');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.specStatus, 'provider');
  assert.equal(result.historyStatus, 'not_checked', 'VIN decoding is not a history check');
  assert.equal(result.records.accidents.state, 'unavailable');
  const s = summaryFields(result);
  assert.deepEqual([s.make, s.model, s.year], ['TOYOTA', 'RAV4', '2017']);
});

test('conflicting sources are flagged, not silently resolved', async () => {
  const result = aggregate([
    resp(structure, 'match', await vinStructure.lookup(VIN)),
    resp(vpic, 'match', mapVpic(vpicFixture)),
    resp(history, 'match', { specs: { year: '2016', model: 'Highlander' }, accidents: [], statusRecords: [], ownership: [] }),
  ]);
  assert.equal(result.specs.year.conflict, true);
  assert.equal(result.specs.model.conflict, true);
  assert.equal(result.specs.year.candidates.length, 3);
  assert.deepEqual(result.conflicts.sort(), ['model', 'year']);
  assert.equal(summaryFields(result).meta.year.conflict, true);
});

test('provider error, uncovered category and "no records" are distinguished', async () => {
  const noRecords = aggregate([
    resp(structure, 'match', await vinStructure.lookup(VIN)),
    resp(history, 'match', { accidents: [], statusRecords: [], ownership: [] }),
  ]);
  assert.equal(noRecords.historyStatus, 'no_records');
  assert.equal(noRecords.records.accidents.state, 'none');
  assert.equal(noRecords.records.maintenance.state, 'unavailable', 'not covered by the provider');
  assert.equal(noRecords.vehicleStatus, 'No adverse records returned');

  const failed = aggregate([
    resp(structure, 'match', await vinStructure.lookup(VIN)),
    resp(vpic, 'match', mapVpic(vpicFixture)),
    resp(history, 'error', {}, 'Provider rejected the credentials (HTTP 401).'),
  ]);
  assert.equal(failed.outcome, 'partial');
  assert.equal(failed.historyStatus, 'failed');
  assert.equal(failed.records.accidents.state, 'failed');

  const notFound = aggregate([resp(history, 'no_match', {})]);
  assert.equal(notFound.historyStatus, 'not_found');
  assert.equal(notFound.records.accidents.state, 'not_found');
});

test('sample data never counts as a live history check', () => {
  const result = aggregate([resp(sampleP, 'match', { specs: { make: 'Toyota' }, accidents: [{ date: '2020-01-01' }], statusRecords: [], ownership: [], maintenance: [] })]);
  assert.equal(result.historyStatus, 'not_checked');
  assert.equal(result.records.accidents.sampleOnly, true);
  assert.equal(result.specs.make.basis, 'sample');
  assert.match(result.vehicleStatus, /sample data/);
});

test('ambiguous model year is not asserted as a value', () => {
  // European-style VIN with year code "A" (1980 or 2010) and no valid check digit.
  let vin = 'VF1ABCDE0AB123456';
  const good = computeCheckDigit(vin);
  vin = `${vin.slice(0, 8)}${good === '1' ? '2' : '1'}${vin.slice(9)}`;
  const y = resolveModelYear(vin, new Date('2026-09-29'));
  assert.equal(y.basis, 'ambiguous');
  assert.equal(y.value, '1980 or 2010');
  const result = aggregate([resp(structure, 'match', { status: 'match', specs: { year: { value: y.value, basis: y.basis, candidates: y.candidates } } })]);
  assert.equal(summaryFields(result).year, null);
});

test('a code whose later reading is in the future resolves to the earlier year (estimated)', () => {
  // "Y" = 2000 or 2030; 2030 is in the future. Non-North-American VIN, check digit not valid.
  let vin = 'WVWZZZ1JZYW000001';
  if (computeCheckDigit(vin) === vin[8]) vin = `${vin.slice(0, 8)}1${vin.slice(9)}`;
  const y = resolveModelYear(vin, new Date('2026-09-29'));
  assert.equal(y.value, '2000');
  assert.equal(y.basis, 'estimated');
});
