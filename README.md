# VIN Checker

A local-first platform for authorised agency staff to check vehicle identification numbers (VINs) one at a time or in batches. It is designed for checking vehicles purchased by or for the agency. Staff see what vehicle the vendor supplied, and what reliable information is available about it, from several configured data sources. They record inspection findings and produce PDF reports.

It runs on one computer or on a server on the agency's private network. It needs **no public cloud service**: data lives in a local SQLite database, and reports are generated on the server.

---

## Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Quick start](#quick-start)
4. [Configuration](#configuration)
5. [Creating the first administrator](#creating-the-first-administrator)
6. [Running on the agency network](#running-on-the-agency-network)
7. [Backups and restore](#backups-and-restore)
8. [Connecting a data provider](#connecting-a-data-provider)
9. [Data integrity rules](#data-integrity-rules)
10. [Roles](#roles)
11. [Security notes](#security-notes)
12. [Project structure](#project-structure)
13. [Tests](#tests)

---

## Features

- **Single VIN search**, with live validation (length, the forbidden letters I/O/Q, and the check digit).
- **Batch search** by pasting VINs (one per line or comma-separated) or uploading a CSV. A review step flags invalid, duplicate and check-digit-warning entries before submission.
- **Independent processing.** Each VIN is looked up separately on a server-side queue, with live progress. A failed or unmatched VIN never stops the others. Failed lookups can be retried one at a time or all together. Queued work resumes if the server restarts.
- **Multi-source lookup.** Every VIN is sent to all configured sources in parallel:
  - offline VIN structure analysis;
  - the official NHTSA vPIC decoder;
  - NHTSA model-level recalls;
  - any number of authorised history providers.
  
  Each value keeps its source, its retrieval time, and a basis label: *Confirmed by N sources*, *From provider*, *Decoded from VIN*, *Estimated from VIN* or *Ambiguous*. Conflicting values are flagged, never silently chosen between.
- **Specifications and history are reported separately.** A VIN can be fully decoded while accident/damage history is *not checked*. Decoding is never presented as evidence about accidents.
- **Vehicle profile:** make, model, year and specifications; accident and damage records; theft, salvage and write-off records; ownership history; maintenance history; and model-level safety recalls.
- **Staff-entered details:** checker, date and time, location (optional), case/contract reference, observed condition, inspection findings, supporting notes and evidence references. These are kept visibly separate from external data (purple "Staff-entered" sections).
- **Batch common details.** Apply case details to every vehicle, either filling blanks only or overwriting. Each vehicle can still be edited individually.
- **Re-check.** Any completed VIN, or a whole batch, can be looked up again against the currently configured sources.
- **Reports:**
  - an individual vehicle PDF;
  - a batch summary PDF (a table of VIN, make, model, year, status and outcome);
  - a ZIP containing both.
  
  Reports carry the agency name and logo, the protective marking, the case reference, the checking officer, the date/time and location, sources, and a signature block. Missing or unavailable information is labelled explicitly.
- **Search history** filtered by VIN, search or case reference, date range, staff member, location, search status and vehicle result.
- **Administration:** users and roles (admin / staff / viewer), an audit log, branding (agency name, logo, marking), and provider status.

## Requirements

- **Node.js 22.13 or newer** (Node 24 LTS recommended). No other runtime or database server is needed; SQLite is built into Node.
- Windows, Linux or macOS.
- About 100 MB of disk space, plus the database (a few KB per check).

## Quick start

```bash
# 1. Install dependencies (once)
npm install

# 2. Create your configuration
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env

# 3. Create the first administrator
npm run create-admin

# 4. Start the application
npm start
```

Open <http://127.0.0.1:3000> and sign in.

By default VINs are decoded using the offline VIN analysis plus the official NHTSA vPIC and Recalls APIs, which need outbound internet access. Accident and damage history is reported as **not checked** until an authorised history provider is connected (see [Connecting a data provider](#connecting-a-data-provider)).

**Development sample data.** To try the history screens without a provider, set `ENABLE_SAMPLE_DATA=true` and add `sample` to `DATA_PROVIDERS`. These sample VINs then return fictitious records:

| VIN | Demonstrates |
|---|---|
| `2T1BURHE4FC000101` | Accident, ownership and maintenance history |
| `1HGCV1F36JA000202` | Theft followed by recovery |
| `1FTFW1EF2CF000303` | Write-off and salvage |
| `WDDWF4KB3GR000505` | Reported stolen (no recovery) |
| `5NPD84LFXLH000404` | No adverse records |
| `JN1AZ4EHXDM000606` | Fails on the first attempt; use **Retry** |
| `JTDKN3DUXA0000808` | Specifications only, with no history records |

The sample provider returns no record for any other VIN. Sample data never counts as a live history check. Everything from the sample provider is labelled **SAMPLE — not verified**, both in the app and on reports, where it is also watermarked.

## Configuration

All settings are in `.env`, which only the server reads. See [.env.example](.env.example) for the full list. The main settings are:

| Setting | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Listening address. Use `0.0.0.0` to serve the network. |
| `DATA_DIR` | `data` | Location of the database, branding assets and backups. |
| `DATA_PROVIDERS` | `vin-structure,nhtsa-vpic,nhtsa-recalls` | Data sources queried for each VIN. |
| `ENABLE_SAMPLE_DATA` | `false` if unset | Must be `false` in live use. |
| `STRICT_CHECK_DIGIT` | `false` | If `true`, reject VINs whose check digit doesn't match (see note below). |
| `MAX_BATCH_SIZE` | `500` | Largest allowed batch. |
| `LOOKUP_CONCURRENCY` | `3` | Parallel lookups. Keep within the provider's rate limits. |
| `REPORT_TIMEZONE` | system zone | Time zone printed on reports, e.g. `Africa/Lagos`. |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | `60` / `12` | Session timeouts. |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS. |

**Check digits.** Position 9 is a mandatory check digit only for North American vehicles. Many European and Asian VINs don't use it. By default a mismatch is therefore shown as a **warning** and the VIN is still checked.

**Branding.** Set the agency name, department line, protective marking, report footer and logo in **Administration → Branding and data sources**. The logo is stored at `data/branding/logo.png` (or `.jpg`). For reports with non-Latin text, place TrueType fonts at `data/branding/fonts/Regular.ttf` and `Bold.ttf`.

## Creating the first administrator

```bash
npm run create-admin
```

This prompts for a username, full name and password. The password needs at least 10 characters and three of: lowercase, uppercase, digits, symbols.

For scripted installs:

```bash
ADMIN_PASSWORD='…' npm run create-admin -- --username admin --name "Jane Doe"
```

Running the command again for an existing username resets that account's password and makes it an active administrator. Use this to recover if every admin is locked out.

Administrators create the other accounts in **Administration → Users and roles**. New users must change their temporary password when they first sign in.

## Running on the agency network

1. In `.env`, set `HOST=0.0.0.0`. Open the port only to the agency network in the host firewall.
2. **Use HTTPS.** Put the app behind a reverse proxy that holds the agency's certificate (IIS with ARR, nginx, or Caddy), then set `COOKIE_SECURE=true` and `TRUST_PROXY=true`. Example nginx block:
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     client_max_body_size 5m;
   }
   ```
3. **Run as a service** so the app starts with the machine:
   - **Windows:** use [NSSM](https://nssm.cc/): `nssm install VINChecker "C:\Program Files\nodejs\node.exe" "--disable-warning=ExperimentalWarning server/index.js"`, then set the service's working directory to the project folder.
   - **Linux:** use a systemd unit with `WorkingDirectory=/opt/vin-checker` and `ExecStart=/usr/bin/node server/index.js`.
4. Set `NODE_ENV=production` and `ENABLE_SAMPLE_DATA=false`.

## Backups and restore

```bash
npm run backup                 # keeps the newest 30 backups
npm run backup -- --keep 90    # custom retention
```

Each backup goes to `data/backups/backup-<timestamp>/` (or `BACKUP_DIR`). It contains a consistent copy of the database, made with SQLite `VACUUM INTO` so it's safe while the app is running, plus the branding assets.

**Schedule daily backups.**
- **Windows Task Scheduler:** program `npm.cmd`, arguments `run backup`, start in `C:\path\to\vin_checker`.
- **Linux cron:** `0 2 * * * cd /opt/vin-checker && npm run backup`.

Copy backups to separate, access-controlled storage, such as a network share that is itself backed up.

**Restore:**
1. Stop the app.
2. Copy `vin-checker.db` from the backup into `data/`, replacing the existing file. Delete any `vin-checker.db-wal` and `-shm` files.
3. Copy `branding/` if needed.
4. Start the app.

## Connecting a data provider

VIN decoding and vehicle history must come from real, authorised sources. The integration layer is in [server/providers/](server/providers/).

| Provider id | What it is | Access |
|---|---|---|
| `vin-structure` | Offline analysis of the VIN characters: make from the manufacturer code (WMI), model year (resolved with the 49 CFR 565.15 rules), country, check digit. Model and trim can't be decoded offline, so they are never filled in by this source. | Always available |
| `nhtsa-vpic` | NHTSA vPIC decoder (US Department of Transportation): make, model, year, trim, body, engine, transmission, plant and more. Best coverage for vehicles built for North America. **Specifications only — no history.** | Free, no key; public internet |
| `nhtsa-recalls` | NHTSA Recalls API: recalls for the decoded make/model/year. **Model-level**: not proof that a given VIN was affected or repaired. | Free, no key; public internet |
| `vinaudit` | **VinAudit**, an NMVTIS-approved provider (USA and Canada). Covers police crash reports, salvage-auction damage, theft and recovery (NICB), junk/salvage/insurance total-loss records, title brands (flood, rebuilt, odometer), title and odometer history, liens and sale listings. | Paid account: API key, username and password |
| `http`, `http:<name>` | Connectors for **authorised vehicle-history providers** (accidents, damage, theft/salvage, ownership, maintenance). You can configure several. | Needs a provider agreement and credentials |
| `sample` | Development sample data (fictitious). | `ENABLE_SAMPLE_DATA=true` |

Remove `nhtsa-vpic` and `nhtsa-recalls` from `DATA_PROVIDERS` if agency policy doesn't allow outbound internet access. The app then works fully offline with VIN structure analysis only.

**Accident and damage history needs a licensed provider.** No free, official API gives VIN-level accident history. Options include:
- a national vehicle register or police stolen-vehicle database, where the agency has access;
- insurance-industry databases;
- commercial vehicle-history services (for US-origin vehicles, NMVTIS-approved data providers).

Until one is configured, every report states that history was **not checked**. The app never scrapes websites.

### Connecting VinAudit (accident, damage and theft history)

Most used vehicles imported into Nigeria and West Africa were first titled in the USA or Canada, so a US/Canadian title-history check is usually the most informative accident and damage check available.

1. Create an API-enabled account at [vinaudit.com](https://www.vinaudit.com/vehicle-history-api) and fund it. Reports are billed per vehicle.
2. Sign in as an administrator and go to **Administration → Branding and data sources → VinAudit**. Enter the API key, username and password, then **Save credentials**. They are stored on the server only and never shown again in the browser. You can instead set `VINAUDIT_KEY`, `VINAUDIT_USER` and `VINAUDIT_PASS` in `.env`; those take precedence.
3. Click **Test connection**. This makes a single VIN query to confirm the credentials work.
4. Run a new check, or open an earlier one and click **Re-check**. The "What was checked" panel should now say history was checked, with results in the accident, theft/salvage and title sections.

How the connector works:
- A report is requested with `/v2/query` and then `/v2/pullreport`.
- The report id is kept and reused for the same VIN for `VINAUDIT_REUSE_DAYS` (default 7), so re-checks don't pay twice. The report's generation date is shown in the sources table.
- Provider errors are reported clearly and can be retried: bad credentials, billing limit reached, rate limit, and NMVTIS temporarily unavailable.
- Vehicles never titled in the USA or Canada return "not found in VinAudit". That means VinAudit holds no records for the vehicle, not that it has a clean history.
- The connector follows VinAudit's published API documentation. It has been tested against a local emulation of that API, but not yet against a live account.

**Nigeria Police e-CMR.** The Central Motor Registry (stolen-vehicle and registration records) has no public API. If the agency obtains data-sharing access, connect it with the HTTP connector below, for example `http:ecmr` with `HTTP_ECMR_COVERAGE=statusRecords,ownership`.

### Using the HTTP connector

1. Obtain credentials and API documentation from the provider.
2. Configure `.env`. The key stays on the server and is never sent to browsers:
   ```ini
   DATA_PROVIDERS=vin-structure,nhtsa-vpic,nhtsa-recalls,http
   HISTORY_API_URL=https://provider.example/api/v1/vehicles/{vin}
   HISTORY_API_KEY=your-key
   HISTORY_API_KEY_HEADER=Authorization     # or X-API-Key, etc.
   HISTORY_API_KEY_PREFIX=Bearer            # leave empty for raw keys
   HISTORY_API_NAME=National Vehicle Register
   HISTORY_API_TRUST=verified               # or "unverified"
   HISTORY_API_COVERAGE=specs,accidents,statusRecords,ownership   # only what the provider really covers
   ```
   For a second provider, add `http:insurer` to `DATA_PROVIDERS` and set `HTTP_INSURER_URL`, `HTTP_INSURER_KEY`, `HTTP_INSURER_NAME`, `HTTP_INSURER_COVERAGE` and so on, using the same suffixes.
3. Adapt `mapResponse()` in [server/providers/http.js](server/providers/http.js) to convert the provider's JSON into the normalised format documented there. Categories missing from `COVERAGE` are reported as *not covered by any configured source* rather than *no records*.
4. Restart the app. **Administration → Branding and data sources** shows each provider's status, or what is missing. Use **Re-check** to look up earlier searches again with the new source.

### How results are combined

- **Specifications.** For each field, the value from an external provider is preferred, then a value decoded from the VIN, then an estimated one. Sample data comes last. Every other source's value is kept. If sources disagree on make, model or year, the field is marked **Conflict** and all the values are shown, both on screen and in the PDF.
- **Model year.** Position 10 repeats every 30 years (for example, "H" means 1987 or 2017). For North American VINs with a valid check digit, position 7 settles which (*Decoded*). Elsewhere the year is *Estimated*, or *Ambiguous* when it can't be determined. An ambiguous year is never shown as a value.
- **Outcome per source:** data returned, no matching record, not covered, not queried (for example, recalls when the model is unknown), or error (retryable). These are all shown separately.

**Try it without a real provider.** Run `npm run mock-provider` and use the settings in [scripts/mock-provider.js](scripts/mock-provider.js). The mock serves the sample fixtures, so set `HISTORY_API_TRUST=unverified`.

**Other kinds of source.** For a SOAP service, a database view or a file drop, copy `http.js` into a new provider module, register it in [server/providers/index.js](server/providers/index.js), and add its id to `DATA_PROVIDERS`. A provider's `lookup(vin)` must:
- return `{ status: 'match' | 'no_match', specs?, accidents?, statusRecords?, ownership?, maintenance? }`;
- **throw** on transient failures, which makes the item retryable.

Providers are queried in parallel and their results merged. Each value keeps its own source attribution.

## Data integrity rules

The code enforces these rules:

- **No invented history.** Records appear only if a provider returned them.
- **VIN decoding is labelled as decoding.** Make and model year decoded from the VIN are shown with the basis *Decoded from VIN* or *Estimated from VIN*. They are never presented as a record of the vehicle's history, and never used to claim anything about accidents.
- **History is reported separately and honestly.** The history status is one of:
  - *records found*;
  - *no records returned* (this doesn't prove the vehicle was never damaged);
  - *not found in source*;
  - *check failed*;
  - *not checked* (no live history provider).
- **Sample data is always labelled.** It carries a SAMPLE badge, a banner, report watermarks and the *not verified* trust level. It is never presented as verified, and never counts as a live check.
- **Each category states its availability:** records, "none returned by X", "not found in X", "X failed — retry", or "not covered by any configured source".
- **Staff-entered information is kept separate** from provider data, and it records who last edited it and when.
- **Absence of evidence is not treated as evidence.** The vehicle status reads "No adverse records returned" only when a live history source actually answered. It never says "clean".

## Roles

| Role | Can do |
|---|---|
| **Administrator** | Everything, including managing users, viewing the audit log, and changing branding. |
| **Staff** | Run single and batch checks, retry lookups, record inspection and case details, download reports, view history. |
| **Viewer** | Read-only: view history and results, download reports. |

At least one active administrator must always exist. Changing a user's role, disabling them or resetting their password signs them out immediately.

The audit log records:
- sign-ins, including failed attempts;
- searches and retries;
- detail edits, including which fields changed;
- report generation;
- user and settings changes.

## Security notes

- Passwords are hashed with scrypt. Login attempts are throttled per username and per IP address.
- Sessions are random tokens stored server-side (hashed) in HttpOnly, SameSite=Strict cookies, with idle and absolute timeouts.
- State-changing requests require a custom header, which acts as CSRF protection.
- There is a strict Content-Security-Policy with no inline scripts or styles, and all output is HTML-escaped.
- API keys and secrets exist only in the server's `.env`. No secret is ever sent to the browser.
- Protect `.env`, `data/` and the backups with file-system permissions. They contain the database of checks and the users' password hashes.

## Project structure

```
server/
  index.js            Express app, security headers, routing
  config.js           .env loading and settings
  db.js               SQLite schema and migrations
  auth.js / audit.js  Sessions, passwords, roles; audit log
  lookup-queue.js     Background, per-VIN lookup processing and retries
  details.js          Staff-entered details (validation, storage)
  providers/          Data-source integration layer (see above)
  reports/            PDF generation (pdfkit) and formatting
  routes/             auth, searches (incl. reports/ZIP), admin
shared/vin.js         VIN validation and CSV parsing (server and browser)
public/               Browser front end (no build step)
scripts/              create-admin, backup, mock-provider
test/                 Unit, end-to-end API and provider-connector tests
```

## Tests

```bash
npm test
```

This runs:
- the VIN validation unit tests;
- an end-to-end test that starts an isolated server and database, then goes through sign-in, single and batch searches, retry, staff details, batch apply, PDF/ZIP reports, history filters, role restrictions and the audit log;
- a test of the HTTP connector against the mock provider.

Sample output PDFs are written to `test-output/`.
