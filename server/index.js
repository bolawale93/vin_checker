import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT_DIR } from './config.js';
import { openDb, getDb } from './db.js';
import { sessionMiddleware, requireAuth, csrfGuard, purgeExpiredSessions } from './auth.js';
import { providerStatus, liveHistoryConfigured } from './providers/index.js';
import { CONDITION_OPTIONS } from './details.js';
import { getBrand, logoPath } from './branding.js';
import { resumePending } from './lookup-queue.js';
import authRoutes from './routes/auth.js';
import searchRoutes from './routes/searches.js';
import adminRoutes from './routes/admin.js';

openDb();

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'frame-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': config.cookieSecure ? [] : null,
    },
  },
  strictTransportSecurity: config.cookieSecure,
  crossOriginEmbedderPolicy: false,
}));

app.use('/api/admin/settings/logo', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use('/api', csrfGuard);
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Public endpoints
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/public', (_req, res) => {
  const brand = getBrand();
  const needsSetup = getDb().prepare('SELECT COUNT(*) n FROM users').get().n === 0;
  res.json({ agencyName: brand.agencyName, classification: brand.classification, hasLogo: !!brand.logoPath, needsSetup });
});
app.get('/api/branding/logo', (_req, res) => {
  const p = logoPath();
  if (!p) return res.status(404).end();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(p);
});

app.use('/api/auth', authRoutes);

// Everything below requires a signed-in user who has set their own password.
app.use('/api', requireAuth, (req, res, next) => {
  if (req.user.mustChangePassword) return res.status(403).json({ error: 'You must change your password before continuing.', code: 'MUST_CHANGE_PASSWORD' });
  next();
});

app.get('/api/config', (req, res) => {
  // Provider status is computed per request so credentials saved in the app take effect immediately.
  res.json({
    user: req.user,
    agencyName: getBrand().agencyName,
    providers: providerStatus(),
    sampleMode: config.providers.includes('sample'),
    maxBatchSize: config.maxBatchSize,
    strictCheckDigit: config.strictCheckDigit,
    liveHistoryConfigured: liveHistoryConfigured(),
    conditionOptions: CONDITION_OPTIONS,
    timezone: config.reportTimezone,
  });
});
app.use('/api/searches', searchRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Static front end (no build step). The shared VIN module is served to the browser too.
app.use('/shared', express.static(path.join(ROOT_DIR, 'shared'), { index: false }));
app.use(express.static(path.join(ROOT_DIR, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(ROOT_DIR, 'public', 'index.html')));

// Error handler — never leak stack traces to the client.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'An unexpected error occurred. The error has been logged.' });
});

fs.mkdirSync(config.brandingDir, { recursive: true });
resumePending();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 15 * 60_000).unref();

app.listen(config.port, config.host, () => {
  const users = getDb().prepare('SELECT COUNT(*) n FROM users').get().n;
  console.log(`VIN Checker running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  console.log(`Data providers: ${providerStatus().map((p) => `${p.id}${p.active ? '' : ' (inactive)'}`).join(', ') || 'none'}`);
  if (config.providers.includes('sample')) console.warn('WARNING: development SAMPLE DATA provider is enabled. Disable ENABLE_SAMPLE_DATA for live use.');
  if (!liveHistoryConfigured()) console.warn('NOTE: no live vehicle-history provider (accidents, theft, ownership) is configured. See README "Connecting a data provider".');
  if (!users) console.warn('No user accounts exist yet. Create the first administrator with:  npm run create-admin');
});
