// Password hashing (scrypt), server-side sessions and access-control middleware.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb, nowIso } from './db.js';

export const SESSION_COOKIE = 'vc_sid';
export const ROLES = ['admin', 'staff', 'viewer'];
export const MIN_PASSWORD_LENGTH = 10;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Returns an error message, or null if the password is acceptable. */
export function checkPasswordPolicy(password, username = '') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password is too long.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain the username.';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'Password must include at least three of: lowercase, uppercase, digits, symbols.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionMaxHours * 3600_000);
  getDb()
    .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, now.toISOString(), now.toISOString(), expires.toISOString(),
      req.ip || null, String(req.get('user-agent') || '').slice(0, 200));
  return token;
}

export function destroySession(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(userId, exceptToken = null) {
  if (exceptToken) {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha256(exceptToken));
  } else {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionMaxHours * 3600_000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Attaches req.user and req.sessionToken when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();
  const db = getDb();
  const row = db
    .prepare(`SELECT s.token_hash, s.last_seen_at, s.expires_at, u.id, u.username, u.full_name, u.role, u.active,
                     u.must_change_password
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .get(sha256(token));
  if (!row) return next();
  const now = Date.now();
  const idleLimit = Date.parse(row.last_seen_at) + config.sessionIdleMinutes * 60_000;
  if (!row.active || now > Date.parse(row.expires_at) || now > idleLimit) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return next();
  }
  // Only write last_seen occasionally to keep reads cheap.
  if (now - Date.parse(row.last_seen_at) > 30_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash);
  }
  req.user = {
    id: row.id, username: row.username, fullName: row.full_name, role: row.role,
    mustChangePassword: !!row.must_change_password,
  };
  req.sessionToken = token;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

/**
 * CSRF defence: state-changing requests must carry a custom header, which a
 * cross-site form or image cannot send. Combined with SameSite=Strict cookies.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'vin-checker') {
    return res.status(403).json({ error: 'Request rejected (missing request header).' });
  }
  next();
}

// Simple in-memory login throttling per username and per IP.
const failures = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export function loginBlocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
export function recordLoginFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
export function clearLoginFailures(key) {
  failures.delete(key);
}

export function purgeExpiredSessions() {
  const idleCutoff = new Date(Date.now() - config.sessionIdleMinutes * 60_000).toISOString();
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(nowIso(), idleCutoff);
}
