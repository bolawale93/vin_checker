import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVin, reviewVinList, splitVinText, extractVinsFromCsv, computeCheckDigit } from '../shared/vin.js';

test('valid VIN with correct check digit', () => {
  const r = validateVin('1HGCV1F36JA000202');
  assert.equal(r.valid, true);
  assert.deepEqual(r.warnings, []);
});

test('normalises case, spaces and hyphens', () => {
  const r = validateVin(' 1hgcv1f36-ja000202 ');
  assert.equal(r.vin, '1HGCV1F36JA000202');
  assert.equal(r.valid, true);
});

test('rejects wrong length and I/O/Q', () => {
  assert.equal(validateVin('1HGCV1F36JA00020').valid, false);
  const r = validateVin('1HGCV1F36JA00O202');
  assert.equal(r.valid, false);
  assert.match(r.errors.join(' '), /I, O and Q/);
});

test('check digit mismatch is a warning unless strict', () => {
  const vin = '1HGCV1F35JA000202';
  assert.equal(validateVin(vin).valid, true);
  assert.equal(validateVin(vin).warnings.length > 0, true);
  assert.equal(validateVin(vin, { strictCheckDigit: true }).valid, false);
});

test('check digit X', () => {
  assert.equal(computeCheckDigit('5NPD84LFXLH000404'), 'X');
});

test('review flags duplicates and invalid entries', () => {
  const list = reviewVinList(['1HGCV1F36JA000202', 'BAD', '1hgcv1f36ja000202']);
  assert.deepEqual(list.map((r) => r.status), ['valid', 'invalid', 'duplicate']);
  assert.equal(list[2].duplicateOf, 1);
});

test('split pasted text on newlines and commas', () => {
  assert.deepEqual(splitVinText('A, B\nC;D\r\n\nE'), ['A', 'B', 'C', 'D', 'E']);
});

test('CSV with VIN header column', () => {
  const r = extractVinsFromCsv('Plate,VIN Number,Notes\nABC123,1HGCV1F36JA000202,"x, y"\nDEF,2T1BURHE4FC000101,\n');
  assert.deepEqual(r.vins, ['1HGCV1F36JA000202', '2T1BURHE4FC000101']);
});

test('CSV without header uses first column', () => {
  const r = extractVinsFromCsv('1HGCV1F36JA000202,a\n2T1BURHE4FC000101,b');
  assert.deepEqual(r.vins, ['1HGCV1F36JA000202', '2T1BURHE4FC000101']);
});
