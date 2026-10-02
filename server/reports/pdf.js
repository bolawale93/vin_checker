// PDF generation for individual vehicle reports and batch summary reports.
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { CATEGORIES, SPEC_LABELS, PROFILE_SPECS, ESSENTIAL_SPECS, STRUCTURE_SPECS } from '../providers/index.js';
import { DETAIL_FIELDS } from '../details.js';
import {
  OUTCOME_LABELS, TRUST_LABELS, BASIS_TEXT, BASIS_SHORT, SPEC_STATUS_TEXT, HISTORY_STATUS_TEXT, stateText,
  fmtDateTime, fmtLocalDateTime, sourceShort,
} from './format.js';

const C = {
  ink: '#1a1f36', muted: '#5b6475', line: '#c9cfd8', head: '#0b3d6b', headBg: '#e6edf5',
  staff: '#5b2a86', staffBg: '#f1eaf8', warn: '#9a1c1c', warnBg: '#fdecec', zebra: '#f6f7f9',
  ok: '#1d6b3a', amber: '#8a5a00',
};
const F = { reg: 'Helvetica', bold: 'Helvetica-Bold', ital: 'Helvetica-Oblique' };
const NOT_RECORDED = 'Not recorded';

// Optional TTF fonts for non-Latin text: data/branding/fonts/Regular.ttf and Bold.ttf
function registerFonts(doc) {
  const dir = path.join(config.brandingDir, 'fonts');
  const reg = path.join(dir, 'Regular.ttf');
  const bold = path.join(dir, 'Bold.ttf');
  if (fs.existsSync(reg)) {
    doc.registerFont('Body', reg);
    doc.registerFont('BodyBold', fs.existsSync(bold) ? bold : reg);
    return { reg: 'Body', bold: 'BodyBold', ital: 'Body' };
  }
  return F;
}

function createDoc(title, subject) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 62, left: 48, right: 48 },
    bufferPages: true,
    info: { Title: title, Subject: subject, Creator: 'VIN Checker', Producer: 'VIN Checker' },
  });
  doc._f = registerFonts(doc);
  return doc;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

const L = (doc) => doc.page.margins.left;
const W = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const bottom = (doc) => doc.page.height - doc.page.margins.bottom;

function ensureSpace(doc, h) {
  if (doc.y + h > bottom(doc)) doc.addPage();
}

function gap(doc, h = 10) {
  doc.y += h;
  doc.x = L(doc);
}

function drawHeader(doc, brand, title, metaRows) {
  const f = doc._f;
  const x = L(doc);
  const top = 36;
  const logo = 60;
  let drewLogo = false;
  if (brand.logoPath) {
    try {
      doc.image(brand.logoPath, x, top, { fit: [logo, logo], align: 'center', valign: 'center' });
      drewLogo = true;
    } catch { /* fall back to placeholder */ }
  }
  if (!drewLogo) {
    doc.save().lineWidth(0.8).dash(3, { space: 3 }).strokeColor(C.line).rect(x, top, logo, logo).stroke().undash().restore();
    doc.font(f.reg).fontSize(7).fillColor(C.muted).text('AGENCY\nLOGO', x, top + 22, { width: logo, align: 'center' });
  }
  const tx = x + logo + 14;
  const tw = W(doc) - logo - 14;
  doc.font(f.bold).fontSize(13).fillColor(C.ink)
    .text(brand.agencyName || '[Agency name — configure in Admin › Settings]', tx, top + 6, { width: tw });
  if (brand.agencySubtitle) doc.font(f.reg).fontSize(9).fillColor(C.muted).text(brand.agencySubtitle, tx, doc.y + 1, { width: tw });
  if (brand.classification) {
    doc.font(f.bold).fontSize(8).fillColor(C.warn).text(brand.classification.toUpperCase(), tx, doc.y + 3, { width: tw });
  }
  doc.y = Math.max(doc.y, top + logo) + 10;
  doc.moveTo(x, doc.y).lineTo(x + W(doc), doc.y).lineWidth(1.5).strokeColor(C.head).stroke();
  doc.y += 10;
  doc.font(f.bold).fontSize(18).fillColor(C.head).text(title, x, doc.y, { width: W(doc) });
  doc.y += 4;
  // Meta in two columns
  const colW = W(doc) / 2;
  for (let i = 0; i < metaRows.length; i += 2) {
    const y = doc.y;
    let maxY = y;
    for (let j = 0; j < 2; j++) {
      const r = metaRows[i + j];
      if (!r) continue;
      const cx = x + j * colW;
      doc.font(f.bold).fontSize(8.5).fillColor(C.muted).text(`${r[0]}: `, cx, y, { continued: true, width: colW - 8 });
      doc.font(f.reg).fillColor(C.ink).text(r[1] || '—');
      maxY = Math.max(maxY, doc.y);
    }
    doc.y = maxY + 1;
  }
  gap(doc, 8);
}

