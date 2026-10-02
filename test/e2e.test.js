// End-to-end API test against an isolated server instance and database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinchk-'));
const PASSWORD = 'Test#Pass12345';
const env = {
  ...process.env, VIN_CHECKER_ENV_FILE: path.join(DATA, 'none.env'), DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1',
  ENABLE_SAMPLE_DATA: 'true', DATA_PROVIDERS: 'vin-structure,sample', ADMIN_PASSWORD: PASSWORD, LOOKUP_CONCURRENCY: '3',
};
let server;

async function waitForServer() {
  // Up to 30 s: startup is slower when the test files run in parallel.
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

class Client {
  cookie = '';
  async req(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vin-checker', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, type };
  }
}

async function waitDone(c, id) {
  for (let i = 0; i < 100; i++) {
    const r = await c.req('GET', `/api/searches/${id}`);
    if (r.data.search.status !== 'processing') return r.data;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error('search did not complete');
}

before(async () => {
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.js', '--username', 'admin', '--name', 'Test Admin'], { cwd: ROOT, env });
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: 'pipe' });
  server.stderr.on('data', (d) => process.stderr.write(d));
  await waitForServer();
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  // Windows may hold the SQLite file briefly after exit.
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});

test('full workflow', async () => {
  const c = new Client();
  assert.equal((await c.req('GET', '/api/config')).status, 401);
  assert.equal((await c.req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await c.req('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  assert.equal(login.status, 200);

  // CSRF header is required
  const noHeader = await fetch(`${BASE}/api/searches`, { method: 'POST', headers: { Cookie: c.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);

  const cfg = await c.req('GET', '/api/config');
  assert.equal(cfg.data.sampleMode, true);

  // Single search
  const single = await c.req('POST', '/api/searches', { type: 'single', vins: ['1HGCV1F36JA000202'], location: 'Depot A', caseReference: 'CASE-1' });
  assert.equal(single.status, 201, JSON.stringify(single.data));
  const sd = await waitDone(c, single.data.id);
  assert.equal(sd.items[0].status, 'found');
  assert.equal(sd.items[0].make, 'Honda');
  assert.equal(sd.items[0].hasSample, true);
  assert.match(sd.items[0].vehicleStatus, /Recovered after theft/);

  // Invalid single search rejected
  assert.equal((await c.req('POST', '/api/searches', { type: 'single', vins: ['ABC'], location: 'X' })).status, 400);

  // Check location is optional
  const noLoc = await c.req('POST', '/api/searches', { type: 'single', vins: ['2T3WFREV2HW391791'] });
  assert.equal(noLoc.status, 201, JSON.stringify(noLoc.data));
  const nl = await waitDone(c, noLoc.data.id);
  assert.equal(nl.search.location, null);
  // Regression: VIN-decoded make and year populate the summary even without a provider match
  const rav = nl.items[0];
  assert.equal(rav.make, 'Toyota');
  assert.equal(rav.year, '2017');
  assert.equal(rav.model, null, 'model is not decodable offline and must not be invented');
  assert.equal(rav.summaryMeta.make.basis, 'decoded');
  assert.equal(rav.historyStatus, 'not_checked');
  const ravPdf = await c.req('GET', `/api/searches/${noLoc.data.id}/items/${rav.id}/report.pdf`);
  assert.equal(ravPdf.status, 200);
  fs.mkdirSync(path.join(ROOT, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test-output', 'regression-2T3WFREV2HW391791-offline.pdf'), ravPdf.data);

  // Batch: found, no record, invalid, duplicate, transient failure
  const batch = await c.req('POST', '/api/searches', {
    type: 'batch', location: 'Port B', caseReference: 'OP-77',
    vins: ['2T1BURHE4FC000101', '1FTFW1EF2CF000303', 'WDDWF4KB3GR000505', '1G1ZT53826F109149', 'NOTAVIN', '2T1BURHE4FC000101', 'JN1AZ4EHXDM000606'],
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.data.duplicatesRemoved, 1);
  let bd = await waitDone(c, batch.data.id);
  const byVin = Object.fromEntries(bd.items.map((i) => [i.vinInput, i]));
  assert.equal(byVin['2T1BURHE4FC000101'].status, 'found');
  assert.match(byVin['1FTFW1EF2CF000303'].vehicleStatus, /Written off/);
  assert.match(byVin['WDDWF4KB3GR000505'].vehicleStatus, /Reported stolen/);
  assert.equal(byVin['1G1ZT53826F109149'].status, 'no_record');
  assert.equal(byVin['1G1ZT53826F109149'].make, 'Chevrolet', 'make decoded from the WMI');
  assert.equal(byVin['1G1ZT53826F109149'].summaryMeta.make.basis, 'decoded');
  assert.equal(byVin['1G1ZT53826F109149'].model, null, 'no invented model for unmatched VIN');
  assert.equal(byVin.NOTAVIN.status, 'invalid');
  assert.equal(byVin['JN1AZ4EHXDM000606'].status, 'error');
  assert.equal(bd.search.status, 'completed_with_errors');

  // Retry the failure
  const retry = await c.req('POST', `/api/searches/${batch.data.id}/retry`, {});
  assert.equal(retry.data.queued, 1);
  bd = await waitDone(c, batch.data.id);
  assert.equal(bd.items.find((i) => i.vinInput === 'JN1AZ4EHXDM000606').status, 'found');
  assert.equal(bd.search.status, 'completed');

  // Item detail: no-record VIN has no invented history
  const noRec = bd.items.find((i) => i.vinInput === '1G1ZT53826F109149');
  const nr = await c.req('GET', `/api/searches/${batch.data.id}/items/${noRec.id}`);
  assert.equal(nr.data.item.result.records.accidents.state, 'not_found');
  assert.equal(nr.data.item.result.records.accidents.items.length, 0);
  assert.equal(nr.data.details.data.caseReference, 'OP-77');

  // Staff details and apply common
  const toyota = bd.items.find((i) => i.vinInput === '2T1BURHE4FC000101');
  const upd = await c.req('PUT', `/api/searches/${batch.data.id}/items/${toyota.id}/details`, {
    vehicleCondition: 'Damaged', inspectionFindings: 'Scratches on left door', notes: 'Vendor present',
    // Removed fields must be ignored, not stored.
    recoveryStatus: 'Recovered', recoveryDate: '2026-09-28', recoveryLocation: 'Yard', repairs: [{ date: '2026-09-01', description: 'Tyre' }],
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  for (const k of ['recoveryStatus', 'recoveryDate', 'recoveryLocation', 'repairs']) assert.equal(k in upd.data.details.data, false, `${k} not stored`);
  assert.equal((await c.req('PUT', `/api/searches/${batch.data.id}/items/${toyota.id}/details`, { vehicleCondition: 'Shiny' })).status, 400);
  const common = await c.req('PUT', `/api/searches/${batch.data.id}/common`, { details: { vehicleCondition: 'Good', evidenceRefs: 'EV-1', recoveryStatus: 'Impounded' }, apply: 'fill' });
  assert.equal(common.status, 200);
  assert.equal('recoveryStatus' in common.data.common, false);
  const t2 = await c.req('GET', `/api/searches/${batch.data.id}/items/${toyota.id}`);
  assert.equal(t2.data.details.data.vehicleCondition, 'Damaged', 'fill mode keeps vehicle-specific value');
  assert.equal(t2.data.details.data.evidenceRefs, 'EV-1');
  assert.equal(t2.data.details.data.inspectionFindings, 'Scratches on left door');
  assert.equal(t2.data.details.data.notes, 'Vendor present');
  const stored = JSON.stringify(t2.data.details.data);
  assert.equal(/recovery|repairs/i.test(stored), false);

  // Re-check a completed vehicle
  const rc = await c.req('POST', `/api/searches/${batch.data.id}/retry`, { itemIds: [toyota.id], recheck: true });
  assert.equal(rc.data.queued, 1);
  bd = await waitDone(c, batch.data.id);

  // Reports
  const pdf = await c.req('GET', `/api/searches/${batch.data.id}/items/${toyota.id}/report.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  const bpdf = await c.req('GET', `/api/searches/${batch.data.id}/report.pdf`);
  assert.equal(bpdf.data.subarray(0, 5).toString(), '%PDF-');
  const zip = await c.req('GET', `/api/searches/${batch.data.id}/reports.zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.data.subarray(0, 2).toString(), 'PK');
  fs.writeFileSync(path.join(ROOT, 'test-output', 'vehicle.pdf'), pdf.data);
  fs.writeFileSync(path.join(ROOT, 'test-output', 'batch.pdf'), bpdf.data);
  fs.writeFileSync(path.join(ROOT, 'test-output', 'reports.zip'), zip.data);

  // History filters
  const h1 = await c.req('GET', '/api/searches?vin=WDDWF4KB');
  assert.equal(h1.data.total, 1);
  const h2 = await c.req('GET', '/api/searches?ref=CASE-1');
  assert.equal(h2.data.total, 1);
  const h3 = await c.req('GET', '/api/searches?result=stolen');
  assert.equal(h3.data.total, 1);
  const h4 = await c.req('GET', '/api/searches?location=Port');
  assert.equal(h4.data.total, 1);
  const h5 = await c.req('GET', '/api/searches?vin=2T3WFREV2HW391791');
  assert.equal(h5.data.total, 1, 'search without location appears in history');

  // Users and roles
  const nu = await c.req('POST', '/api/admin/users', { username: 'viewer1', fullName: 'Vera Viewer', role: 'viewer', password: 'Viewer#Pass123' });
  assert.equal(nu.status, 201);
  const v = new Client();
  await v.req('POST', '/api/auth/login', { username: 'viewer1', password: 'Viewer#Pass123' });
  assert.equal((await v.req('GET', '/api/config')).data.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await v.req('POST', '/api/auth/password', { currentPassword: 'Viewer#Pass123', newPassword: 'Viewer#Pass456' })).status, 200);
  assert.equal((await v.req('GET', '/api/searches')).status, 200);
  assert.equal((await v.req('POST', '/api/searches', { type: 'single', vins: ['1HGCV1F36JA000202'], location: 'X' })).status, 403);
  assert.equal((await v.req('GET', '/api/admin/users')).status, 403);

  // Last admin protection
  const me = (await c.req('GET', '/api/auth/me')).data.user;
  assert.equal((await c.req('PATCH', `/api/admin/users/${me.id}`, { role: 'staff' })).status, 400);

  // Audit log
  const audit = await c.req('GET', '/api/admin/audit?pageSize=200');
  const actions = new Set(audit.data.rows.map((r) => r.action));
  for (const a of ['auth.login', 'auth.login_failed', 'search.create', 'search.retry', 'search.recheck', 'details.update', 'details.apply_common', 'report.vehicle', 'report.batch', 'report.zip', 'user.create']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
});
