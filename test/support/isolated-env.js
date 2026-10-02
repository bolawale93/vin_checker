// Import this FIRST in unit tests that load server modules, so they never
// read the real .env or touch the real database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinchk-unit-'));
process.env.VIN_CHECKER_ENV_FILE = path.join(dir, 'none.env');
process.env.DATA_DIR = dir;
process.env.ENABLE_SAMPLE_DATA = 'true';
process.env.DATA_PROVIDERS ??= 'vin-structure,nhtsa-vpic,nhtsa-recalls,vinaudit,sample';
for (const k of ['VINAUDIT_KEY', 'VINAUDIT_USER', 'VINAUDIT_PASS', 'VINAUDIT_MODE']) delete process.env[k];

process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the DB briefly */ }
});
