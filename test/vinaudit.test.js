// VinAudit connector tests against a local server that emulates the documented
// API (https://data.vinaudit.com/docs/api/vin/vehicle-history), replaying the
// documented example report. This verifies mapping and error handling only —
// it is NOT a live check against VinAudit, which needs a paid account.
import './support/isolated-env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { config } from '../server/config.js';
import { setSetting, openDb } from '../server/db.js';
import vinaudit, { mapReport, testConnection } from '../server/providers/vinaudit.js';
import { aggregate, pendingHistoryProviders } from '../server/providers/index.js';

const EXAMPLE = JSON.parse(fs.readFileSync(new URL('./fixtures/vinaudit-pullreport-example.json', import.meta.url), 'utf8'));
const VIN = '1VXBR12EXCP901214';
const calls = [];
let server;
let expiredOnce = false;

before(async () => {
  openDb();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = Object.fromEntries(u.searchParams);
    calls.push({ path: u.pathname, ...p });
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (p.key !== 'K' || p.user !== 'U' || p.pass !== 'P') return send({ success: false, error: 'unauthorized_request', error_message: 'Invalid API key.' });
    if (p.format !== 'json') return send({ success: false, error: 'failed_request' });
    if (p.vin === '2T3WFREV2HW391791') return send({ vin: p.vin, success: false, error: 'no_records' });
    if (p.vin === '5NPD84LFXLH000404') return send({ success: false, error: 'billing_limit_exceeded' });
    if (u.pathname === '/v2/query') return send({ vin: p.vin, id: `ID-${p.vin.slice(-4)}`, attributes: EXAMPLE.attributes, success: true, error: '' });
    if (u.pathname === '/v2/pullreport') {
      if (p.vin === 'JTDKN3DUXA0000808' && !expiredOnce) { expiredOnce = true; return send({ success: false, error: 'expired_report' }); }
      return send({ ...EXAMPLE, vin: p.vin, id: p.id });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.vinaudit.url = `http://127.0.0.1:${server.address().port}/v2`;
});
after(() => server?.close());

const resp = (data, status = 'match') => ({ p: vinaudit, status, data, retrievedAt: '2026-09-29T10:00:00.000Z' });

test('without credentials VinAudit is inactive and reported as awaiting access', () => {
  assert.equal(vinaudit.configured(), false);
  assert.match(vinaudit.missing(), /API key, username, password/);
  assert.deepEqual(pendingHistoryProviders().map((p) => p.id), ['vinaudit']);
});

test('maps the documented example report into history categories', () => {
  const m = mapReport(EXAMPLE);
  assert.equal(m.specs.make, 'Toyota');
  assert.equal(m.specs.model, 'Corolla');
  assert.equal(m.specs.year, '2005');
  // Accident/damage: police crash report + salvage-auction damage listing
  assert.equal(m.accidents.length, 2);
  assert.match(m.accidents[0].description, /REAR END/);
  assert.equal(m.accidents[0].reference, '170839');
  assert.match(m.accidents[1].description, /Primary damage: REAR END; Secondary damage: FRONT END/);
  // Status: theft + recovery, junk/salvage, title brand 11, lien
  const types = m.statusRecords.map((r) => r.type);
  assert.deepEqual(types, ['Theft', 'Recovery', 'Junk And Salvage', 'Title brand: Salvage (damage or not specified)', 'Lien']);
  // Ownership: title record with odometer, plus the sale listing
  assert.equal(m.ownership[0].region, 'WA');
  assert.equal(m.ownership[0].odometer, '59,396 mi');
  assert.match(m.ownership[1].ownerType, /Sale listing \(Dealer\) — \$8,988/);
});

test('aggregated history status and vehicle status flags', () => {
  const r = aggregate([resp(mapReport(EXAMPLE))]);
  assert.equal(r.historyStatus, 'records');
  assert.equal(r.records.accidents.state, 'records');
  assert.equal(r.records.maintenance.state, 'unavailable', 'VinAudit does not cover maintenance');
  assert.match(r.vehicleStatus, /Recovered after theft/);
  assert.match(r.vehicleStatus, /Salvage/);
  assert.match(r.vehicleStatus, /Lien/);
  assert.match(r.vehicleStatus, /Accident record/);
});

test('live-style lookup through the documented query → pullreport flow', async () => {
  setSetting('provider.vinaudit.key', 'K');
  setSetting('provider.vinaudit.user', 'U');
  setSetting('provider.vinaudit.pass', 'P');
  assert.equal(vinaudit.configured(), true);
  assert.deepEqual(pendingHistoryProviders(), []);

  calls.length = 0;
  const r = await vinaudit.lookup(VIN);
  assert.equal(r.status, 'match');
  assert.deepEqual(calls.map((c) => c.path), ['/v2/query', '/v2/pullreport']);
  assert.equal(calls[1].id, 'ID-1214');
  assert.equal(calls[1].format, 'json');
  assert.equal(calls[1].mode, undefined, 'production mode sends no mode parameter');
  assert.ok(r.notes.some((n) => /report ID-1214 generated 2018-03-02/.test(n)));

  // Repeat within the reuse window reuses the report id (no second query / charge)
  calls.length = 0;
  const again = await vinaudit.lookup(VIN);
  assert.deepEqual(calls.map((c) => c.path), ['/v2/pullreport']);
  assert.ok(again.notes.some((n) => /Reused VinAudit report/.test(n)));
});

test('error codes: no records, billing limit, expired report, bad credentials, test mode', async () => {
  assert.equal((await vinaudit.lookup('2T3WFREV2HW391791')).status, 'no_match');
  await assert.rejects(vinaudit.lookup('5NPD84LFXLH000404'), /billing limit/);

  calls.length = 0;
  const exp = await vinaudit.lookup('JTDKN3DUXA0000808');
  assert.equal(exp.status, 'match');
  assert.deepEqual(calls.map((c) => c.path), ['/v2/query', '/v2/pullreport', '/v2/query', '/v2/pullreport'], 'expired report is re-requested once');

  setSetting('provider.vinaudit.mode', 'test');
  calls.length = 0;
  await vinaudit.lookup('1HGCV1F36JA000202');
  assert.equal(calls[0].mode, 'test');
  setSetting('provider.vinaudit.mode', '');

  setSetting('provider.vinaudit.pass', 'WRONG');
  await assert.rejects(vinaudit.lookup('1FTFW1EF2CF000303'), /rejected the credentials/);
  const t = await testConnection('1FTFW1EF2CF000303');
  assert.equal(t.ok, false);
  setSetting('provider.vinaudit.pass', 'P');
  const ok = await testConnection('1FTFW1EF2CF000303');
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Connected/);
});
