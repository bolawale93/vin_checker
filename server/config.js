// Central configuration loaded from environment variables (and .env if present).
// Secrets such as provider API keys live only here, on the server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = process.env.VIN_CHECKER_ENV_FILE || path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || 'data');

export const config = {
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 3000),
  production: env.NODE_ENV === 'production',
  trustProxy: bool(env.TRUST_PROXY, false),

  dataDir,
  dbPath: path.resolve(dataDir, env.DB_FILE || 'vin-checker.db'),
  brandingDir: path.join(dataDir, 'branding'),
  backupDir: path.resolve(ROOT_DIR, env.BACKUP_DIR || path.join(dataDir, 'backups')),

  // Sessions
  cookieSecure: bool(env.COOKIE_SECURE, false),
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 60),
  sessionMaxHours: int(env.SESSION_MAX_HOURS, 12),

  // Lookup processing
  lookupConcurrency: Math.max(1, int(env.LOOKUP_CONCURRENCY, 3)),
  maxBatchSize: Math.max(1, int(env.MAX_BATCH_SIZE, 500)),
  strictCheckDigit: bool(env.STRICT_CHECK_DIGIT, false),

  // Report presentation
  reportTimezone: env.REPORT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  reportLocale: env.REPORT_LOCALE || 'en-GB',

  // Data providers, in priority order. See README "Connecting a data provider".
  providers: list(env.DATA_PROVIDERS, ['vin-structure', 'nhtsa-vpic', 'nhtsa-recalls', 'vinaudit']),
  sampleDataEnabled: bool(env.ENABLE_SAMPLE_DATA, false),

  nhtsa: {
    url: env.NHTSA_VPIC_URL || 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended',
    recallsUrl: env.NHTSA_RECALLS_URL || 'https://api.nhtsa.gov/recalls/recallsByVehicle',
    timeoutMs: int(env.NHTSA_TIMEOUT_MS, 15000),
  },

  // VinAudit (NMVTIS-approved vehicle-history provider). Credentials can be set
  // here or by an administrator in the app (env values take precedence).
  vinaudit: {
    url: env.VINAUDIT_URL || 'https://api.vinaudit.com/v2',
    key: env.VINAUDIT_KEY || '',
    user: env.VINAUDIT_USER || '',
    pass: env.VINAUDIT_PASS || '',
    mode: env.VINAUDIT_MODE || '', // 'test' for VinAudit's test VINs; empty = production
    reuseDays: int(env.VINAUDIT_REUSE_DAYS, 7),
    timeoutMs: int(env.VINAUDIT_TIMEOUT_MS, 45000),
  },
};

/**
 * Settings for an authorised HTTP provider instance.
 * "http" uses the HISTORY_API_* variables; "http:<name>" uses HTTP_<NAME>_* so
 * several authorised providers can be queried side by side.
 */
export function httpProviderSettings(id) {
  const name = id.includes(':') ? id.split(':')[1] : '';
  const p = name ? `HTTP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_` : 'HISTORY_API_';
  const get = (k) => env[`${p}${k}`];
  return {
    id,
    prefix: p,
    url: get('URL') || '',
    apiKey: get('KEY') || '',
    apiKeyHeader: get('KEY_HEADER') || 'Authorization',
    apiKeyPrefix: get('KEY_PREFIX') ?? 'Bearer ',
    name: get('NAME') || (name ? `Authorised provider "${name}"` : 'Authorised vehicle-history provider'),
    trust: get('TRUST') === 'unverified' ? 'unverified' : 'verified',
    timeoutMs: int(get('TIMEOUT_MS'), 15000),
    // Categories this provider actually covers. Anything not listed is reported
    // as "not covered by this source" rather than "no records".
    coverage: list(get('COVERAGE'), ['specs', 'accidents', 'statusRecords', 'ownership', 'maintenance']),
  };
}

// The sample provider is only active when explicitly enabled.
if (!config.sampleDataEnabled) config.providers = config.providers.filter((p) => p !== 'sample');
