import express from 'express';
import { getDb, nowIso } from '../db.js';
import {
  verifyPassword, hashPassword, createSession, destroySession, destroyUserSessions, setSessionCookie,
  clearSessionCookie, requireAuth, checkPasswordPolicy, loginBlocked, recordLoginFailure, clearLoginFailures,
} from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();

// Pre-computed hash so failed lookups take similar time to real checks.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

router.post('/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim().slice(0, 64);
  const password = String(req.body?.password ?? '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });

  const keys = [`u:${username.toLowerCase()}`, `ip:${req.ip}`];
  if (keys.some(loginBlocked)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes or contact an administrator.' });
  }
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && user && user.active;
  if (!ok) {
    keys.forEach(recordLoginFailure);
    audit(req, 'auth.login_failed', { entityType: 'user', entityId: username, details: { reason: user && !user.active ? 'inactive' : 'bad credentials' } });
    return res.status(401).json({ error: 'Incorrect username or password, or the account is disabled.' });
  }
  keys.forEach(clearLoginFailures);
  const token = createSession(user.id, req);
  setSessionCookie(res, token);
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  const u = { id: user.id, username: user.username, fullName: user.full_name, role: user.role, mustChangePassword: !!user.must_change_password };
  audit(req, 'auth.login', { user: u, entityType: 'user', entityId: user.username });
  res.json({ user: u });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'auth.logout', { entityType: 'user', entityId: req.user.username });
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(currentPassword ?? ''), user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const problem = checkPasswordPolicy(newPassword, user.username);
  if (problem) return res.status(400).json({ error: problem });
  if (verifyPassword(newPassword, user.password_hash)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
  getDb().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), nowIso(), user.id);
  destroyUserSessions(user.id, req.sessionToken);
  audit(req, 'auth.password_change', { entityType: 'user', entityId: user.username });
  res.json({ ok: true });
});

export default router;
