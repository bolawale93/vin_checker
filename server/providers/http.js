// Connector for authorised vehicle-data providers over HTTPS.
//
// One provider:      DATA_PROVIDERS=...,http        configured with HISTORY_API_*
// Several providers: DATA_PROVIDERS=...,http:nvr,http:insurer
//                    configured with HTTP_NVR_*, HTTP_INSURER_* (same suffixes):
//   URL          https://provider.example/api/v1/vehicles/{vin}   ({vin} is substituted;
//                without it "?vin=..." is appended)
//   KEY          API key / token (server-side only, never sent to browsers)
//   KEY_HEADER   header name (default Authorization)
//   KEY_PREFIX   prefix before the key (default "Bearer ")
//   NAME         display name shown on screen and in reports
//   TRUST        verified | unverified
//   COVERAGE     categories the provider covers, e.g. "specs,accidents"
//                (specs, accidents, statusRecords, ownership, maintenance)
//   TIMEOUT_MS   request timeout
//
// The response is converted by mapResponse() into the normalised record format.
// Adapt mapResponse() to your provider's documented schema.
import { httpProviderSettings } from '../config.js';

/**
 * Convert the provider's JSON into the normalised shape:
 * {
 *   status: 'match' | 'no_match',
 *   specs: { make, model, year, trim, bodyType, engine, fuelType, transmission, driveType, colour, doors, ... },
 *   accidents:     [{ date, severity, description, location, reference }],
 *   statusRecords: [{ type, date, description, jurisdiction, reference }],   // theft, recovery, salvage, write-off ...
 *   ownership:     [{ sequence, startDate, endDate, purchaseDate, ownerType, region, odometer }],
 *   maintenance:   [{ date, type, description, odometer, facility, result }],
 * }
 * Only categories listed in the provider's COVERAGE are kept, so an uncovered
 * category is reported as "not covered" rather than "no records".
 */
export function mapResponse(body, coverage) {
  // Default mapping expects the provider to already return the normalised
  // format (as the bundled mock provider does). Replace as required.
  if (!body || body.found === false) return { status: 'no_match' };
  const v = body.vehicle || body;
  const out = { status: 'match' };
  if (coverage.includes('specs')) out.specs = v.specs || {};
  for (const k of ['accidents', 'statusRecords', 'ownership', 'maintenance']) {
    if (coverage.includes(k)) out[k] = Array.isArray(v[k]) ? v[k] : [];
  }
  return out;
}

export function createHttpProvider(id) {
  const s = httpProviderSettings(id);
  return {
    id,
    name: s.name,
    trust: s.trust,
    kind: s.coverage.some((c) => c !== 'specs') ? 'history' : 'decoder',
    recordSource: true,
    coverage: s.coverage,
    settingsPrefix: s.prefix,

    configured() {
      return !!s.url;
    },
    missing() {
      return s.url ? null : `${s.prefix}URL${s.apiKey ? '' : ` and ${s.prefix}KEY`} not set`;
    },

    async lookup(vin) {
      if (!s.url) throw new Error(`${s.prefix}URL is not configured.`);
      const url = s.url.includes('{vin}')
        ? s.url.replace('{vin}', encodeURIComponent(vin))
        : `${s.url}${s.url.includes('?') ? '&' : '?'}vin=${encodeURIComponent(vin)}`;
      const headers = { Accept: 'application/json' };
      if (s.apiKey) headers[s.apiKeyHeader] = `${s.apiKeyPrefix}${s.apiKey}`;

      let res;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(s.timeoutMs) });
      } catch (err) {
        throw new Error(err.name === 'TimeoutError' ? 'Provider did not respond in time.' : `Could not reach provider (${err.cause?.code || err.message}).`);
      }
      if (res.status === 404) return { status: 'no_match' };
      if (res.status === 401 || res.status === 403) throw new Error(`Provider rejected the credentials (HTTP ${res.status}).`);
      if (res.status === 429) throw new Error('Provider rate limit reached (HTTP 429). Retry later.');
      if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}.`);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('Provider returned an unreadable response.');
      }
      return mapResponse(body, s.coverage);
    },
  };
}
