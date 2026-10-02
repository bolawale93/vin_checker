// A stand-in HTTP vehicle-history provider for testing the "http" connector
// end to end. It serves the bundled SAMPLE fixtures — never use it for real checks.
//
//   npm run mock-provider            (listens on http://127.0.0.1:4010)
//   .env:  DATA_PROVIDERS=vin-structure,http
//          HISTORY_API_URL=http://127.0.0.1:4010/v1/vehicles/{vin}
//          HISTORY_API_KEY=dev-mock-key
//          HISTORY_API_NAME=Mock provider (SAMPLE DATA)
//          HISTORY_API_TRUST=unverified
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PROVIDER_PORT || 4010);
const KEY = process.env.MOCK_PROVIDER_KEY || 'dev-mock-key';
const fixtures = JSON.parse(fs.readFileSync(new URL('../server/providers/sample-data.json', import.meta.url), 'utf8'));

http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'unauthorised' });
  const m = /^\/v1\/vehicles\/([A-Z0-9]{17})$/.exec(req.url || '');
  if (!m) return send(404, { error: 'not found' });
  const v = fixtures.vehicles[m[1]];
  if (!v) return send(404, { found: false });
  const { _simulateTransientFailure, ...vehicle } = v;
  setTimeout(() => send(200, { found: true, vehicle }), 200);
}).listen(PORT, '127.0.0.1', () => console.log(`Mock provider (SAMPLE DATA) on http://127.0.0.1:${PORT}/v1/vehicles/{vin}`));
