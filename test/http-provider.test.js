// Verifies the "http" provider connector (several instances) against the bundled mock provider.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 4020 + Math.floor(Math.random() * 50);
let mock;

before(async () => {
  mock = spawn(process.execPath, ['scripts/mock-provider.js'], {
    cwd: ROOT, env: { ...process.env, MOCK_PROVIDER_PORT: String(PORT), MOCK_PROVIDER_KEY: 'k1' }, stdio: 'pipe',
  });
  await new Promise((resolve) => mock.stdout.once('data', resolve));
  const url = `http://127.0.0.1:${PORT}/v1/vehicles/{vin}`;
  Object.assign(process.env, {
    VIN_CHECKER_ENV_FILE: path.join(ROOT, 'does-not-exist.env'),
    DATA_PROVIDERS: 'vin-structure,http,http:insurer',
    ENABLE_SAMPLE_DATA: 'false',
    // Provider 1: full history, correct key
    HISTORY_API_URL: url, HISTORY_API_KEY: 'k1', HISTORY_API_NAME: 'Mock registry', HISTORY_API_TRUST: 'unverified',
    // Provider 2: covers accidents only
    HTTP_INSURER_URL: url, HTTP_INSURER_KEY: 'k1', HTTP_INSURER_NAME: 'Mock insurer', HTTP_INSURER_TRUST: 'unverified',
    HTTP_INSURER_COVERAGE: 'accidents',
    // Provider 3 (not in DATA_PROVIDERS; used directly): wrong key
    HTTP_BAD_URL: url, HTTP_BAD_KEY: 'wrong',
  });
});

after(() => mock?.kill());

test('http providers: multi-source match, coverage, no match and bad credentials', async () => {
  const { lookupVin, providerStatus, aggregate } = await import('../server/providers/index.js');
  const { createHttpProvider } = await import('../server/providers/http.js');

  assert.deepEqual(providerStatus().map((p) => [p.id, p.active]), [['vin-structure', true], ['http', true], ['http:insurer', true]]);

  const found = await lookupVin('1FTFW1EF2CF000303');
  assert.equal(found.outcome, 'found');
  assert.equal(found.specs.make.value, 'Ford');
  assert.equal(found.specs.make.basis, 'confirmed', 'provider and WMI decode agree');
  assert.equal(found.records.statusRecords.items.length, 2);
  // Both providers report the same accident; each is kept with its own source.
  assert.deepEqual(found.records.accidents.items.map((a) => a._source.name).sort(), ['Mock insurer', 'Mock registry']);
  assert.equal(found.historyStatus, 'records');
  assert.match(found.vehicleStatus, /Written off/);

  const none = await lookupVin('1G1ZT53826F109149');
  assert.equal(none.outcome, 'no_record');
  assert.equal(none.historyStatus, 'not_found');
  assert.equal(none.records.accidents.state, 'not_found');
  assert.equal(none.specs.make.value, 'Chevrolet');

  const bad = createHttpProvider('http:bad');
  const started = new Date().toISOString();
  let error;
  try { await bad.lookup('1FTFW1EF2CF000303'); } catch (e) { error = e; }
  assert.match(error.message, /rejected the credentials/);
  const denied = aggregate([{ p: bad, status: 'error', error: error.message, data: {}, retrievedAt: started }]);
  assert.equal(denied.outcome, 'error');
  assert.equal(denied.historyStatus, 'failed');
});