function notice(doc, text, { color = C.warn, bg = C.warnBg, title = null } = {}) {
  const f = doc._f;
  const x = L(doc);
  const w = W(doc);
  doc.font(f.reg).fontSize(8.5);
  const th = title ? doc.font(f.bold).fontSize(9).heightOfString(title, { width: w - 20 }) + 2 : 0;
  const bh = doc.font(f.reg).fontSize(8.5).heightOfString(text, { width: w - 20 });
  const h = th + bh + 14;
  ensureSpace(doc, h);
  const y = doc.y;
  doc.save().rect(x, y, w, h).fill(bg).restore();
  doc.save().rect(x, y, 3, h).fill(color).restore();
  if (title) doc.font(f.bold).fontSize(9).fillColor(color).text(title, x + 12, y + 7, { width: w - 20 });
  doc.font(f.reg).fontSize(8.5).fillColor(C.ink).text(text, x + 12, y + 7 + th, { width: w - 20 });
  doc.y = y + h;
  gap(doc, 8);
}

function sectionTitle(doc, text, { tag = null, color = C.head, bg = C.headBg, sub = null } = {}) {
  const f = doc._f;
  ensureSpace(doc, 60);
  const x = L(doc);
  const w = W(doc);
  const y = doc.y;
  doc.save().rect(x, y, w, 20).fill(bg).restore();
  doc.font(f.bold).fontSize(10.5).fillColor(color).text(text, x + 8, y + 5.5, { width: w - 170, lineBreak: false });
  if (tag) {
    doc.font(f.bold).fontSize(7);
    const tw = doc.widthOfString(tag) + 10;
    doc.save().roundedRect(x + w - tw - 6, y + 4.5, tw, 11, 2).fill(color).restore();
    doc.fillColor('#ffffff').text(tag, x + w - tw - 1, y + 7.2, { lineBreak: false });
  }
  doc.y = y + 24;
  if (sub) {
    doc.font(f.ital).fontSize(8).fillColor(C.muted).text(sub, x, doc.y, { width: w });
    doc.y += 3;
  }
  doc.x = x;
}

/** Two-column label/value table. rows: [label, value, {color, italic}] */
function kvTable(doc, rows, { labelWidth = 150 } = {}) {
  const f = doc._f;
  const x = L(doc);
  const w = W(doc);
  const vw = w - labelWidth - 10;
  for (const [label, rawValue, opt = {}] of rows) {
    const value = rawValue == null || rawValue === '' ? NOT_RECORDED : String(rawValue);
    const missing = value === NOT_RECORDED || opt.missing;
    const lh = doc.font(f.bold).fontSize(8.5).heightOfString(label, { width: labelWidth - 8 });
    const vh = doc.font(missing || opt.italic ? f.ital : f.reg).fontSize(9).heightOfString(value, { width: vw });
    const h = Math.max(lh, vh) + 8;
    ensureSpace(doc, h);
    const y = doc.y;
    doc.font(f.bold).fontSize(8.5).fillColor(C.muted).text(label, x + 4, y + 4, { width: labelWidth - 8 });
    doc.font(missing || opt.italic ? f.ital : f.reg).fontSize(9).fillColor(missing ? C.muted : opt.color || C.ink)
      .text(value, x + labelWidth, y + 4, { width: vw });
    doc.moveTo(x, y + h).lineTo(x + w, y + h).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.y = y + h;
  }
  gap(doc, 8);
}

