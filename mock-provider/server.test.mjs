import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from './server.mjs';

const secret = 'provider-contract-nonproduction-key';
const attempt = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const binding = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function provider(callback) {
  const server = createProvider({ secret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url, path, data, key = secret) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Key': key }, body: JSON.stringify(data) });

test('single-use proof is bound to attempt/browser and cannot choose unknown identities', async () => provider(async url => {
  assert.equal((await post(url, '/identity/issue', { subject: 'unknown', loginAttempt: attempt, browserBinding: binding })).status, 400);
  const proof = await (await post(url, '/identity/issue', { subject: 'bnoc', loginAttempt: attempt, browserBinding: binding })).json();
  assert.equal((await post(url, '/identity/verify', { ...proof, browserBinding: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })).status, 403);
  assert.equal((await post(url, '/identity/verify', { ...proof, browserBinding: binding }, 'wrong')).status, 403);
  const verified = await post(url, '/identity/verify', { ...proof, browserBinding: binding });
  assert.equal(verified.status, 200); assert.equal((await verified.json()).subject, 'bnoc');
  assert.equal((await post(url, '/identity/verify', { ...proof, browserBinding: binding })).status, 403);
}));
test('expired proof/control authorization and safe return origins are enforced', async () => provider(async url => {
  assert.equal((await post(url, '/control', { identity: 'expired' }, 'wrong')).status, 403);
  assert.equal((await post(url, '/identity/issue', { subject: 'requester', loginAttempt: attempt, browserBinding: binding, returnUrl: 'https://example.com/auth/callback' })).status, 400);
  await post(url, '/control', { identity: 'expired' });
  const proof = await (await post(url, '/identity/issue', { subject: 'requester', loginAttempt: attempt, browserBinding: binding })).json();
  assert.equal((await post(url, '/identity/verify', { ...proof, browserBinding: binding })).status, 403);
}));
test('GPS/CPCON provenance, dictionaries and failure scenarios remain independent', async () => provider(async url => {
  assert.equal((await fetch(url + '/feeds/gps')).status, 403);
  const gps = await (await fetch(url + '/feeds/gps', { headers: { 'X-Mock-Key': secret } })).json();
  assert.equal(gps.stageLabel, '양호'); assert.equal(gps.sourceMode, 'simulation');
  await post(url, '/control', { cpcon: { scenario: 'error' } });
  assert.equal((await fetch(url + '/feeds/cpcon', { headers: { 'X-Mock-Key': secret } })).status, 503);
  assert.equal((await fetch(url + '/feeds/gps', { headers: { 'X-Mock-Key': secret } })).status, 200);
  await post(url, '/control', { cpcon: { scenario: 'normal', stageCode: '4' } });
  const cpcon = await (await fetch(url + '/feeds/cpcon', { headers: { 'X-Mock-Key': secret } })).json();
  assert.equal(cpcon.stageLabel, 'CPCONⅣ급'); assert.notEqual(cpcon.scopeKey, gps.scopeKey);
}));
