// Create a consistent backup of the database (safe while the app is running)
// plus branding assets. Usage: npm run backup [-- --keep 30]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';

const keepIdx = process.argv.indexOf('--keep');
const keep = keepIdx > 0 ? Number(process.argv[keepIdx + 1]) : 30;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.join(config.backupDir, `backup-${stamp}`);
fs.mkdirSync(dir, { recursive: true });

const db = openDb();
const target = path.join(dir, path.basename(config.dbPath));
// VACUUM INTO writes a transactionally consistent, compacted copy.
db.prepare('VACUUM INTO ?').run(target);

if (fs.existsSync(config.brandingDir)) {
  fs.cpSync(config.brandingDir, path.join(dir, 'branding'), { recursive: true });
}
fs.writeFileSync(path.join(dir, 'BACKUP-INFO.txt'),
  `VIN Checker backup\r\nCreated: ${new Date().toISOString()}\r\nSource database: ${config.dbPath}\r\n` +
  `Restore: stop the app, copy ${path.basename(config.dbPath)} to the data directory (and branding/ if needed), start the app.\r\n`);

const size = fs.statSync(target).size;
console.log(`Backup written to ${dir} (${(size / 1024).toFixed(1)} KB database)`);

// Retention: keep the newest N backups.
if (keep > 0) {
  const all = fs.readdirSync(config.backupDir).filter((n) => n.startsWith('backup-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(config.backupDir, old), { recursive: true, force: true });
    console.log(`Removed old backup ${old}`);
  }
}