/** Grid table with repeated header on page breaks. cols: [{ header, width (relative), get, color? }] */
function gridTable(doc, cols, rows, { fontSize = 8, headBg = C.headBg, headColor = C.head } = {}) {
  const f = doc._f;
  const x = L(doc);
  const total = cols.reduce((s, c) => s + c.width, 0);
  const widths = cols.map((c) => (c.width / total) * W(doc));
  const pad = 3;

  const drawHead = () => {
    doc.font(f.bold).fontSize(fontSize);
    const h = Math.max(...cols.map((c, i) => doc.heightOfString(c.header, { width: widths[i] - pad * 2 }))) + pad * 2;
    ensureSpace(doc, h + 16);
    const y = doc.y;
    doc.save().rect(x, y, W(doc), h).fill(headBg).restore();
    let cx = x;
    cols.forEach((c, i) => {
      doc.font(f.bold).fontSize(fontSize).fillColor(headColor).text(c.header, cx + pad, y + pad, { width: widths[i] - pad * 2 });
      cx += widths[i];
    });
    doc.y = y + h;
  };

  drawHead();
  rows.forEach((row, ri) => {
    const cells = cols.map((c) => {
      const v = c.get(row);
      return v == null || v === '' ? '—' : String(v);
    });
    doc.font(f.reg).fontSize(fontSize);
    const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: widths[i] - pad * 2 }))) + pad * 2;
    if (doc.y + h > bottom(doc)) {
      doc.addPage();
      drawHead();
    }
    const y = doc.y;
    if (ri % 2) doc.save().rect(x, y, W(doc), h).fill(C.zebra).restore();
    let cx = x;
    cells.forEach((t, i) => {
      const color = cols[i].color?.(row) || C.ink;
      doc.font(cols[i].bold ? f.bold : f.reg).fontSize(fontSize).fillColor(color)
        .text(t, cx + pad, y + pad, { width: widths[i] - pad * 2 });
      cx += widths[i];
    });
    doc.moveTo(x, y + h).lineTo(x + W(doc), y + h).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.y = y + h;
  });
  gap(doc, 8);
}

function paragraph(doc, text, { size = 8.5, color = C.muted, italic = false } = {}) {
  const f = doc._f;
  doc.font(italic ? f.ital : f.reg).fontSize(size);
  ensureSpace(doc, doc.heightOfString(text, { width: W(doc) }) + 4);
  doc.fillColor(color).text(text, L(doc), doc.y, { width: W(doc) });
  gap(doc, 6);
}

