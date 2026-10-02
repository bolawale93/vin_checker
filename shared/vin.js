// VIN validation and parsing shared by the server and the browser.
// Implements the ISO 3779 / 49 CFR 565 structural rules. Nothing here looks up
// vehicle records — it only inspects the characters of the VIN itself.

const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Model-year codes (position 10). Each code repeats on a 30-year cycle.
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export const VIN_MAX_BATCH_HINT = 500;

/** Uppercase and strip whitespace and hyphens that are commonly pasted in. */
export function normalizeVin(input) {
  return String(input ?? '').toUpperCase().replace(/[\s\-]/g, '');
}

function charValue(c) {
  if (c >= '0' && c <= '9') return Number(c);
  return TRANSLITERATION[c];
}

export function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = charValue(vin[i]);
    if (v === undefined) return null;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/**
 * Validate a single VIN.
 * Returns { input, vin, valid, errors[], warnings[] }.
 * A check-digit mismatch is a warning (not an error) because many non-North
 * American manufacturers do not use position 9 as a check digit.
 */
export function validateVin(input, { strictCheckDigit = false } = {}) {
  const vin = normalizeVin(input);
  const errors = [];
  const warnings = [];

  if (!vin) {
    errors.push('VIN is empty.');
  } else {
    if (vin.length !== 17) {
      errors.push(`VIN must be 17 characters (found ${vin.length}).`);
    }
    const bad = [...new Set(vin.replace(/[A-HJ-NPR-Z0-9]/g, '').split(''))].filter(Boolean);
    if (bad.length) {
      const hasIOQ = bad.some((c) => 'IOQ'.includes(c));
      errors.push(
        `Contains invalid character(s): ${bad.join(' ')}` +
          (hasIOQ ? ' (the letters I, O and Q are never used in a VIN).' : '.'),
      );
    }
    if (!errors.length) {
      const expected = computeCheckDigit(vin);
      if (expected !== vin[8]) {
        const msg = `Check digit (position 9) is "${vin[8]}" but the calculated value is "${expected}".`;
        if (strictCheckDigit) errors.push(msg);
        else warnings.push(`${msg} This is expected for some non-North American vehicles; otherwise the VIN may be mistyped.`);
      }
      if (!YEAR_CODES.includes(vin[9])) {
        warnings.push(`Position 10 ("${vin[9]}") is not a standard model-year code.`);
      }
    }
  }

  return { input: String(input ?? '').trim(), vin, valid: errors.length === 0, errors, warnings };
}

/** Split pasted text into VIN candidates (newlines, commas, semicolons, tabs). */
export function splitVinText(text) {
  return String(text ?? '')
    .split(/[\r\n,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate a list of VIN entries and flag duplicates.
 * Each result gains { status: 'valid' | 'warning' | 'invalid' | 'duplicate', duplicateOf }.
 */
export function reviewVinList(entries, opts) {
  const seen = new Map();
  return entries.map((entry, index) => {
    const r = validateVin(entry, opts);
    let status = r.valid ? (r.warnings.length ? 'warning' : 'valid') : 'invalid';
    let duplicateOf = null;
    if (r.vin && r.valid) {
      if (seen.has(r.vin)) {
        status = 'duplicate';
        duplicateOf = seen.get(r.vin);
      } else {
        seen.set(r.vin, index + 1);
      }
    }
    return { ...r, index: index + 1, status, duplicateOf };
  });
}

/** Minimal RFC 4180-style CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * Extract VINs from CSV text. Uses a column whose header contains "VIN" if one
 * exists; otherwise uses the first column. Returns { vins, column, rowCount }.
 */
export function extractVinsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { vins: [], column: null, rowCount: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => h === 'vin' || h === 'vin number' || h === 'vin_number');
  if (col < 0) col = header.findIndex((h) => h.includes('vin'));
  let dataRows = rows;
  let column = 'first column (no "VIN" header found)';
  if (col >= 0) {
    dataRows = rows.slice(1);
    column = `"${rows[0][col].trim()}"`;
  } else {
    col = 0;
    // Skip a header-like first row that is clearly not a VIN.
    if (rows[0][0] && !/[0-9]/.test(rows[0][0])) dataRows = rows.slice(1);
  }
  const vins = dataRows.map((r) => (r[col] ?? '').trim()).filter(Boolean);
  return { vins, column, rowCount: dataRows.length };
}

/** Candidate model years for the position-10 code. */
export function modelYearCandidates(vin) {
  const idx = YEAR_CODES.indexOf(vin?.[9]);
  if (idx < 0) return [];
  return [1980 + idx, 2010 + idx];
}
