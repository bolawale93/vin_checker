// Development-only provider backed by clearly labelled, fictitious fixtures.
// Enabled only when ENABLE_SAMPLE_DATA=true. Results are always marked as
// sample data and are never presented as verified.
import fs from 'node:fs';

const fixtures = JSON.parse(fs.readFileSync(new URL('./sample-data.json', import.meta.url), 'utf8'));
const failedOnce = new Set();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: 'sample',
  name: 'DEVELOPMENT SAMPLE DATA (fictitious, not verified)',
  trust: 'sample',
  recordSource: true,
  coverage: ['specs', 'accidents', 'statusRecords', 'ownership', 'maintenance'],

  async lookup(vin) {
    // Simulated network latency so batch progress is visible during demos.
    await delay(250 + Math.floor(Math.random() * 650));
    const v = fixtures.vehicles[vin];
    if (!v) return { status: 'no_match' };
    if (v._simulateTransientFailure && !failedOnce.has(vin)) {
      failedOnce.add(vin);
      throw new Error('Simulated provider timeout (sample data: retry to succeed).');
    }
    const { _simulateTransientFailure, ...record } = v;
    return { status: 'match', ...structuredClone(record) };
  },
};
