// Create an administrator account (or reset an existing one's password).
// Usage: npm run create-admin
//        npm run create-admin -- --username admin --name "Jane Doe"   (password is prompted)
import readline from 'node:readline';
import { openDb, nowIso } from '../server/db.js';
import { hashPassword, checkPasswordPolicy, destroyUserSessions } from '../server/auth.js';
import { audit } from '../server/audit.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
      else if (s === '\r\n' || s === '\n' || s === '\r') rl.output.write(s);
      else rl.output.write('*');
    };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}

const db = openDb();
console.log('VIN Checker — create administrator\n');

const username = (arg('username') || (await ask('Username: '))).trim();
if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
  console.error('Username must be 3-64 characters: letters, digits, dot, dash or underscore.');
  process.exit(1);
}
const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (existing) console.log(`User "${username}" exists — their password will be reset and they will be made an active administrator.`);

const fullName = (arg('name') || (existing ? existing.full_name : await ask('Full name: '))).trim();
if (!fullName) { console.error('Full name is required.'); process.exit(1); }

// A password may be supplied via env for automated setups; otherwise prompt.
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await ask('Password (min 10 chars, 3 of: lower/upper/digit/symbol): ', { hidden: true });
  const confirm = await ask('Confirm password: ', { hidden: true });
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }
}
const problem = checkPasswordPolicy(password, username);
if (problem) { console.error(problem); process.exit(1); }

const now = nowIso();
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1, full_name = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(password), fullName, now, existing.id);
  destroyUserSessions(existing.id);
  audit(null, 'user.admin_reset_cli', { entityType: 'user', entityId: username, user: { id: null, username: 'cli' } });
  console.log(`\nAdministrator "${username}" updated.`);
} else {
  db.prepare(`INSERT INTO users (username, full_name, password_hash, role, active, must_change_password, created_at, updated_at)
              VALUES (?, ?, ?, 'admin', 1, 0, ?, ?)`).run(username, fullName, hashPassword(password), now, now);
  audit(null, 'user.create', { entityType: 'user', entityId: username, details: { fullName, role: 'admin', via: 'cli' }, user: { id: null, username: 'cli' } });
  console.log(`\nAdministrator "${username}" created. Start the app with "npm start" and sign in.`);
}
