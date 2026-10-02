// Administration: users, audit log and branding settings.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { getDb, nowIso, setSetting } from '../db.js';
import { requireRole, hashPassword, checkPasswordPolicy, destroyUserSessions, ROLES } from '../auth.js';
import { audit } from '../audit.js';
import { BRAND_KEYS, getBrand } from '../branding.js';
import { vinauditSettings, testConnection } from '../providers/vinaudit.js';

const router = express.Router();
const adminOnly = requireRole('admin');

const publicUser = (u) => ({
  id: u.id, username: u.username, fullName: u.full_name, role: u.role, active: !!u.active,
  mustChangePassword: !!u.must_change_password, createdAt: u.created_at, updatedAt: u.updated_at, lastLoginAt: u.last_login_at,
});

// Minimal staff directory (for history filters) — any signed-in user.
router.get('/users/directory', (_req, res) => {
  res.json({ users: getDb().prepare('SELECT id, username, full_name FROM users ORDER BY full_name').all()
    .map((u) => ({ id: u.id, username: u.username, fullName: u.full_name })) });
});

router.get('/users', adminOnly, (_req, res) => {
  res.json({ users: getDb().prepare('SELECT * FROM users ORDER BY active DESC, full_name').all().map(publicUser) });
});

function activeAdminCount(excludeId) {
  return getDb().prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(excludeId ?? -1).n;
}