function finalize(doc, { runningTitle, footerLeft, brand, sample }) {
  const f = doc._f;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const x = L(doc);
    const w = W(doc);
    if (sample) {
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font(f.bold).fontSize(40).fillColor('#c62828').fillOpacity(0.1)
        .text('SAMPLE DATA — NOT VERIFIED', doc.page.width / 2 - 330, doc.page.height / 2 - 20, { width: 660, align: 'center', lineBreak: false });
      doc.restore();
    }
    if (i > range.start) {
      doc.font(f.reg).fontSize(7.5).fillColor(C.muted).text(runningTitle, x, 30, { width: w, lineBreak: false });
      doc.moveTo(x, 42).lineTo(x + w, 42).lineWidth(0.4).strokeColor(C.line).stroke();
    }
    const fy = doc.page.height - 46;
    doc.moveTo(x, fy).lineTo(x + w, fy).lineWidth(0.4).strokeColor(C.line).stroke();
    doc.font(f.reg).fontSize(7.5).fillColor(C.muted)
      .text(footerLeft, x, fy + 6, { width: w - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, x + w - 80, fy + 6, { width: 80, align: 'right', lineBreak: false });
    const foot2 = [brand.classification, brand.footerText].filter(Boolean).join(' — ');
    if (foot2) doc.font(f.bold).fontSize(7).fillColor(C.warn).text(foot2, x, fy + 18, { width: w, align: 'center', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

const SAMPLE_NOTICE =
  'This report contains DEVELOPMENT SAMPLE DATA. The records shown are fictitious, were produced for testing the ' +
  'application, and are NOT verified vehicle information. Do not rely on this report for any official purpose.';

const DISCLAIMER =
  'Externally sourced information is reproduced as received from the source named against each entry, at the retrieval ' +
  'time shown. The absence of a record does not confirm that no such event occurred — it means only that the configured ' +
  'sources returned no record. Values marked "Decoded from VIN" or "Estimated from VIN" are interpreted from the characters ' +
  'of the VIN itself; they describe what the VIN encodes and are not evidence of the vehicle\'s history or condition. ' +
  'Staff-entered information is shown separately and is the responsibility of the recording officer.';

const specBasis = (s) => {
  if (!s) return '—';
  if (s.conflict) return 'CONFLICT between sources';
  if (s.basis === 'confirmed') return `Confirmed by ${s.agreeing} sources`;
  return BASIS_TEXT[s.basis] || s.basis;
};

/** Value cell: primary value plus notes, alternatives and conflicts. */
function specValue(s) {
  const lines = [s.value];
  if (s.basis === 'ambiguous') lines[0] = `Undetermined: ${s.value}`;
  if (s.note && ['decoded', 'estimated', 'ambiguous'].includes(s.basis) && s.source?.trust === 'derived') lines.push(s.note);
  const others = (s.candidates || []).slice(1);
  if (s.conflict) {
    lines.push(`Sources disagree: ${s.candidates.map((c) => `"${c.value}" (${sourceShort(c.source)})`).join(' vs ')}. Verify against the vehicle and its documents.`);
  } else if (others.length && s.basis === 'confirmed') {
    lines.push(`Also: ${others.map((c) => sourceShort(c.source)).join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Vehicle report
// ---------------------------------------------------------------------------

export async function vehicleReportPdf({ brand, search, item, details, generatedBy, generatedAt, reportRef }) {
  const result = item.result;
  const d = details.data || {};
  const sample = !!result?.hasSample;
  const doc = createDoc(`Vehicle check report ${item.vin}`, `VIN ${item.vin}`);
  const out = toBuffer(doc);
  const f = doc._f;

  drawHeader(doc, brand, 'Vehicle VIN Check Report', [
    ['Report reference', reportRef],
    ['Generated', fmtDateTime(generatedAt)],
    ['Search reference', search.reference],
    ['Generated by', generatedBy],
  ]);

  if (sample) notice(doc, SAMPLE_NOTICE, { title: 'SAMPLE DATA — NOT VERIFIED' });

  // VIN banner with best-supported headline
  const specs = result?.specs || {};
  const headline = ['year', 'make', 'model']
    .map((k) => (specs[k] && specs[k].basis !== 'ambiguous' ? specs[k].value : null)).filter(Boolean).join(' ');
  ensureSpace(doc, 58);
  const y0 = doc.y;
  doc.save().rect(L(doc), y0, W(doc), 52).lineWidth(1).strokeColor(C.head).stroke().restore();
  doc.font(f.bold).fontSize(8).fillColor(C.muted).text('VEHICLE IDENTIFICATION NUMBER', L(doc) + 10, y0 + 6);
  doc.font('Courier-Bold').fontSize(17).fillColor(C.ink).text(item.vin || item.vin_input, L(doc) + 10, y0 + 17, { lineBreak: false });
  doc.font(f.bold).fontSize(9.5).fillColor(headline ? C.ink : C.muted)
    .text(headline || 'Make / model / year not determined', L(doc) + 10, y0 + 37, { width: W(doc) - 210, lineBreak: false });
  doc.font(f.bold).fontSize(8).fillColor(C.muted).text('LOOKUP OUTCOME', L(doc) + W(doc) - 190, y0 + 6, { width: 180, align: 'right' });
  const outcomeColor = { found: C.ok, partial: C.amber, no_record: C.amber, error: C.warn, invalid: C.warn }[item.lookup_status] || C.ink;
  doc.font(f.bold).fontSize(11).fillColor(outcomeColor)
    .text(OUTCOME_LABELS[item.lookup_status] || item.lookup_status, L(doc) + W(doc) - 190, y0 + 19, { width: 180, align: 'right' });
  doc.y = y0 + 60;
  doc.x = L(doc);

  // Check information
  sectionTitle(doc, 'Check information', { tag: 'STAFF / SYSTEM RECORD', color: C.staff, bg: C.staffBg });
  kvTable(doc, [
    ['Case / contract reference', d.caseReference || search.case_reference],
    ['Checked by', d.checkerName || search.checker_name],
    ['Date and time of check', d.checkedAt ? fmtLocalDateTime(d.checkedAt) : fmtDateTime(search.created_at)],
    ['Check location', d.location || search.location],
    ['System user who ran the search', `${search.user_full_name} (${search.username})`],
    ['Search performed (system time)', fmtDateTime(search.created_at)],
  ]);

  if (item.lookup_status === 'invalid') {
    const v = JSON.parse(item.validation || '{}');
    notice(doc, `The VIN entered ("${item.vin_input}") is not valid: ${(v.errors || []).join(' ')} No data sources were queried.`,
      { title: 'Invalid VIN' });
  } else if (!result) {
    notice(doc, 'The lookup for this VIN has not completed. Information below may be incomplete.', { title: 'Lookup pending', color: C.amber, bg: '#fff6e0' });
  } else {
    // What was checked — specifications and history reported separately.
    sectionTitle(doc, 'What was checked', {});
    kvTable(doc, [
      ['Vehicle specifications', SPEC_STATUS_TEXT[result.specStatus] || '—',
        { color: result.specStatus === 'provider' ? C.ok : C.amber }],
      ['Accident / damage / theft history', (HISTORY_STATUS_TEXT[result.historyStatus] || '—') +
        (result.historyStatus !== 'not_checked' ? ''
          : result.pendingHistoryProviders?.length
            ? ` Reason: ${result.pendingHistoryProviders.map((p) => p.name).join(', ')} is set up but waiting for account credentials.`
            : ' Reason: no authorised vehicle-history provider is configured.'),
        { color: result.historyStatus === 'not_checked' || result.historyStatus === 'failed' ? C.warn : C.ink }],
      ...(result.conflicts?.length ? [['Conflicting values', `Sources disagree on: ${result.conflicts.map((k) => SPEC_LABELS[k] || k).join(', ')}. See below.`, { color: C.warn }]] : []),
      ...(result.message ? [['Lookup notes', result.message]] : []),
    ], { labelWidth: 170 });

    // Vehicle summary
    sectionTitle(doc, 'Vehicle details and specifications', {
      tag: 'DECODED / EXTERNAL DATA',
      sub: 'Best-supported value for each field, how it was established, and its source. See "Data sources and retrieval" for retrieval times.',
    });
    const keys = [...new Set([...ESSENTIAL_SPECS, ...PROFILE_SPECS.filter((k) => specs[k])])];
    const rows = keys.map((k) => {
      const s = specs[k];
      if (!s) return { label: SPEC_LABELS[k] || k, value: 'Not available from configured sources', basis: 'Unavailable', source: '—', missing: true };
      return { label: SPEC_LABELS[k] || k, value: specValue(s), basis: specBasis(s), source: sourceShort(s.source), s };
    });
    gridTable(doc, [
      { header: 'Field', width: 20, get: (r) => r.label, bold: true },
      { header: 'Value', width: 42, get: (r) => r.value, color: (r) => (r.missing || r.s?.basis === 'ambiguous' ? C.muted : null) },
      { header: 'Basis', width: 18, get: (r) => r.basis, color: (r) => (r.s?.conflict ? C.warn : r.s?.basis === 'sample' ? C.warn : r.missing ? C.muted : null) },
      { header: 'Source', width: 20, get: (r) => r.source, color: (r) => (r.s?.source?.trust === 'sample' ? C.warn : null) },
    ], rows);

    // VIN structure
    const structure = STRUCTURE_SPECS.filter((k) => specs[k]);
    if (structure.length) {
      sectionTitle(doc, 'VIN structure analysis', {
        tag: 'DERIVED — NOT A RECORD',
        color: C.muted,
        bg: '#eef0f3',
        sub: 'Interpreted offline from the characters of the VIN (ISO 3779 / 49 CFR 565). Describes what the VIN encodes; not evidence of vehicle history.',
      });
      kvTable(doc, structure.map((k) => [SPEC_LABELS[k] || k, specs[k].value]));
    }

    // History categories
    const recCols = {
      accidents: [
        { header: 'Date', width: 13, get: (r) => r.date },
        { header: 'Severity', width: 12, get: (r) => r.severity },
        { header: 'Description', width: 33, get: (r) => r.description },
        { header: 'Location', width: 14, get: (r) => r.location },
        { header: 'Reference', width: 14, get: (r) => r.reference },
        { header: 'Source / retrieved', width: 14, get: (r) => `${sourceShort(r._source)}\n${fmtDateTime(r._source?.retrievedAt)}` },
      ],
      statusRecords: [
        { header: 'Date', width: 13, get: (r) => r.date },
        { header: 'Type', width: 12, get: (r) => r.type, bold: true },
        { header: 'Description', width: 30, get: (r) => r.description },
        { header: 'Authority', width: 17, get: (r) => r.jurisdiction },
        { header: 'Reference', width: 14, get: (r) => r.reference },
        { header: 'Source / retrieved', width: 14, get: (r) => `${sourceShort(r._source)}\n${fmtDateTime(r._source?.retrievedAt)}` },
      ],
      ownership: [
        { header: '#', width: 5, get: (r) => r.sequence },
        { header: 'From', width: 13, get: (r) => r.startDate },
        { header: 'To', width: 13, get: (r) => r.endDate || 'Current' },
        { header: 'Purchase date', width: 13, get: (r) => r.purchaseDate },
        { header: 'Owner type', width: 13, get: (r) => r.ownerType },
        { header: 'Region', width: 15, get: (r) => r.region },
        { header: 'Odometer', width: 13, get: (r) => r.odometer },
        { header: 'Source', width: 15, get: (r) => sourceShort(r._source) },
      ],
      maintenance: [
        { header: 'Date', width: 13, get: (r) => r.date },
        { header: 'Type', width: 11, get: (r) => r.type },
        { header: 'Description', width: 32, get: (r) => [r.description, r.result && `Result: ${r.result}`].filter(Boolean).join(' — ') },
        { header: 'Odometer', width: 12, get: (r) => r.odometer },
        { header: 'Facility', width: 16, get: (r) => r.facility },
        { header: 'Source', width: 16, get: (r) => sourceShort(r._source) },
      ],
      recalls: [
        { header: 'Reported', width: 11, get: (r) => r.date },
        { header: 'Campaign', width: 11, get: (r) => r.campaign },
        { header: 'Component', width: 16, get: (r) => r.component },
        { header: 'Summary and remedy', width: 62, get: (r) => [r.summary, r.remedy && `Remedy: ${r.remedy}`].filter(Boolean).join('\n') },
      ],
    };
    for (const cat of CATEGORIES) {
      const rec = result.records?.[cat.key] || { state: 'unavailable', items: [], sources: [] };
      if (cat.modelLevel && rec.state === 'unavailable') continue;
      sectionTitle(doc, cat.label, {
        tag: cat.modelLevel ? 'MODEL-LEVEL — NOT VIN-SPECIFIC' : 'VEHICLE HISTORY',
        sub: cat.modelLevel
          ? 'Recalls are issued for a make, model and year, not for this specific VIN (US market data). Whether a remedy was completed on this vehicle must be confirmed with the manufacturer.'
          : null,
      });
      if (rec.state === 'records') {
        gridTable(doc, recCols[cat.key], rec.items, { fontSize: cat.modelLevel ? 7 : 8 });
      } else {
        paragraph(doc, stateText(rec, { modelLevel: cat.modelLevel }), {
          italic: true, color: rec.state === 'failed' || rec.state === 'unavailable' ? C.warn : C.muted,
        });
      }
    }
  }

  // Staff-entered details
  sectionTitle(doc, 'Inspection and case details', {
    tag: 'STAFF-ENTERED',
    color: C.staff,
    bg: C.staffBg,
    sub: 'Recorded by agency staff. This information did not come from an external data source.' +
      (details.updatedAt ? ` Last updated ${fmtDateTime(details.updatedAt)} by ${details.updatedByName || 'unknown'}.` : ''),
  });
  kvTable(doc, [
    [DETAIL_FIELDS.vehicleCondition.label, d.vehicleCondition],
    [DETAIL_FIELDS.inspectionFindings.label, d.inspectionFindings],
    [DETAIL_FIELDS.notes.label, d.notes],
    [DETAIL_FIELDS.evidenceRefs.label, d.evidenceRefs],
  ]);

  // Sources
  if (result) {
    sectionTitle(doc, 'Data sources and retrieval', {});
    gridTable(doc, [
      { header: 'Source', width: 28, get: (s) => s.name, bold: true },
      { header: 'Trust level', width: 20, get: (s) => TRUST_LABELS[s.trust] || s.trust, color: (s) => (s.trust === 'sample' ? C.warn : null) },
      {
        header: 'Result', width: 30,
        get: (s) => [
          ({ match: 'Data returned', no_match: 'No matching record', skipped: `Not queried: ${s.reason || ''}`, error: `Error: ${s.error}` })[s.status],
          ...(s.notes || []),
        ].join('\n'),
        color: (s) => (s.status === 'error' ? C.warn : null),
      },
      { header: 'Retrieved', width: 22, get: (s) => fmtDateTime(s.retrievedAt) },
    ], result.sources || []);
  }

  paragraph(doc, DISCLAIMER, { size: 7.5 });

  // Sign-off
  ensureSpace(doc, 70);
  gap(doc, 6);
  const sy = doc.y;
  const third = W(doc) / 3;
  ['Checking officer (name)', 'Signature', 'Date'].forEach((label, i) => {
    const sx = L(doc) + i * third;
    doc.moveTo(sx, sy + 28).lineTo(sx + third - 16, sy + 28).lineWidth(0.6).strokeColor(C.ink).stroke();
    doc.font(f.reg).fontSize(7.5).fillColor(C.muted).text(label, sx, sy + 32, { width: third - 16 });
  });
  doc.y = sy + 46;

  finalize(doc, {
    runningTitle: `Vehicle VIN Check Report — ${item.vin} — ${reportRef}`,
    footerLeft: `${reportRef} · Generated ${fmtDateTime(generatedAt)} by ${generatedBy}`,
    brand,
    sample,
  });
  doc.end();
  return out;
}

// ---------------------------------------------------------------------------
// Batch report
// ---------------------------------------------------------------------------

const HISTORY_SHORT = {
  records: 'Records found', no_records: 'None returned', not_found: 'Not in sources',
  failed: 'Check failed', partial: 'Incomplete', not_checked: 'NOT CHECKED',
};

/** Summary cell with basis marker, e.g. "2017 (dec.)" or "RAV4 (!)" for a conflict. */
function summaryCell(item, key) {
  const v = item[key];
  if (!v) return null;
  const m = item.summaryMeta?.[key];
  if (m?.conflict) return `${v} (!)`;
  return BASIS_SHORT[m?.basis] ? `${v} (${BASIS_SHORT[m.basis]})` : v;
}

export async function batchReportPdf({ brand, search, items, generatedBy, generatedAt, reportRef, common }) {
  const sample = items.some((i) => i.has_sample);
  const doc = createDoc(`Batch VIN check report ${search.reference}`, `Batch ${search.reference}`);
  const out = toBuffer(doc);

  drawHeader(doc, brand, search.type === 'batch' ? 'Batch VIN Check Report' : 'VIN Check Summary Report', [
    ['Report reference', reportRef],
    ['Generated', fmtDateTime(generatedAt)],
    ['Search reference', search.reference],
    ['Generated by', generatedBy],
  ]);
  if (sample) notice(doc, SAMPLE_NOTICE, { title: 'CONTAINS SAMPLE DATA — NOT VERIFIED' });

  const notChecked = items.filter((i) => i.history_status === 'not_checked').length;
  if (notChecked) {
    notice(doc, `Accident, damage, theft and ownership history was NOT checked for ${notChecked} of ${items.length} vehicle(s) ` +
      'because no live vehicle-history source was available (none configured, or awaiting account credentials). VIN decoding is not evidence of accident history.',
    { title: 'History not checked', color: C.amber, bg: '#fff6e0' });
  }

  sectionTitle(doc, 'Batch information', { tag: 'STAFF / SYSTEM RECORD', color: C.staff, bg: C.staffBg });
  kvTable(doc, [
    ['Case / contract reference', common?.caseReference || search.case_reference],
    ['Checked by', common?.checkerName || search.checker_name],
    ['Date and time of check', common?.checkedAt ? fmtLocalDateTime(common.checkedAt) : fmtDateTime(search.created_at)],
    ['Check location', common?.location || search.location],
    ['System user who ran the search', `${search.user_full_name} (${search.username})`],
    ['Search started', fmtDateTime(search.created_at)],
    ['Search completed', search.completed_at ? fmtDateTime(search.completed_at) : 'Still processing'],
    ['Notes', search.notes],
  ]);

  // Outcome counts
  const counts = {};
  for (const i of items) counts[i.lookup_status] = (counts[i.lookup_status] || 0) + 1;
  sectionTitle(doc, 'Outcome summary', {});
  kvTable(doc, [
    ['VINs in batch', String(items.length)],
    ...['found', 'partial', 'no_record', 'error', 'invalid', 'queued', 'processing']
      .filter((k) => counts[k])
      .map((k) => [OUTCOME_LABELS[k], String(counts[k])]),
  ], { labelWidth: 200 });

  sectionTitle(doc, 'Vehicle summary', {
    tag: 'DECODED / EXTERNAL DATA',
    sub: 'Unmarked make/model/year values come from an external provider. (dec.) = decoded from the VIN; (est.) = estimated from the VIN; ' +
      '(!) = sources disagree — see the vehicle report; "—" = not available. "History" shows whether a live history source was checked.',
  });
  const outcomeColor = (r) => ({ found: C.ok, partial: C.amber, no_record: C.amber, error: C.warn, invalid: C.warn })[r.lookup_status];
  gridTable(doc, [
    { header: '#', width: 4, get: (r) => r.position },
    { header: 'VIN', width: 22, get: (r) => r.vin || r.vin_input, bold: true },
    { header: 'Make', width: 12, get: (r) => summaryCell(r, 'make') },
    { header: 'Model', width: 12, get: (r) => summaryCell(r, 'model') },
    { header: 'Year', width: 9, get: (r) => summaryCell(r, 'year') },
    { header: 'Status', width: 16, get: (r) => r.vehicle_status },
    { header: 'History', width: 11, get: (r) => HISTORY_SHORT[r.history_status] || '—', color: (r) => (r.history_status === 'not_checked' || r.history_status === 'failed' ? C.warn : null) },
    { header: 'Lookup outcome', width: 14, get: (r) => OUTCOME_LABELS[r.lookup_status] + (r.has_sample ? ' (sample)' : ''), color: outcomeColor },
  ], items, { fontSize: 7.5 });

  const problems = items.filter((i) => ['invalid', 'error', 'partial'].includes(i.lookup_status) || i.result?.conflicts?.length);
  if (problems.length) {
    sectionTitle(doc, 'Items requiring attention', {});
    gridTable(doc, [
      { header: '#', width: 5, get: (r) => r.position },
      { header: 'VIN as entered', width: 28, get: (r) => r.vin_input },
      { header: 'Outcome', width: 17, get: (r) => OUTCOME_LABELS[r.lookup_status] },
      {
        header: 'Details', width: 50,
        get: (r) => [
          r.lookup_status === 'invalid' ? (JSON.parse(r.validation).errors || []).join(' ') : r.message,
          r.result?.conflicts?.length ? `Sources disagree on: ${r.result.conflicts.map((k) => SPEC_LABELS[k] || k).join(', ')}` : null,
        ].filter(Boolean).join('\n'),
      },
    ], problems);
  }

  // Sources used across the batch
  const srcMap = new Map();
  for (const i of items) {
    for (const s of i.result?.sources || []) {
      const e = srcMap.get(s.id) || { ...s, first: s.retrievedAt, last: s.retrievedAt };
      if (s.retrievedAt < e.first) e.first = s.retrievedAt;
      if (s.retrievedAt > e.last) e.last = s.retrievedAt;
      srcMap.set(s.id, e);
    }
  }
  if (srcMap.size) {
    sectionTitle(doc, 'Data sources used', {});
    gridTable(doc, [
      { header: 'Source', width: 34, get: (s) => s.name, bold: true },
      { header: 'Trust level', width: 26, get: (s) => TRUST_LABELS[s.trust] || s.trust, color: (s) => (s.trust === 'sample' ? C.warn : null) },
      { header: 'Retrieval period', width: 40, get: (s) => (fmtDateTime(s.first) === fmtDateTime(s.last) ? fmtDateTime(s.first) : `${fmtDateTime(s.first)} to ${fmtDateTime(s.last)}`) },
    ], [...srcMap.values()]);
  }

  paragraph(doc, 'Individual vehicle reports contain the full details, sources and staff-entered information for each VIN. ' + DISCLAIMER, { size: 7.5 });

  finalize(doc, {
    runningTitle: `Batch VIN Check Report — ${search.reference}`,
    footerLeft: `${reportRef} · Generated ${fmtDateTime(generatedAt)} by ${generatedBy}`,
    brand,
    sample,
  });
  doc.end();
  return out;
}