router.post('/users', adminOnly, (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const fullName = String(req.body?.fullName ?? '').trim().slice(0, 120);
  const role = req.body?.role;
  const password = String(req.body?.password ?? '');
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-64 characters: letters, digits, dot, dash or underscore.' });
  if (!fullName) return res.status(400).json({ error: 'Enter the full name.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a valid role.' });
  const problem = checkPasswordPolicy(password, username);
  if (problem) return res.status(400).json({ error: problem });
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is already in use.' });
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO users (username, full_name, password_hash, role, active, must_change_password, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, 1, ?, ?)`)
    .run(username, fullName, hashPassword(password), role, now, now);
  audit(req, 'user.create', { entityType: 'user', entityId: username, details: { fullName, role } });
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) });
});

router.patch('/users/:id', adminOnly, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const changes = {};
  if (req.body?.fullName !== undefined) {
    const v = String(req.body.fullName).trim().slice(0, 120);
    if (!v) return res.status(400).json({ error: 'Full name cannot be empty.' });
    if (v !== user.full_name) changes.full_name = v;
  }
  if (req.body?.role !== undefined) {
    if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Choose a valid role.' });
    if (req.body.role !== user.role) changes.role = req.body.role;
  }
  if (req.body?.active !== undefined) {
    const v = req.body.active ? 1 : 0;
    if (v !== user.active) changes.active = v;
  }
  const losesAdmin = user.role === 'admin' && user.active && (changes.role !== undefined || changes.active === 0);
  if (losesAdmin && activeAdminCount(user.id) === 0) {
    return res.status(400).json({ error: 'At least one active administrator must remain.' });
  }
  if (!Object.keys(changes).length) return res.json({ user: publicUser(user) });
  const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(changes), nowIso(), user.id);
  if (changes.active === 0 || changes.role) destroyUserSessions(user.id);
  audit(req, 'user.update', {
    entityType: 'user', entityId: user.username,
    details: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { from: user[k], to: v }])),
  });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

router.post('/users/:id/password', adminOnly, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const password = String(req.body?.password ?? '');
  const problem = checkPasswordPolicy(password, user.username);
  if (problem) return res.status(400).json({ error: problem });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), nowIso(), user.id);
  destroyUserSessions(user.id);
  audit(req, 'user.password_reset', { entityType: 'user', entityId: user.username });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
router.get('/audit', adminOnly, (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  if (q.action) { where.push('action LIKE ?'); params.push(`${q.action}%`); }
  if (q.user) { where.push('username LIKE ?'); params.push(`%${q.user}%`); }
  if (q.q) { where.push('(entity_id LIKE ? OR details LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
  if (isDate(q.from)) { where.push('at >= ?'); params.push(new Date(`${q.from}T00:00:00`).toISOString()); }
  if (isDate(q.to)) { where.push('at < ?'); params.push(new Date(new Date(`${q.to}T00:00:00`).getTime() + 86400_000).toISOString()); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${whereSql}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
  res.json({
    total, page, pageSize, actions,
    rows: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
  });
});

// ---------------------------------------------------------------------------
// Branding settings
// ---------------------------------------------------------------------------
router.get('/settings', adminOnly, (_req, res) => {
  const { logoPath, ...brand } = getBrand();
  res.json({ brand, hasLogo: !!logoPath });
});

router.put('/settings', adminOnly, (req, res) => {
  const before = getBrand();
  const changed = [];
  for (const k of BRAND_KEYS) {
    if (req.body?.[k] === undefined) continue;
    const v = String(req.body[k]).trim().slice(0, 300);
    if (v !== before[k]) { setSetting(`brand.${k}`, v); changed.push(k); }
  }
  if (changed.length) audit(req, 'settings.update', { entityType: 'settings', entityId: 'branding', details: { fields: changed } });
  const { logoPath, ...brand } = getBrand();
  res.json({ brand, hasLogo: !!logoPath });
});

// The larger JSON body limit for this route is set in server/index.js.
router.post('/settings/logo', adminOnly, (req, res) => {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ''));
  if (!m) return res.status(400).json({ error: 'Upload a PNG or JPEG image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo must be 2 MB or smaller.' });
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isPng && !isJpg) return res.status(400).json({ error: 'The file is not a valid PNG or JPEG image.' });
  fs.mkdirSync(config.brandingDir, { recursive: true });
  for (const ext of ['png', 'jpg']) fs.rmSync(path.join(config.brandingDir, `logo.${ext}`), { force: true });
  fs.writeFileSync(path.join(config.brandingDir, isPng ? 'logo.png' : 'logo.jpg'), buf);
  audit(req, 'settings.logo_upload', { entityType: 'settings', entityId: 'logo', details: { bytes: buf.length } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Data-provider credentials (VinAudit). Secrets are write-only: the API only
// ever reports whether each value is set, never the value itself.
// ---------------------------------------------------------------------------
function vinauditView() {
  const s = vinauditSettings();
  return {
    enabledInConfig: config.providers.includes('vinaudit'),
    mode: s.mode || 'production',
    fields: Object.fromEntries(['key', 'user', 'pass'].map((k) => [k, { set: !!s[k], fromEnv: s.fromEnv[k] }])),
    // The username is not secret; showing it helps admins confirm the account.
    user: s.user || '',
    configured: !!(s.key && s.user && s.pass),
  };
}

router.get('/providers/vinaudit', adminOnly, (_req, res) => res.json(vinauditView()));

router.put('/providers/vinaudit', adminOnly, (req, res) => {
  const b = req.body || {};
  const changed = [];
  for (const k of ['key', 'user', 'pass']) {
    if (b.clear?.includes?.(k)) { setSetting(`provider.vinaudit.${k}`, ''); changed.push(`${k} cleared`); continue; }
    const v = String(b[k] ?? '').trim();
    if (!v) continue; // blank = keep current value
    if (v.length > 200 || /\s/.test(v)) return res.status(400).json({ error: `Invalid ${k === 'pass' ? 'password' : k === 'user' ? 'username' : 'API key'}.` });
    setSetting(`provider.vinaudit.${k}`, v);
    changed.push(k);
  }
  if (b.mode !== undefined) {
    const mode = b.mode === 'test' ? 'test' : '';
    setSetting('provider.vinaudit.mode', mode);
    changed.push('mode');
  }
  if (changed.length) audit(req, 'settings.provider_update', { entityType: 'provider', entityId: 'vinaudit', details: { fields: changed } });
  res.json(vinauditView());
});

router.post('/providers/vinaudit/test', adminOnly, async (req, res) => {
  const { validateVin } = await import('../../shared/vin.js');
  const v = validateVin(req.body?.vin || '2T3WFREV2HW391791');
  if (!v.valid) return res.status(400).json({ error: `Invalid VIN: ${v.errors.join(' ')}` });
  const result = await testConnection(v.vin);
  audit(req, 'settings.provider_test', { entityType: 'provider', entityId: 'vinaudit', details: { vin: v.vin, ok: result.ok } });
  res.json(result);
});

router.delete('/settings/logo', adminOnly, (req, res) => {
  for (const ext of ['png', 'jpg']) fs.rmSync(path.join(config.brandingDir, `logo.${ext}`), { force: true });
  audit(req, 'settings.logo_remove', { entityType: 'settings', entityId: 'logo' });
  res.json({ ok: true });
});

export default router;
