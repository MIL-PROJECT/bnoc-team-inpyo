import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// These expectations come from the approved design, not from the interrupted demo.
// This suite writes only to the separately configured verification database.
const base = process.env.BNOC_TEST_URL ?? 'http://127.0.0.1:8083';
const provider = process.env.BNOC_TEST_PROVIDER_URL ?? 'http://127.0.0.1:8082';
const evidence = process.env.BNOC_TEST_EVIDENCE_DIR ?? 'runtime/evidence/backend-implementation-20261013';
const runId = randomUUID().slice(0, 8);
const observations = [];
const clients = {};
const teams = ['무선반', '유선반', '전장반(전산장비)', '정체반', '암호반'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const operation = () => randomUUID();

class ApiClient {
  cookies = new Map();
  csrf = '';
  session;
  async raw(method, resource, body, extra = {}) {
    const headers = { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (method !== 'GET') Object.assign(headers, { Origin: new URL(base).origin, 'X-CSRF-Token': this.csrf });
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extra.headers);
    const response = await fetch(new URL(resource, base), { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const cookie of response.headers.getSetCookie()) {
      const [key, ...value] = cookie.split(';')[0].split('=');
      this.cookies.set(key, value.join('='));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    let json;
    if (response.headers.get('content-type')?.includes('json')) json = JSON.parse(bytes.toString());
    return { status: response.status, headers: response.headers, json, bytes };
  }
  async read(resource) {
    const response = await this.raw('GET', resource);
    assert.equal(response.status, 200, `GET ${resource}: ${response.json?.code ?? response.status}`);
    assert.ok(response.json && Object.hasOwn(response.json, 'data'), `GET ${resource} must return the public data envelope`);
    assert.ok(Number.isFinite(Date.parse(response.json.queriedAt)), `GET ${resource} queriedAt must be a timestamp`);
    noPrivateFields(response.json);
    return response.json;
  }
  async start() {
    const response = await this.raw('GET', '/api/auth/start');
    assert.equal(response.status, 200);
    const challenge = response.json.data;
    assert.ok(Number.isFinite(Date.parse(response.json.queriedAt)), 'authentication start uses the same query envelope');
    assert.equal(challenge.sourceMode, 'simulation');
    assert.ok(challenge.loginAttempt && challenge.providerUrl && challenge.csrfToken);
    this.csrf = challenge.csrfToken;
    return challenge;
  }
  async login(subject) {
    const challenge = await this.start();
    const ticket = await issue(subject, challenge);
    const result = await this.raw('POST', '/api/auth/complete', { ticket, loginAttempt: challenge.loginAttempt });
    assert.equal(result.status, 200, `login ${subject}: ${result.json?.code}`);
    this.session = (await this.read('/api/session')).data;
    this.csrf = this.session.csrfToken;
    return this;
  }
  async command(type, payload = {}, target = {}, id = operation()) {
    return this.raw('POST', '/api/commands', { type, operationId: id, ...target, payload });
  }
}

function noPrivateFields(value) {
  if (Array.isArray(value)) return value.forEach(noPrivateFields);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['targetId', 'requesterSubject', 'actorSubject', 'fingerprint', 'resultJson', 'storedName', 'stored_name', 'providerSecret', 'ssoToken', 'recipientActorId', 'password'].includes(key), `private response field: ${key}`);
    noPrivateFields(item);
  }
}

async function issue(subject, challenge) {
  const url = new URL(challenge.providerUrl);
  const response = await fetch(new URL('/identity/issue', provider), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, loginAttempt: challenge.loginAttempt, browserBinding: url.searchParams.get('browserBinding') }),
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200, 'registered role must receive a proof from the separate provider');
  const body = await response.json();
  assert.equal(typeof body.ticket, 'string');
  return body.ticket;
}

function input(overrides = {}) {
  return { category: '장비/체계', subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '지원' }, detail: `지원 업무 검사 ${runId}`, location: '요청 위치', contact: '000-0000', attachments: [], ...overrides };
}
function scheduleInterval(startsAt, hours = 1) { return { startsAt, endsAt: new Date(Date.parse(startsAt) + hours * 60 * 60 * 1000).toISOString() }; }
function success(result) {
  assert.equal(result.status, 200, result.json?.code ?? 'command must commit');
  assert.equal(result.json.ok, true);
  assert.equal(result.json.replayed, false);
  assert.ok(Number.isInteger(result.json.revision));
  noPrivateFields(result.json);
  return result.json;
}
function failure(result, status, code) {
  assert.equal(result.status, status, `${code}: actual ${result.status}/${result.json?.code}`);
  assert.equal(result.json?.code, code);
  assert.equal(typeof result.json.message, 'string');
  assert.ok(!Object.hasOwn(result.json, 'revision') && !Object.hasOwn(result.json, 'state'), 'errors must not disclose inaccessible state');
  assert.ok(!/SELECT\s|INSERT\s|SQLException|\/Users\/|jdbc:|X-Mock-Key/.test(JSON.stringify(result.json)), 'raw infrastructure errors must not be disclosed');
}
async function detail(number, actor = clients.bnoc) { return (await actor.read(`/api/requests/${number}`)).data; }
async function create(actor = clients.requester, overrides = {}) {
  const requesterRef = actor.session?.actor?.role === 'bnoc' ? clients.requester.session.actor.id : undefined;
  const saved = success(await actor.command('createRequest', input({ ...(requesterRef ? { requesterRef } : {}), ...overrides })));
  assert.match(saved.requestNumber, /^\d{3,}$/);
  return detail(saved.requestNumber, actor);
}
async function grantDepartmentManager(admin, manager, department = teams[0]) {
  const current=(await admin.read('/api/access-assignments')).data.items.find(item=>item.subjectRef===manager.session.actor.id);
  assert.ok(current,'the identified user has a service account mapping');
  success(await admin.command('changeAccess',{subjectRef:current.subjectRef,role:'requester',department,departmentManager:true,active:true},{expectedRevision:current.revision}));
  manager.session=(await manager.read('/api/session')).data;
}
async function assign(request, teamIds = [teams[0]], priority = 'general') {
  success(await clients.bnoc.command('assignTeams', { teamIds, priority }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  return detail(request.requestNumber);
}
async function updateWork(request, actor, team, changes) {
  const current = await detail(request.requestNumber);
  const work = current.workItems.find(item => item.teamId === team && !item.resolved);
  assert.ok(work, `effective work for ${team}`);
  success(await actor.command('updateWork', changes, { requestNumber: current.requestNumber, workNumber: work.workNumber, expectedRevision: work.revision }));
  return detail(current.requestNumber);
}
async function completedSubmission(actor, pending, operationId) {
  const deadline = Date.now() + 15000;
  let result = pending;
  while (result.status === 202) {
    assert.equal(result.json?.code, 'PROCESSING');
    assert.equal(result.headers.get('retry-after'), '2', 'processing responses must advertise the specified retry interval');
    assert.equal(result.json.retryAfter, 2);
    assert.ok(Date.now() < deadline, 'same submission receipt must eventually report its committed result');
    await pause(2000);
    result = await actor.raw('GET', `/api/operations/${encodeURIComponent(operationId)}`);
  }
  assert.equal(result.status, 200, result.json?.code ?? 'same submission receipt must confirm a commit');
  assert.equal(result.json.ok, true);
  assert.ok(Number.isInteger(result.json.revision));
  noPrivateFields(result.json);
  return result;
}
async function unenteredPastDates(actor, department, count = 2) {
  const selected = [];
  const start = Date.now() - (30 + parseInt(runId, 16) % 3650) * 86400000;
  for (let offset = 0; offset < 64 && selected.length < count; offset++) {
    const date = new Date(start - offset * 86400000).toISOString().slice(0, 10);
    const resources = await Promise.all(['personnel', 'night-duty'].map(async kind => (await actor.read(`/api/${kind}?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department)));
    if (resources.every(item => item?.submitted === false)) selected.push(date);
  }
  assert.equal(selected.length, count, 'verification must find isolated unentered past dates without deleting records');
  assert.ok(selected.every(date => Date.parse(date) < Date.now() - 86400000), 'selected records exercise past-date correction');
  return selected;
}
async function upload(actor, kind, content = '지원 문서', name = `검사-${runId}.txt`, contentType = 'text/plain') {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: contentType }), name);
  const response = await actor.raw('POST', `/api/attachments?resourceKind=${kind}`, form);
  assert.equal(response.status, 200, `upload: ${response.json?.code}`);
  const data = response.json.data;
  assert.ok(data?.id, 'upload returns a validated temporary public reference');
  assert.equal(data.fileName, name);
  assert.equal(data.size, bytes.byteLength);
  noPrivateFields(data);
  return data;
}
async function download(actor, file, content) {
  const response = await actor.raw('GET', `/api/attachments/${file.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.bytes.toString(), content, 'download must return the original stored file bytes');
}
async function control(payload) {
  assert.ok(process.env.BNOC_MOCK_SECRET, 'ENVIRONMENT_UNAVAILABLE: BNOC_MOCK_SECRET is required for isolated provider scenarios');
  const response = await fetch(new URL('/control', provider), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Key': process.env.BNOC_MOCK_SECRET }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, 'local scenario control is separate from BNOC business APIs');
}
async function waitFor(action, matches, description) {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (matches(last)) return last;
    await pause(300);
  }
  assert.fail(`${description}: last collectionState=${last?.collectionState}, failureCode=${last?.failureCode}`);
}

function contract(name, srs, action) {
  test(`${srs.map(n => `SR-BE-${String(n).padStart(3, '0')}`).join(', ')}: ${name}`, { concurrency: false }, async () => {
    const startedAt = new Date().toISOString();
    try {
      await action();
      observations.push({ name, requirements: srs, startedAt, completedAt: new Date().toISOString(), status: 'passed' });
    } catch (error) {
      observations.push({ name, requirements: srs, startedAt, completedAt: new Date().toISOString(), status: 'failed', error: error.message });
      throw error;
    }
  });
}

before(async () => {
  // Connectivity failures are environment failures, never useful fault detections.
  try { await new ApiClient().raw('GET', '/'); }
  catch (error) { error.message = `ENVIRONMENT_UNAVAILABLE: verification server ${base}; ${error.message}`; throw error; }
  for (const subject of ['requester', 'requester-secondary', 'bnoc', 'bnoc-secondary', 'team-wireless', 'team-wired', 'team-display', 'team-info', 'team-crypto', 'access-admin']) {
    clients[subject] = await new ApiClient().login(subject);
  }
  clients.requesterOther = clients['requester-secondary'];
  clients.bnocOther = clients['bnoc-secondary'];
  clients.wireless = clients['team-wireless'];
  clients.wired = clients['team-wired'];
  clients.display = clients['team-display'];
  clients.manager = clients['requester-secondary'];
  clients.admin = clients['access-admin'];
  await grantDepartmentManager(clients.admin,clients.manager);
});

after(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'api-results.json'), JSON.stringify({
    version: 'design-0.8', baseUrl: base, runId,
    scope: 'Actual HTTP commands and queries against a dedicated verification DB; real Air Force integration is not exercised.',
    passedRequirements: [...new Set(observations.filter(item => item.status === 'passed').flatMap(item => item.requirements))].sort((a, b) => a - b),
    observations
  }, null, 2));
});

contract('unauthenticated API and forged roles are rejected before data access', [1, 3, 34], async () => {
  const anonymous = new ApiClient();
  for (const resource of ['/api/session', '/api/requests', '/api/work-overview', '/api/notices', '/api/situation/gps', '/api/situation/cpcon']) {
    failure(await anonymous.raw('GET', resource), 401, 'UNAUTHENTICATED');
  }
  const request = await create();
  const target = { requestNumber: request.requestNumber, expectedRevision: request.revision };
  failure(await clients.requester.command('assignTeams', { teamIds: [teams[0]], priority: 'urgent' }, target), 403, 'FORBIDDEN');
  failure(await clients.requester.raw('POST', '/api/commands', { type: 'assignTeams', operationId: operation(), ...target, role: 'bnoc', payload: { teamIds: [teams[0]], priority: 'urgent' } }), 400, 'VALIDATION');
  failure(await clients.requester.command('updateRequest', { role: 'bnoc', detail: '권한 위조' }, target), 400, 'VALIDATION');
  const csrf = clients.requester.csrf;
  clients.requester.csrf = '';
  failure(await clients.requester.command('createRequest', input()), 403, 'FORBIDDEN');
  clients.requester.csrf = csrf;
  failure(await clients.requester.raw('POST', '/api/commands', { type: 'createRequest', operationId: operation(), payload: input() }, { headers: { Origin: 'https://invalid.example' } }), 403, 'FORBIDDEN');
});

contract('login proofs bind to the starting browser and are single use', [1, 3, 34], async () => {
  const a = new ApiClient(), b = new ApiClient();
  const ca = await a.start(), cb = await b.start();
  const ticket = await issue('bnoc', ca);
  failure(await b.raw('POST', '/api/auth/complete', { ticket, loginAttempt: ca.loginAttempt }), 403, 'FORBIDDEN');
  failure(await b.raw('POST', '/api/auth/complete', { ticket, loginAttempt: cb.loginAttempt }), 403, 'FORBIDDEN');
  failure(await a.raw('POST', '/api/auth/complete', { ticket: 'invalid-proof', loginAttempt: ca.loginAttempt }), 403, 'FORBIDDEN');
  failure(await a.raw('POST', '/api/auth/complete', { ticket, loginAttempt: ca.loginAttempt, role: 'admin' }), 400, 'VALIDATION');
  const saved = await a.raw('POST', '/api/auth/complete', { ticket, loginAttempt: ca.loginAttempt });
  assert.equal(saved.status, 200);
  const session = (await a.read('/api/session')).data;
  assert.equal(session.actor.role, 'bnoc');
  a.csrf = session.csrfToken;
  failure(await a.raw('POST', '/api/auth/complete', { ticket, loginAttempt: ca.loginAttempt }), 403, 'FORBIDDEN');
  const logout = await a.raw('POST', '/api/auth/logout', {});
  assert.equal(logout.status, 200);
  failure(await a.raw('GET', '/api/session'), 401, 'UNAUTHENTICATED');
});

contract('server sessions use role labels with no manufactured people or ranks', [1, 33], async () => {
  for (const subject of ['requester', 'bnoc', 'team-wireless', 'access-admin']) {
    const session = (await clients[subject].read('/api/session')).data;
    assert.equal(session.sourceMode, 'simulation');
    assert.ok(session.actor.displayName);
    assert.ok(!session.actor.rank && !session.actor.contactId);
    assert.ok(!/시험 계정|ID-\d|대위|중위|하사|김\S{2}|윤하린|배지안/.test(session.actor.displayName));
    assert.equal(Object.hasOwn(session, 'accounts'), false, 'session must not disclose an identity directory');
  }
});

contract('expired tickets and provider outages do not establish a session', [1, 3, 34], async () => {
  try {
    await control({ identity: 'expired' });
    const expired = new ApiClient(), challenge = await expired.start();
    const ticket = await issue('bnoc', challenge);
    failure(await expired.raw('POST', '/api/auth/complete', { ticket, loginAttempt: challenge.loginAttempt }), 403, 'FORBIDDEN');
    failure(await expired.raw('GET', '/api/session'), 401, 'UNAUTHENTICATED');
    await control({ reset: true });
    const unavailable = new ApiClient(), challengeTwo = await unavailable.start();
    const ticketTwo = await issue('bnoc', challengeTwo);
    await control({ identity: 'unavailable' });
    failure(await unavailable.raw('POST', '/api/auth/complete', { ticket: ticketTwo, loginAttempt: challengeTwo.loginAttempt }), 503, 'AUTH_PROVIDER_UNAVAILABLE');
    failure(await unavailable.raw('GET', '/api/session'), 401, 'UNAUTHENTICATED');
  } finally { await control({ reset: true }); }
});

contract('direct and proxy requests keep mandatory, optional, and conditional input rules', [4, 5, 17, 31], async () => {
  const requesterOptions = (await clients.bnoc.read('/api/requesters')).data;
  assert.ok(requesterOptions.length > 0);
  assert.deepEqual(Object.keys(requesterOptions[0]).sort(), ['department', 'displayName', 'requesterRef']);
  failure(await clients.requester.raw('GET', '/api/requesters'), 403, 'FORBIDDEN');
  failure(await clients.wireless.raw('GET', '/api/requesters'), 403, 'FORBIDDEN');
  for (const key of ['detail', 'location', 'contact']) {
    failure(await clients.requester.command('createRequest', input({ [key]: '' })), 400, 'VALIDATION');
  }
  failure(await clients.requester.command('createRequest', input({ maintenanceTarget: { department: '요청 부서' } })), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ requesterDisplayText: 'BNOC' })), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ priority: 'urgent' })), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ requesterRef: clients.requester.session.actor.id })), 400, 'VALIDATION');
  failure(await clients.bnoc.command('createRequest', input()), 400, 'VALIDATION');
  failure(await clients.bnoc.command('createRequest', input({ requesterRef: 'not-a-public-ref' })), 400, 'VALIDATION');
  failure(await clients.bnoc.command('createRequest', input({ requesterRef: clients.wireless.session.actor.id })), 400, 'VALIDATION');
  failure(await clients.bnoc.command('createRequest', input({ requesterRef: clients.requester.session.actor.id, requesterDisplayText: '임의 요청자' })), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ schedulePreferences: [{ rank: 1, date: 'not-a-date', period: 'AM' }] })), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ detail: 'a'.repeat(10001) })), 400, 'VALIDATION');
  for (const resourceType of ['PC', '프린터', '회선', '전화']) {
    const saved = await create(clients.requester, { subcategories: { systemType: '인트라넷', resourceType, workType: '지원' } });
    assert.equal(saved.subcategories.resourceType, resourceType);
    assert.deepEqual(saved.schedulePreferences, []);
    assert.equal(saved.priority ?? null, null);
    assert.equal(saved.status, '대기');
    failure(await clients.requesterOther.raw('GET', `/api/requests/${saved.requestNumber}`), 404, 'NOT_FOUND');
  }
  const meetingForm=await upload(clients.requester,'request','일반 회의 의뢰서','일반회의-검사.txt');
  const meeting = await create(clients.requester, { category: '회의 지원', subcategories: { meetingType: '일반회의' }, attachments:[{id:meetingForm.id}] });
  assert.equal(meeting.subcategories.meetingType, '일반회의');
  const proxy = await create(clients.bnoc, { requesterRef: clients.requester.session.actor.id });
  assert.equal(proxy.requesterDisplayText, [clients.requester.session.actor.displayName,clients.requester.session.actor.department].filter(Boolean).join(' · '));
  assert.equal((await detail(proxy.requestNumber, clients.requester)).canEdit, true);
  failure(await clients.requesterOther.raw('GET', `/api/requests/${proxy.requestNumber}`), 404, 'NOT_FOUND');
  success(await clients.requester.command('updateRequest', { detail: '실제 요청자가 수정' }, { requestNumber: proxy.requestNumber, expectedRevision: proxy.revision }));
  assert.equal((await detail(proxy.requestNumber, clients.requester)).detail, '실제 요청자가 수정');
  failure(await clients.wireless.command('createRequest', input()), 403, 'FORBIDDEN');
});

contract('files are real, private, type checked, and cannot be stolen from another upload', [3, 6, 28], async () => {
  const contents = '문서 저장과 다운로드 확인\n';
  const file = await upload(clients.requester, 'request', contents);
  failure(await clients.requester.raw('GET', `/api/attachments/${file.id}`), 404, 'NOT_FOUND');
  failure(await clients.requesterOther.command('createRequest', input({ attachments: [{ id: file.id }] })), 403, 'FORBIDDEN');
  const saved = await create(clients.requester, { attachments: [{ id: file.id }] });
  assert.equal(saved.attachments.length, 1);
  await download(clients.requester, file, contents);
  await download(clients.bnoc, file, contents);
  failure(await clients.requesterOther.raw('GET', `/api/attachments/${file.id}?resourceKind=notice`), 404, 'NOT_FOUND');
  const mismatched = new FormData();
  mismatched.set('file', new Blob(['not a PDF'], { type: 'application/pdf' }), '문서.pdf');
  failure(await clients.requester.raw('POST', '/api/attachments?resourceKind=request', mismatched), 400, 'VALIDATION');
  const forbidden = new FormData();
  forbidden.set('file', new Blob(['console.log(1)'], { type: 'text/javascript' }), '실행.js');
  failure(await clients.requester.raw('POST', '/api/attachments?resourceKind=request', forbidden), 400, 'VALIDATION');
  failure(await clients.requester.command('createRequest', input({ attachments: [{ fileName: '없는파일.txt', size: 1, type: 'text/plain' }] })), 400, 'VALIDATION');
});

contract('HWP content search and history viewing preserve authorized original attachments', [40, 41], async () => {
  const bytes = await readFile('frontend/src/preview/fixtures/support.hwp');
  const file = await upload(clients.requester, 'request', bytes, `회의 지원-${runId}.hwp`, 'application/octet-stream');
  const request = await create(clients.requester, { attachments: [{ id: file.id }] });
  failure(await clients.requesterOther.raw('GET', `/api/attachments/${file.id}/document`), 404, 'NOT_FOUND');

  const deadline = Date.now() + 30000;
  let document;
  do {
    document = (await clients.requester.read(`/api/attachments/${file.id}/document`)).data;
    if (!['pending', 'processing'].includes(document.status)) break;
    await pause(500);
  } while (Date.now() < deadline);
  assert.equal(document.status, 'ready', `HWP extraction: ${document.errorCode ?? document.status}`);
  assert.ok(document.blocks.some(block => block.text?.includes('마이크 점검')));
  failure(await clients.requester.raw('GET', `/api/attachments/${file.id}/document?offset=bad`), 400, 'VALIDATION');
  failure(await clients.requester.raw('GET', `/api/attachments/${file.id}/document?limit=0`), 400, 'VALIDATION');
  failure(await clients.requester.raw('POST', `/api/attachments/${file.id}/reprocess`, {}), 409, 'CONFLICT');

  const matching = await clients.requester.read(`/api/requests?q=%EB%A7%88%EC%9D%B4%ED%81%AC&requestNumber=${encodeURIComponent(request.requestNumber)}`);
  const row = matching.data.items.find(item => item.requestNumber === request.requestNumber);
  assert.ok(row, 'extracted HWP text must be searchable');
  assert.ok(row.matches.some(match => match.source === 'document' && match.attachmentRef === file.id));
  assert.equal(matching.data.documentSearchIncomplete, false);

  const replacement = await upload(clients.requester, 'request', '새 첨부 파일', `교체-${runId}.txt`);
  success(await clients.requester.command('updateRequest', { attachments: [{ id: replacement.id }] }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  const currentSearch = await clients.requester.read('/api/requests?q=%EB%A7%88%EC%9D%B4%ED%81%AC');
  assert.equal(currentSearch.data.items.some(item => item.requestNumber === request.requestNumber), false, 'removed attachment must leave current search');
  const historical = (await clients.requester.read(`/api/attachments/${file.id}/document`)).data;
  assert.equal(historical.status, 'ready', 'authorized request history retains extracted content');
  const history = (await clients.requester.read(`/api/requests/${request.requestNumber}/history`)).data.items;
  assert.ok(history.some(item => item.attachments.some(attachment => attachment.id === file.id)), 'history exposes the historical attachment reference');
  const original = await clients.requester.raw('GET', `/api/attachments/${file.id}`);
  assert.equal(original.status, 200);
  assert.deepEqual(original.bytes, bytes, 'analysis and replacement must not change original bytes');
});

contract('only BNOC assigns with an explicit classification and no schedule or chief input', [9, 10, 11, 20, 28, 31], async () => {
  let request = await create(clients.requester, { schedulePreferences: [{ rank: 1, date: '2026-10-20', period: 'AM' }] });
  const target = () => ({ requestNumber: request.requestNumber, expectedRevision: request.revision });
  failure(await clients.requester.command('moveToDocumentWaiting', {}, target()), 403, 'FORBIDDEN');
  success(await clients.bnoc.command('moveToDocumentWaiting', {}, target()));
  request = await detail(request.requestNumber);
  assert.equal(request.status, '문서 대기');
  failure(await clients.bnoc.command('assignTeams', { teamIds: [teams[0]] }, target()), 400, 'VALIDATION');
  failure(await clients.bnoc.command('assignTeams', { teamIds: [teams[0], '허용되지 않은 부서'], priority: 'general' }, target()), 400, 'VALIDATION');
  failure(await clients.bnoc.command('assignTeams', { teamIds: [teams[0], teams[0]], priority: 'general' }, target()), 400, 'VALIDATION');
  for (const forbidden of [{ schedule: '2026-10-20T01:00:00Z' }, { chiefId: 'bnoc' }, { assignedAt: '2000-01-01T00:00:00Z' }]) {
    failure(await clients.bnoc.command('assignTeams', { teamIds: [teams[0]], priority: 'general', ...forbidden }, target()), 400, 'VALIDATION');
  }
  const before = await detail(request.requestNumber);
  assert.equal(before.workItems.length, 0);
  assert.equal(before.priority ?? null, null);
  const beforeTime = Date.now();
  const assigned = await assign(request, [teams[0], teams[1]], 'urgent');
  assert.equal(assigned.priority, 'urgent');
  assert.equal(assigned.status, '배정');
  assert.equal(assigned.workItems.length, 2);
  assert.ok(Date.parse(assigned.assignedAt) >= beforeTime - 1000 && Date.parse(assigned.assignedAt) <= Date.now() + 1000);
  for (const work of assigned.workItems) {
    assert.match(work.workNumber, new RegExp(`^${assigned.requestNumber}-\\d+$`));
    assert.equal(work.schedule ?? null, null, 'BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE');
    assert.equal(work.status, '배정');
    assert.ok(!Object.hasOwn(work, 'chiefId'));
  }
  const notifications = (await clients.wireless.read('/api/notifications')).data.items;
  assert.ok(notifications.some(item => item.event === '작업 배정' && item.relatedRequestId === request.requestNumber));
  failure(await clients.bnoc.command('moveToDocumentWaiting', {}, { requestNumber: assigned.requestNumber, expectedRevision: assigned.revision }), 409, 'INVALID_STATE');
});

contract('BNOC classification corrections leave work state, schedule, and completion unchanged', [10, 11, 19], async () => {
  let request = await assign(await create());
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '완료', scheduleIntervals: [scheduleInterval('2026-10-21T03:00:00Z')] });
  const before = request.workItems;
  const target = { requestNumber: request.requestNumber, expectedRevision: request.revision };
  failure(await clients.requester.command('changePriority', { priority: 'urgent' }, target), 403, 'FORBIDDEN');
  failure(await clients.wireless.command('changePriority', { priority: 'urgent' }, target), 403, 'FORBIDDEN');
  failure(await clients.requester.command('updateRequest', { priority: 'urgent' }, target), 400, 'VALIDATION');
  success(await clients.bnocOther.command('changePriority', { priority: 'urgent' }, target));
  const changed = await detail(request.requestNumber);
  assert.equal(changed.priority, 'urgent');
  assert.equal(changed.status, '완료');
  assert.deepEqual(changed.workItems, before);
  const history = (await clients.bnoc.read(`/api/requests/${changed.requestNumber}/history`)).data.items;
  assert.ok(history.some(entry => /분류|일반·긴급|priority/.test(entry.field) && /general|일반/.test(entry.summary) && /urgent|긴급/.test(entry.summary)));
});

contract('work saves enforce ownership and transaction integrity on rejected partial input', [3, 12, 14, 28], async () => {
  const request = await assign(await create(), [teams[0], teams[1]]);
  const work = request.workItems.find(item => item.teamId === teams[0]);
  const target = { requestNumber: request.requestNumber, workNumber: work.workNumber, expectedRevision: work.revision };
  failure(await clients.wired.command('updateWork', { nextStatus: '완료' }, target), 403, 'FORBIDDEN');
  failure(await clients.bnoc.command('updateWork', { nextStatus: '완료' }, target), 403, 'FORBIDDEN');
  failure(await clients.wireless.command('updateWork', { nextStatus: '반환', returnReason: '' }, target), 400, 'VALIDATION');
  failure(await clients.wireless.command('updateWork', { nextStatus: '완료', scheduleIntervals: [{ startsAt: 'bad-date', endsAt: 'bad-date' }] }, target), 400, 'VALIDATION');
  failure(await clients.wireless.command('updateWork', { nextStatus: '작업 중', assignedPersonRefs: ['unknown-person-ref'] }, target), 400, 'VALIDATION');
  const after = await detail(request.requestNumber);
  assert.deepEqual(after.workItems, request.workItems, 'failed command must not leave a partly modified work item');
  assert.equal(after.status, '배정');
});

contract('all four work states correct both ways, completion is automatic, and current assigned state reopens requester edits', [7, 12, 13, 15, 19, 20], async () => {
  let request = await assign(await create());
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '작업 중', memo: '작업반 내부 메모' });
  failure(await clients.requester.command('updateRequest', { detail: '수정 거절 확인' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '완료' });
  assert.equal(request.status, '완료');
  const completed = request.workItems[0];
  assert.ok(completed.completion.completedBy);
  assert.ok(Number.isFinite(Date.parse(completed.completion.completedAt)));
  assert.equal(completed.assignedPersons?.length ?? 0, 0, 'personnel assignment remains optional on completion');
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '반환', returnReason: '다른 담당 부서 필요' });
  assert.equal(request.workItems[0].completion ?? null, null);
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '배정', reusePreviousSchedule:false, scheduleIntervals:[] });
  assert.equal(request.status, '배정');
  assert.equal(request.workItems[0].returnReason ?? null, null);
  success(await clients.requester.command('updateRequest', { detail: '현재 배정 상태에서 수정' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  request = await detail(request.requestNumber);
  assert.equal(request.detail, '현재 배정 상태에서 수정');
  const history = (await clients.bnoc.read(`/api/requests/${request.requestNumber}/history`)).data.items;
  assert.ok(history.some(entry => entry.summary.includes('완료')));
  assert.ok(history.some(entry => entry.summary.includes('반환')));
  const revision = request.revision, beforeHistory = history.length;
  success(await clients.requester.command('updateRequest', { detail: request.detail }, { requestNumber: request.requestNumber, expectedRevision: revision }));
  assert.equal((await detail(request.requestNumber)).revision, revision);
  assert.equal((await clients.bnoc.read(`/api/requests/${request.requestNumber}/history`)).data.items.length, beforeHistory);
});

contract('return reassignment preserves classification and locks only the replaced old work', [7, 10, 11, 14, 15, 23], async () => {
  let request = await assign(await create(), [teams[0]], 'urgent');
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '반환', returnReason: '전산장비 담당 작업' });
  failure(await clients.requester.command('updateRequest', { detail: '반환 상태 수정' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  const old = request.workItems[0];
  const target = { requestNumber: request.requestNumber, workNumber: old.workNumber, expectedRevision: old.revision };
  failure(await clients.bnoc.command('reassignReturnedWork', { teamIds: [teams[0]] }, target), 400, 'VALIDATION');
  success(await clients.bnoc.command('reassignReturnedWork', { teamIds: [teams[2]] }, target));
  request = await detail(request.requestNumber);
  assert.equal(request.priority, 'urgent');
  assert.equal(request.workItems.find(item => item.workNumber === old.workNumber).resolved, true);
  const oldLatest = request.workItems.find(item => item.workNumber === old.workNumber);
  failure(await clients.wireless.command('updateWork', { nextStatus: '배정' }, { ...target, expectedRevision: oldLatest.revision }), 409, 'INVALID_STATE');
  const newWork = request.workItems.find(item => item.teamId === teams[2]);
  assert.equal(newWork.status, '배정');
  assert.equal(newWork.schedule ?? null, null);
  assert.ok(Number.isFinite(Date.parse(newWork.assignedAt)));
  success(await clients.requester.command('updateRequest', { detail: '대체된 반환 제외 후 수정' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  const shared = (await clients.requester.read(`/api/work-overview?requestNumber=${request.requestNumber}`)).data;
  assert.equal(shared.items.length, 1);
  assert.equal(shared.items[0].workNumber, newWork.workNumber);
  assert.equal(shared.counts.assigned, 1);
  assert.equal(shared.counts.remaining, 1);
});

contract('requesters cancel their own work at any state without deleting history or permitting restart', [8, 19, 23], async () => {
  let request = await assign(await create());
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '완료' });
  failure(await clients.bnoc.command('cancelRequest', {}, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 403, 'FORBIDDEN');
  success(await clients.requester.command('cancelRequest', {}, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  request = await detail(request.requestNumber);
  assert.equal(request.status, '취소');
  assert.ok(request.workItems[0].completion);
  failure(await clients.wireless.command('updateWork', { nextStatus: '배정' }, { requestNumber: request.requestNumber, workNumber: request.workItems[0].workNumber, expectedRevision: request.workItems[0].revision }), 409, 'INVALID_STATE');
  failure(await clients.requester.command('updateRequest', { detail: '취소 수정' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  const history = (await clients.bnoc.read(`/api/requests/${request.requestNumber}/history`)).data.items;
  assert.ok(history.some(entry => entry.summary.includes('완료')) && history.some(entry => entry.summary.includes('취소')));
  assert.equal((await clients.requester.read(`/api/work-overview?requestNumber=${request.requestNumber}`)).data.items.length, 0);
});

contract('BNOC rejection closes only unassigned requests and notifies the connected requester', [8, 17, 19, 23, 29, 31], async () => {
  let request = await create();
  const target = { requestNumber: request.requestNumber, expectedRevision: request.revision };
  failure(await clients.wireless.command('rejectRequest', { reason: '담당 범위 밖' }, target), 404, 'NOT_FOUND');
  const blank = await clients.bnoc.command('rejectRequest', { reason: '  ' }, target);
  failure(blank, 400, 'VALIDATION');
  assert.equal(blank.json.fieldErrors.reason, '필수 입력입니다.');
  success(await clients.bnoc.command('rejectRequest', { reason: '우리 부대 담당 범위 밖입니다.' }, target));

  request = await detail(request.requestNumber, clients.requester);
  assert.equal(request.status, '기각');
  assert.equal(request.rejectionReason, '우리 부대 담당 범위 밖입니다.');
  assert.ok(Number.isFinite(Date.parse(request.rejectedAt)));
  assert.equal(request.canCancel, false);
  assert.equal(request.canAssign, false);
  assert.equal(request.canReject, false);
  assert.equal((await clients.requester.read(`/api/requests/${request.requestNumber}/history`)).data.items.some(item => item.summary === '기각 사유: 우리 부대 담당 범위 밖입니다.'), true);
  assert.equal((await clients.requester.read('/api/notifications')).data.items.some(item => item.relatedRequestId === request.requestNumber && item.event === '기각'), true);

  failure(await clients.requester.command('updateRequest', { detail: '종결 후 수정 금지' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  failure(await clients.requester.command('cancelRequest', {}, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  failure(await clients.bnoc.command('assignTeams', { teamIds: [teams[0]], priority: 'general' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  failure(await clients.bnoc.command('rejectRequest', { reason: '재기각 금지' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }), 409, 'INVALID_STATE');
  const shared = (await clients.requester.read(`/api/work-overview?bucket=unassigned&requestNumber=${request.requestNumber}`)).data;
  assert.equal(shared.items.length, 0);
  assert.equal(shared.unassignedRequests, 0);
  assert.equal((await clients.wireless.raw('GET', `/api/requests/${request.requestNumber}`)).status, 404);
});

contract('completed after-action reports start unclassified without approval and cannot be edited as assigned work', [5, 11, 16, 20, 23, 28], async () => {
  const payload = { ...input(), actualRequesterText: '요청 부서', actualStartedAt: '2026-10-12T01:00:00Z', actualCompletedAt: '2026-10-12T02:00:00Z', completedConfirmed: true, reason: '직접 요청 완료' };
  failure(await clients.wireless.command('createAfterActionReport', { ...payload, completedConfirmed: false }), 400, 'VALIDATION');
  failure(await clients.wireless.command('createAfterActionReport', { ...payload, priority: 'general' }), 400, 'VALIDATION');
  failure(await clients.requester.command('createAfterActionReport', payload), 403, 'FORBIDDEN');
  const result = success(await clients.wireless.command('createAfterActionReport', payload));
  let request = await detail(result.requestNumber);
  assert.equal(request.status, '완료');
  assert.equal(request.priority ?? null, null, 'AFTER_ACTION_MUST_START_UNCLASSIFIED');
  assert.equal(request.assignedAt ?? null, null);
  assert.equal(request.workItems.length, 1);
  assert.equal(request.workItems[0].origin, 'after-action');
  assert.equal(request.workItems[0].status, '완료');
  failure(await clients.wireless.command('updateWork', { nextStatus: '배정' }, { requestNumber: request.requestNumber, workNumber: request.workItems[0].workNumber, expectedRevision: request.workItems[0].revision }), 409, 'INVALID_STATE');
  success(await clients.bnoc.command('changePriority', { priority: 'general' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  request = await detail(result.requestNumber);
  assert.equal(request.priority, 'general');
  assert.equal(request.status, '완료');
  const shared = (await clients.requester.read(`/api/work-overview?requestNumber=${request.requestNumber}`)).data;
  assert.equal(shared.counts.assigned, 1, 'AFTER_ACTION_COUNTS_AS_ONE_COMPLETED_ASSIGNED_WORK');
  assert.equal(shared.counts.completed, 1);
  assert.equal(shared.counts.remaining, 0);
  assert.equal(shared.afterActionCompleted, 1);
  assert.equal(shared.items[0].origin, 'after-action');
});

contract('same submission replay and concurrent duplicate registration create one request', [28, 29, 31], async () => {
  const key = operation(), payload = input({ detail: `동일 제출 ${runId}` });
  const simultaneous = await Promise.all([clients.requester.command('createRequest', payload, {}, key), clients.requester.command('createRequest', payload, {}, key)]);
  assert.ok(simultaneous.every(result => [200, 202].includes(result.status)), 'a duplicate submission returns its result or the specified processing response');
  assert.ok(simultaneous.some(result => result.status === 200), 'one of the two simultaneous callers receives the committing result');
  const [first, second] = await Promise.all(simultaneous.map(result => completedSubmission(clients.requester, result, key)));
  assert.equal(first.json.requestNumber, second.json.requestNumber);
  assert.equal([first.json.replayed, second.json.replayed].filter(Boolean).length, 1);
  const replay = await clients.requester.command('createRequest', payload, {}, key);
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  failure(await clients.requester.command('createRequest', { ...payload, detail: '같은 식별값 다른 입력' }, {}, key), 409, 'DUPLICATE_ACTION');
  const matching = await clients.requester.read(`/api/requests?requestNumber=${first.json.requestNumber}`);
  assert.equal(matching.total, 1);
  const history = (await clients.bnoc.read(`/api/requests/${first.json.requestNumber}/history`)).data.items;
  assert.equal(history.filter(entry => entry.field === '등록').length, 1);
  const notifications = (await clients.bnoc.read('/api/notifications?size=100')).data.items;
  assert.equal(notifications.filter(entry => entry.event === '요청 등록' && entry.relatedRequestId === first.json.requestNumber).length, 1);
});

contract('independent team completions both save while same-target concurrent changes conflict', [13, 15, 28, 30], async () => {
  let request = await assign(await create(), [teams[0], teams[1]]);
  const save = (work, actor, status) => actor.command('updateWork', { nextStatus: status }, { requestNumber: request.requestNumber, workNumber: work.workNumber, expectedRevision: work.revision });
  const [wireless, wired] = request.workItems;
  const completed = await Promise.all([save(wireless, clients.wireless, '완료'), save(wired, clients.wired, '완료')]);
  completed.forEach(success);
  request = await detail(request.requestNumber);
  assert.equal(request.status, '완료');
  assert.ok(request.workItems.every(work => work.status === '완료'));
  const work = request.workItems.find(item => item.teamId === teams[0]);
  const results = await Promise.all([save(work, clients.wireless, '배정'), save(work, clients.wireless, '작업 중')]);
  assert.equal(results.filter(item => item.status === 200).length, 1);
  failure(results.find(item => item.status !== 200), 409, 'CONFLICT');
  const latest = await detail(request.requestNumber);
  const stale = await clients.requester.command('cancelRequest', {}, { requestNumber: request.requestNumber, expectedRevision: request.revision });
  failure(stale, 409, 'CONFLICT');
  assert.notEqual(latest.status, '취소');
});

contract('public lists paginate without duplicates and share no private request fields', [17, 18, 23, 31], async () => {
  const requests = await Promise.all([create(clients.requesterOther), create(clients.requesterOther), create(clients.requesterOther)]);
  assert.equal(new Set(requests.map(request => request.requestNumber)).size, 3);
  for (const request of requests) await assign(request, [teams[0]], 'general');
  const one = await clients.requesterOther.read('/api/requests?page=0&size=2');
  const two = await clients.requesterOther.read('/api/requests?page=1&size=2');
  assert.equal(one.size, 2); assert.equal(one.page, 0); assert.equal(one.total, two.total);
  assert.equal(one.data.items.length, 2);
  assert.ok(one.data.items.every(item => !two.data.items.some(other => other.requestNumber === item.requestNumber)));
  failure(await clients.requester.raw('GET', '/api/requests?page=-1&size=2'), 400, 'VALIDATION');
  const shared = await clients.requester.read('/api/work-overview?size=100');
  assert.equal(shared.data.counts.assigned, shared.data.counts.completed + shared.data.counts.remaining);
  const other = shared.data.items.find(item => requests.some(request => request.requestNumber === item.requestNumber));
  assert.ok(other && other.canOpenDetail === false);
  assert.equal(other.requesterContact, '000-0000', 'the shared work list includes only the requester phone needed by the agreed view');
  for (const row of shared.data.items) for (const privateField of ['detail', 'location', 'contact', 'attachments', 'memo', 'returnReason', 'assignedPersonRefs', 'assignedPersons', 'completion', 'registeredBy']) {
    assert.ok(!Object.hasOwn(row, privateField), `SHARED_WORK_PRIVATE_FIELD: ${privateField}`);
  }
  for (const actor of [clients.requester, clients.bnoc, clients.wireless, clients.admin]) {
    const rows = (await actor.read(`/api/work-overview?requestNumber=${requests[0].requestNumber}&size=100`)).data.items;
    const visible = rows.find(item => item.workNumber === `${requests[0].requestNumber}-1`);
    assert.ok(visible, `${actor.session.actor.role} receives the assigned work row`);
    assert.equal(visible?.requesterContact, '000-0000', `${actor.session.actor.role} sees the approved requester phone in the shared list`);
    for (const privateField of ['detail', 'location', 'contact']) assert.ok(!Object.hasOwn(visible, privateField), `${actor.session.actor.role} shared list omits ${privateField}`);
  }
  const [generalForm,videoForm]=await Promise.all([
    upload(clients.requesterOther,'request','일반 회의 의뢰서','일반회의-검사-2.txt'),
    upload(clients.requesterOther,'request','화상 회의 의뢰서','화상회의-검사.txt')
  ]);
  const pending = await Promise.all([
    create(clients.requesterOther, { category: '회의 지원', subcategories: { meetingType: '일반회의' }, attachments:[{id:generalForm.id}] }),
    create(clients.requesterOther, { category: '회의 지원', subcategories: { meetingType: '화상회의',videoPlatform:'KJCCS' }, attachments:[{id:videoForm.id}] })
  ]);
  const unassignedOne = await clients.requesterOther.read(`/api/work-overview?bucket=unassigned&category=${encodeURIComponent('회의 지원')}&page=0&size=1`);
  const unassignedTwo = await clients.requesterOther.read(`/api/work-overview?bucket=unassigned&category=${encodeURIComponent('회의 지원')}&page=1&size=1`);
  assert.equal(unassignedOne.page, 0); assert.equal(unassignedTwo.page, 1);
  assert.equal(unassignedOne.size, 1); assert.equal(unassignedOne.total, unassignedTwo.total);
  assert.ok(unassignedOne.total >= 2);
  assert.deepEqual(new Set([unassignedOne.data.items[0].requestNumber, unassignedTwo.data.items[0].requestNumber]), new Set(pending.map(item => item.requestNumber)), 'unassigned work-overview pages include both newest pending requests without duplicates');
  failure(await clients.requester.raw('GET', `/api/requests/${other.requestNumber}`), 404, 'NOT_FOUND');
});

contract('request and work overview units differ and support types remain searchable', [5, 18, 22, 23], async () => {
  failure(await clients.requester.raw('GET', '/api/overview'), 403, 'FORBIDDEN');
  for (const workType of ['지원', '대여', '신설', '이전', '점검', '고장']) {
    const saved = await assign(await create(clients.requester, { subcategories: { systemType: '인터넷', resourceType: '프린터', workType } }), [teams[0], teams[1]]);
    const queried = await clients.requester.read(`/api/work-overview?requestNumber=${saved.requestNumber}&workType=${encodeURIComponent(workType)}`);
    assert.equal(queried.total, 2);
    assert.equal(queried.data.counts.assigned, 2);
    assert.ok(queried.data.items.every(item => item.workType === workType));
    const requests = await clients.bnoc.read(`/api/overview?requestNumber=${saved.requestNumber}`);
    assert.equal(requests.data.total, 1);
    assert.equal(requests.data.byStatus['배정'], 1);
  }
});

contract('planned works persist by team, continue across dates, and count once beside existing work', [3, 23, 28, 30, 36], async () => {
  const localDate = (offset = 0) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
    const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const yesterday = localDate(-1), today = localDate(), tomorrow = localDate(1);
  failure(await clients.requester.raw('GET', `/api/planned-works?workDate=${today}`), 403, 'FORBIDDEN');
  const before = (await clients.requester.read('/api/work-overview?bucket=all&size=100')).data.counts;
  const operationId = operation();
  const createBody = { operationId, title: `장기 점검 ${runId}`, firstWorkDate: yesterday };
  const createdResponse = await clients.wireless.raw('POST', '/api/planned-works', createBody);
  assert.equal(createdResponse.status, 200, createdResponse.json?.code);
  const created = createdResponse.json.data.plannedWork;
  assert.equal(created.teamId, teams[0]); assert.equal(created.title, createBody.title);
  assert.equal(created.status, '진행 중'); assert.equal(created.firstWorkDate, yesterday); assert.equal(created.revision, 1);
  const replay = await clients.wireless.raw('POST', '/api/planned-works', createBody);
  assert.equal(replay.status, 200); assert.equal(replay.json.data.replayed, true);
  failure(await clients.wireless.raw('POST', '/api/planned-works', { ...createBody, title: '다른 내용' }), 409, 'DUPLICATE_ACTION');
  const foreignReplay = await clients.wired.raw('POST', '/api/planned-works', createBody);
  failure(foreignReplay, 409, 'OPERATION_NOT_AVAILABLE');
  assert.equal(JSON.stringify(foreignReplay.json).includes(createBody.title), false, 'the error response must not reveal the other account\'s task title');
  assert.equal((await clients.wired.read(`/api/planned-works?workDate=${today}`)).data.inProgress.some(item => item.title === createBody.title), false, 'another account cannot replay the prior result or see its title');
  const dayOne = (await clients.wireless.read(`/api/planned-works?workDate=${yesterday}`)).data;
  const dayTwo = (await clients.wireless.read(`/api/planned-works?workDate=${today}`)).data;
  const futureDay = (await clients.wireless.read(`/api/planned-works?workDate=${tomorrow}`)).data;
  for (const day of [dayOne, dayTwo, futureDay]) assert.equal(day.inProgress.filter(item => item.id === created.id).length, 1, 'the same work appears once on each selected date');
  assert.equal((await clients.wired.read(`/api/planned-works?workDate=${today}`)).data.inProgress.filter(item => item.id === created.id).length, 0);
  const beforeFuture = (await clients.wireless.read(`/api/planned-works?workDate=${yesterday}`)).data;
  const updatedBody = { operationId: operation(), revision: created.revision, title: created.title, firstWorkDate: today };
  const updatedResponse = await clients.wireless.raw('PATCH', `/api/planned-works/${created.id}`, updatedBody);
  assert.equal(updatedResponse.status, 200, updatedResponse.json?.code);
  const updated = updatedResponse.json.data.plannedWork;
  assert.equal(updated.revision, 2); assert.equal(updated.firstWorkDate, today);
  assert.equal((await clients.wireless.read(`/api/planned-works?workDate=${yesterday}`)).data.inProgress.filter(item => item.id === created.id).length, 0);
  assert.equal((await clients.wireless.read(`/api/planned-works?workDate=${today}`)).data.inProgress.filter(item => item.id === created.id).length, 1);
  assert.ok(beforeFuture.inProgress.some(item => item.id === created.id));
  failure(await clients.wireless.raw('PATCH', `/api/planned-works/${created.id}`, { operationId: operation(), revision: created.revision, title: '오래된 수정' }), 409, 'CONFLICT');
  failure(await clients.wired.raw('PATCH', `/api/planned-works/${created.id}`, { operationId: operation(), revision: updated.revision, title: '타 작업반 수정' }), 404, 'NOT_FOUND');
  const otherRole = await clients.requester.raw('POST', '/api/planned-works', { operationId: operation(), title: '권한 없는 생성', firstWorkDate: today });
  failure(otherRole, 403, 'FORBIDDEN');
  const allBeforeComplete = (await clients.requester.read('/api/work-overview?bucket=all&size=100')).data;
  assert.equal(allBeforeComplete.counts.all, before.all + 1);
  assert.equal(allBeforeComplete.counts.plannedInProgress, before.plannedInProgress + 1);
  const plannedBeforeComplete = (await clients.requester.read('/api/work-overview?bucket=planned&size=100')).data;
  assert.equal(plannedBeforeComplete.items.filter(item => item.source === 'planned' && item.plannedWorkId === created.id).length, 1);
  const completedResponse = await clients.wireless.raw('POST', `/api/planned-works/${created.id}/complete`, { operationId: operation(), revision: updated.revision, completedDate: today });
  assert.equal(completedResponse.status, 200, completedResponse.json?.code);
  assert.equal(completedResponse.json.data.plannedWork.status, '완료');
  failure(await clients.wireless.raw('POST', `/api/planned-works/${created.id}/complete`, { operationId: operation(), revision: completedResponse.json.data.plannedWork.revision, completedDate: tomorrow }), 400, 'VALIDATION');
  const afterComplete = (await clients.wireless.read(`/api/planned-works?workDate=${yesterday}`)).data;
  assert.equal(afterComplete.inProgress.filter(item => item.id === created.id).length, 0);
  assert.ok(afterComplete.completed.some(item => item.id === created.id));
  const overview = (await clients.requester.read('/api/work-overview?bucket=planned&size=100')).data;
  const shared = overview.items.find(item => item.plannedWorkId === created.id);
  assert.ok(shared); assert.equal(shared.title, createBody.title); assert.equal(shared.status, '완료');
  const allAfterComplete = (await clients.requester.read('/api/work-overview?bucket=all&size=100')).data;
  assert.equal(allAfterComplete.counts.all, before.all + 1);
  assert.equal(allAfterComplete.counts.plannedCompleted, before.plannedCompleted + 1);
  const plannedAfterComplete = (await clients.requester.read('/api/work-overview?bucket=planned&size=100')).data;
  assert.equal(plannedAfterComplete.items.filter(item => item.plannedWorkId === created.id).length, 1);
  const deleted = await clients.wireless.raw('DELETE', `/api/planned-works/${created.id}`, undefined, { headers: { 'If-Match': `\"${completedResponse.json.data.plannedWork.revision}\"` } });
  assert.equal(deleted.status, 200, deleted.json?.code);
  assert.equal((await clients.wireless.read(`/api/planned-works?workDate=${today}`)).data.completed.filter(item => item.id === created.id).length, 0);
  failure(await clients.wireless.raw('POST', '/api/planned-works', createBody), 409, 'DUPLICATE_ACTION');
  const afterDelete = (await clients.requester.read('/api/work-overview?bucket=all&size=100')).data;
  assert.equal(afterDelete.counts.all, before.all);
  noPrivateFields(shared);
});

contract('schedule uses real team schedule, start inclusive/end exclusive, and a separate unscheduled list', [5, 10, 12, 21], async () => {
  failure(await clients.requester.raw('GET', '/api/schedule?from=2026-10-20&to=2026-10-21'), 403, 'FORBIDDEN');
  failure(await clients.admin.raw('GET', '/api/schedule?from=2026-10-20&to=2026-10-21'), 403, 'FORBIDDEN');
  let request = await assign(await create(clients.requester, { detail: 'PC가 시작되지 않습니다.', location: '요청 위치', contact: '031-1234', schedulePreferences: [{ rank: 1, date: '2026-10-20', period: 'AM' }] }), [teams[0], teams[1]]);
  const empty = (await clients.wireless.read('/api/schedule?from=2026-10-20&to=2026-10-21')).data;
  assert.ok(empty.unscheduled.some(item => item.workNumber === request.workItems.find(work => work.teamId === teams[0]).workNumber));
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '배정', scheduleIntervals: [scheduleInterval('2026-10-20T01:00:00Z')], memo: '교체 부품 확인' });
  const ownWork = request.workItems.find(item => item.teamId === teams[0]);
  const day = (await clients.wireless.read('/api/schedule?from=2026-10-20&to=2026-10-21')).data;
  assert.deepEqual(Object.keys(day).sort(), ['completedRecords', 'entries', 'from', 'to', 'unscheduled'], 'schedule exposes only the documented response envelope');
  assert.ok(day.entries.some(item => item.workNumber === ownWork.workNumber));
  const scheduled = day.entries.find(item => item.workNumber === ownWork.workNumber);
  assert.deepEqual(Object.keys(scheduled).sort(), ['location', 'memo', 'origin', 'request', 'scheduleIntervals', 'status', 'teamId', 'workNumber'].sort(), 'schedule entries expose only the documented fields');
  assert.deepEqual(Object.keys(scheduled.request), ['requestNumber'], 'schedule carries only the request number needed to open authorized detail');
  assert.equal(scheduled.request.requestNumber, request.requestNumber);
  assert.ok(!Object.hasOwn(scheduled, 'detail'), 'schedule projection does not expose request details');
  assert.equal(scheduled.memo, '교체 부품 확인');
  assert.equal(scheduled.location, '요청 위치');
  assert.equal(scheduled.origin, 'assigned');
  assert.equal(scheduled.scheduleIntervals[0].startsAt, '2026-10-20T01:00:00Z');
  assert.ok(!Object.hasOwn(scheduled, 'requesterContact'), 'schedule projection excludes the phone number');
  const reported = success(await clients.wireless.command('createAfterActionReport', {
    ...input({ detail: '후보고 요청 상세 비공개 검사', location: '선조치 위치', contact: '031-9876' }), actualRequesterText: '선조치 요청자',
    actualStartedAt: '2026-10-20T04:13:00Z', actualCompletedAt: '2026-10-20T04:29:00Z', completedConfirmed: true, reason: '선조치 처리', completionMemo: '현장 확인'
  }));
  const ownSchedule = (await clients.wireless.read('/api/schedule?from=2026-10-20&to=2026-10-21')).data;
  const completedRecord = ownSchedule.completedRecords.find(item => item.request.requestNumber === reported.requestNumber);
  assert.ok(completedRecord, 'after-action record appears in its actual start date');
  assert.deepEqual(Object.keys(completedRecord).sort(), ['actualStartedAt', 'location', 'memo', 'origin', 'request', 'status', 'teamId', 'workNumber'].sort());
  assert.equal(completedRecord.actualStartedAt, '2026-10-20T04:13:00Z');
  assert.equal(completedRecord.origin, 'after-action');
  assert.equal(completedRecord.location, '선조치 위치');
  assert.equal(completedRecord.memo, '현장 확인');
  assert.ok(!Object.hasOwn(completedRecord, 'requesterContact') && !Object.hasOwn(completedRecord, 'detail'));
  const bnoc = (await clients.bnoc.read('/api/schedule?from=2026-10-20&to=2026-10-21')).data;
  assert.deepEqual(Object.keys(bnoc).sort(), ['completedRecords', 'entries', 'from', 'to', 'unscheduled'], 'BNOC schedule exposes only the documented response envelope');
  const unscheduled = bnoc.unscheduled.find(item => item.request.requestNumber === request.requestNumber && item.teamId === teams[1]);
  assert.ok(unscheduled, 'BNOC can see another assigned department in the unscheduled schedule list');
  assert.deepEqual(Object.keys(unscheduled).sort(), ['location', 'memo', 'origin', 'request', 'scheduleIntervals', 'status', 'teamId', 'workNumber'].sort(), 'unscheduled schedule entries expose only the documented fields');
  assert.deepEqual(Object.keys(unscheduled.request), ['requestNumber'], 'unscheduled schedule carries only the request number needed to open authorized detail');
  assert.ok(bnoc.unscheduled.every(item => !Object.hasOwn(item, 'detail') && !Object.hasOwn(item, 'requesterContact')), 'unscheduled projection excludes request details and phone numbers');
  assert.ok(day.entries.every(item => item.teamId === teams[0]));
  const before = (await clients.wireless.read('/api/schedule?from=2026-10-19&to=2026-10-20')).data;
  assert.ok(!before.entries.some(item => item.workNumber === ownWork.workNumber));
  assert.ok(bnoc.entries.some(item => item.workNumber === ownWork.workNumber));
  failure(await clients.bnoc.raw('GET', '/api/schedule?from=2026-10-21&to=2026-10-20'), 400, 'VALIDATION');
});

contract('detail, history, and notification DTOs remove cross-team internal information', [3, 17, 19, 20, 23, 34], async () => {
  let request = await assign(await create(), [teams[0], teams[1]]);
  request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '작업 중', memo: '무선 내부 정보' });
  request = await updateWork(request, clients.wired, teams[1], { nextStatus: '반환', returnReason: '유선 내부 반환 정보', memo: '유선 내부 정보' });
  const requester = await detail(request.requestNumber, clients.requester);
  assert.ok(!JSON.stringify(requester).includes('내부 정보') && !JSON.stringify(requester).includes('내부 반환 정보'));
  const wireless = await detail(request.requestNumber, clients.wireless);
  assert.ok(JSON.stringify(wireless).includes('무선 내부 정보'));
  assert.ok(!JSON.stringify(wireless).includes('유선 내부 정보') && !JSON.stringify(wireless).includes('유선 내부 반환 정보'));
  const publicHistory = (await clients.requester.read(`/api/requests/${request.requestNumber}/history`)).data.items;
  assert.ok(!JSON.stringify(publicHistory).includes('내부 정보') && !JSON.stringify(publicHistory).includes('내부 반환 정보'));
  assert.ok(publicHistory.every(entry => !Object.hasOwn(entry, 'before') && !Object.hasOwn(entry, 'after') && !Object.hasOwn(entry, 'actorId')));
  const notifications = (await clients.bnoc.read('/api/notifications?size=100')).data.items;
  assert.ok(notifications.some(entry => entry.event === '작업 반환' && entry.relatedRequestId === request.requestNumber));
  noPrivateFields(notifications);
});

contract('department rosters, daily personnel, and night duty preserve old references without extending write permissions', [2, 3, 12, 24, 25, 33], async () => {
  failure(await clients.requester.raw('GET', '/api/personnel?date=2026-10-01'), 403, 'FORBIDDEN');
  failure(await clients.requester.raw('GET', '/api/night-duty?date=2026-10-01'), 403, 'FORBIDDEN');
  const department = clients.manager.session.actor.department;
  const rosterDisplayName = `담당 인원 현황 ${runId}`;
  let roster = (await clients.manager.read(`/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  const before = roster.entries;
  const saved = success(await clients.manager.command('savePersonnelRoster', { department, entries: [...before, { displayName: rosterDisplayName, active: true }] }, { expectedRevision: roster.revision }));
  assert.ok(saved.publicRef);
  roster = (await clients.manager.read(`/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  const added = roster.entries.find(entry => !before.some(old => old.personRef === entry.personRef));
  assert.ok(added?.personRef);
  failure(await clients.manager.command('savePersonnelRoster', { department: teams[1], entries: [] }, { expectedRevision: 0 }), 403, 'FORBIDDEN');
  const [date, differentPastDate] = await unenteredPastDates(clients.manager, department);
  const own = (await clients.manager.read(`/api/personnel?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department);
  assert.equal(own.submitted, false);
  assert.equal(own.entries.find(entry => entry.personRef === added.personRef).status, null, 'unentered status must not become available');
  success(await clients.manager.command('saveDailyPersonnel', { department, date, entries: [{ personRef: added.personRef, status: 'leave' }] }, { expectedRevision: own.revision }));
  const otherView = (await clients.wireless.read(`/api/personnel?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department);
  assert.equal(otherView.entries.find(entry => entry.personRef === added.personRef).status, 'leave');
  failure(await clients.wireless.command('saveDailyPersonnel', { department, date, entries: [{ personRef: added.personRef, status: 'trip' }] }, { expectedRevision: otherView.revision }), 403, 'FORBIDDEN');
  const night = (await clients.manager.read(`/api/night-duty?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department);
  assert.equal(night.submitted, false);
  success(await clients.manager.command('saveNightDuty', { department, date, personRefs: [added.personRef] }, { expectedRevision: night.revision }));
  assert.equal((await clients.wired.read(`/api/night-duty?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department).entries[0].personRef, added.personRef);
  success(await clients.manager.command('savePersonnelRoster', { department, entries: roster.entries.map(entry => ({ ...entry, active: entry.personRef === added.personRef ? false : entry.active })) }, { expectedRevision: roster.revision }));
  const day = (await clients.manager.read(`/api/personnel?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department);
  success(await clients.manager.command('saveDailyPersonnel', { department, date, entries: [{ personRef: added.personRef, status: 'trip' }] }, { expectedRevision: day.revision }));
  const retainedNight = (await clients.manager.read(`/api/night-duty?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department);
  success(await clients.manager.command('saveNightDuty', { department, date, personRefs: [added.personRef] }, { expectedRevision: retainedNight.revision }));
  assert.equal((await clients.manager.read(`/api/personnel?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find(item => item.department === department).entries.find(entry => entry.personRef === added.personRef).status, 'trip');
  failure(await clients.manager.command('saveDailyPersonnel', { department, date: differentPastDate, entries: [{ personRef: added.personRef, status: 'leave' }] }, { expectedRevision: 0 }), 400, 'VALIDATION');
  failure(await clients.manager.command('saveNightDuty', { department, date: differentPastDate, personRefs: [added.personRef] }, { expectedRevision: 0 }), 400, 'VALIDATION');
});

contract('any BNOC edits notices while retaining another BNOC attachment, without borrowing other resources', [3, 6, 27, 28, 30], async () => {
  const content = '공지 첨부문서 저장';
  const file = await upload(clients.bnoc, 'notice', content);
  failure(await clients.requester.command('createDirective', { title: '업무 안내', body: '게시 권한 검사', attachmentRefs: [] }), 403, 'FORBIDDEN');
  const saved = success(await clients.bnoc.command('createDirective', { title: '업무 안내', body: '전체 로그인 사용자에게 전달', attachmentRefs: [file.id] }));
  assert.ok(saved.publicRef);
  let notice = (await clients.requester.read(`/api/notices/${saved.publicRef}`)).data;
  assert.equal(notice.title, '업무 안내');
  assert.equal(notice.attachments[0].id, file.id);
  await download(clients.requester, file, content);
  success(await clients.bnocOther.command('updateDirective', { noticeRef: notice.noticeRef, title: '수정된 업무 안내', body: '다른 BNOC의 수정', attachmentRefs: [file.id] }, { expectedRevision: notice.revision }));
  notice = (await clients.requester.read(`/api/notices/${notice.noticeRef}`)).data;
  assert.equal(notice.title, '수정된 업무 안내');
  assert.equal(notice.attachments[0].id, file.id, 'existing notice attachments are retained regardless of uploader');
  failure(await clients.bnocOther.command('updateDirective', { noticeRef: notice.noticeRef, title: '오래된 수정', body: notice.body, attachmentRefs: [file.id] }, { expectedRevision: notice.revision - 1 }), 409, 'CONFLICT');
  const requestFile = await upload(clients.bnoc, 'request', '요청 첨부');
  failure(await clients.bnoc.command('updateDirective', { noticeRef: notice.noticeRef, title: notice.title, body: notice.body, attachmentRefs: [requestFile.id] }, { expectedRevision: notice.revision }), 403, 'FORBIDDEN');
  const stolen = await upload(clients.bnoc, 'notice', '타인 임시 첨부');
  failure(await clients.bnocOther.command('updateDirective', { noticeRef: notice.noticeRef, title: notice.title, body: notice.body, attachmentRefs: [stolen.id] }, { expectedRevision: notice.revision }), 403, 'FORBIDDEN');
  failure(await clients.bnoc.command('updateDirective', { noticeRef: notice.noticeRef, title: notice.title, body: notice.body, attachmentRefs: [file.id], hidden: true }, { expectedRevision: notice.revision }), 400, 'VALIDATION');
  success(await clients.bnocOther.command('updateDirective', { noticeRef: notice.noticeRef, title: notice.title, body: notice.body, attachmentRefs: [] }, { expectedRevision: notice.revision }));
  assert.equal((await clients.requester.read(`/api/notices/${notice.noticeRef}`)).data.attachments.length, 0);
  // File-retention after removal and DB-fault rollback are additionally checked from SQL by the independent verifier.
});

contract('work personnel are selected from the owning team roster and remain distinct from completion actor', [2, 3, 12, 13, 24], async () => {
  const all = (await clients.admin.read('/api/access-assignments')).data.items;
  const account = all.find(item => item.subjectRef === clients.wireless.session.actor.id);
  assert.ok(account);
  const permission = { subjectRef: account.subjectRef, role: account.role, department: account.department, teamId: account.teamId, departmentManager: true, active: true };
  success(await clients.admin.command('changeAccess', permission, { expectedRevision: account.revision }));
  try {
    const rosterDisplayName = `담당 인원 작업 ${runId}`;
    let roster = (await clients.wireless.read(`/api/personnel-roster?department=${encodeURIComponent(teams[0])}`)).data;
    const original = roster.entries;
    success(await clients.wireless.command('savePersonnelRoster', { department: teams[0], entries: [...original, { displayName: rosterDisplayName, active: true }] }, { expectedRevision: roster.revision }));
    roster = (await clients.wireless.read(`/api/personnel-roster?department=${encodeURIComponent(teams[0])}`)).data;
    const person = roster.entries.find(entry => !original.some(before => before.personRef === entry.personRef));
    assert.ok(person);
    let request = await assign(await create());
    const work = request.workItems[0], target = { requestNumber: request.requestNumber, workNumber: work.workNumber, expectedRevision: work.revision };
    failure(await clients.wireless.command('updateWork', { nextStatus: '완료', assignedPersonRefs: [person.personRef, person.personRef] }, target), 400, 'VALIDATION');
    request = await updateWork(request, clients.wireless, teams[0], { nextStatus: '완료', assignedPersonRefs: [person.personRef] });
    assert.equal(request.workItems[0].assignedPersons[0].personRef, person.personRef);
    assert.equal(request.workItems[0].assignedPersons[0].displayName, rosterDisplayName);
    assert.equal(request.workItems[0].completionActor, clients.wireless.session.actor.displayName);
    assert.notEqual(request.workItems[0].completionActor, rosterDisplayName);
    const shared = (await clients.requester.read(`/api/work-overview?requestNumber=${request.requestNumber}`)).data.items[0];
    assert.ok(!Object.hasOwn(shared, 'assignedPersonRefs') && !Object.hasOwn(shared, 'assignedPersons'));
  } finally {
    const latest = (await clients.admin.read('/api/access-assignments')).data.items.find(item => item.subjectRef === account.subjectRef);
    success(await clients.admin.command('changeAccess', { ...permission, departmentManager: account.departmentManager }, { expectedRevision: latest.revision }));
  }
});

contract('access revocation is immediate and old successful receipts cannot bypass it', [1, 2, 3, 29], async () => {
  failure(await clients.requester.raw('GET', '/api/access-assignments'), 403, 'FORBIDDEN');
  const current = (await clients.admin.read('/api/access-assignments')).data.items;
  const target = current.find(item => item.subjectRef === clients.bnocOther.session.actor.id);
  assert.ok(target, 'the secondary BNOC has a public service account reference');
  const request = await create();
  const key = operation();
  const body = { priority: 'urgent' }, affected = { requestNumber: request.requestNumber, expectedRevision: request.revision };
  success(await clients.bnocOther.command('changePriority', body, affected, key));
  const accessPayload = { subjectRef: target.subjectRef, role: target.role, department: target.department, teamId: target.teamId ?? null, departmentManager: target.departmentManager, active: false };
  success(await clients.admin.command('changeAccess', accessPayload, { expectedRevision: target.revision }));
  try {
    failure(await clients.bnocOther.command('changePriority', body, affected, key), 401, 'UNAUTHENTICATED');
    const self = (await clients.admin.read('/api/access-assignments')).data.items.find(item => item.subjectRef === clients.admin.session.actor.id);
    assert.ok(self);
    assert.equal(self.role, 'admin');
    assert.equal(self.departmentManager, false);
    const department = clients.bnoc.session.actor.department;
    assert.ok(department, 'self-access rejection must receive a valid business role and configured department');
    failure(await clients.admin.command('changeAccess', { subjectRef: self.subjectRef, role: 'requester', department, teamId: null, departmentManager: false, active: true }, { expectedRevision: self.revision }), 403, 'FORBIDDEN');
    const unchanged = (await clients.admin.read('/api/access-assignments')).data.items.find(item => item.subjectRef === self.subjectRef);
    assert.deepEqual(unchanged, self, 'a rejected self-access change must preserve all account fields');
    assert.equal(unchanged.revision, self.revision, 'a rejected self-access change must not advance its version');
  } finally {
    const latest = (await clients.admin.read('/api/access-assignments')).data.items.find(item => item.subjectRef === target.subjectRef);
    success(await clients.admin.command('changeAccess', { ...accessPayload, active: true }, { expectedRevision: latest.revision }));
  }
});

contract('GPS and CPCON show independent stored dictionaries, timestamps, scope, and simulation provenance', [26, 33, 34, 35], async () => {
  const gps = (await clients.requester.read('/api/situation/gps')).data;
  const cpcon = (await clients.requester.read('/api/situation/cpcon')).data;
  assert.equal(gps.kind, 'gps'); assert.equal(cpcon.kind, 'cpcon');
  assert.equal(gps.sourceMode, 'simulation'); assert.equal(cpcon.sourceMode, 'simulation');
  assert.ok(['ok', 'stale', 'failed'].includes(gps.collectionState));
  assert.ok(['ok', 'stale', 'failed'].includes(cpcon.collectionState));
  assert.ok(Number.isFinite(Date.parse(gps.lastAttempt)) && Number.isFinite(Date.parse(cpcon.lastAttempt)));
  assert.ok(Number.isFinite(Date.parse(gps.observedAt)) && Number.isFinite(Date.parse(cpcon.observedAt)));
  assert.match(gps.stageCode, /^[1-5]$/);
  assert.match(cpcon.stageCode, /^[1-5]$/);
  if (gps.stageCode === '5') assert.ok(gps.stageLabel.includes('양호'));
  else assert.ok(!gps.stageLabel.includes('양호'));
  assert.match(cpcon.stageLabel, /^CPCON[ⅠⅡⅢⅣⅤ]급$/);
  assert.ok(!cpcon.stageLabel.includes('양호') && !/시험 단계\s*[ABab]/.test(cpcon.stageLabel));
  assert.notEqual(gps.scopeKey, cpcon.scopeKey);
  failure(await clients.bnoc.command('setGps', { stageCode: 1 }), 400, 'VALIDATION');
  failure(await clients.bnoc.command('setCpcon', { stageCode: 1 }), 400, 'VALIDATION');
});

contract('one situation source failing preserves its last value without contaminating the other source', [26, 34, 35], async () => {
  const read = kind => clients.requester.read(`/api/situation/${kind}`).then(response => response.data);
  try {
    await control({ gps: { scenario: 'normal', stageCode: '3' }, cpcon: { scenario: 'normal', stageCode: '4' } });
    const gps = await waitFor(() => read('gps'), item => Number(item.stageCode) === 3 && item.collectionState === 'ok', 'GPS normal 3');
    const cpcon = await waitFor(() => read('cpcon'), item => Number(item.stageCode) === 4 && item.collectionState === 'ok', 'CPCON normal 4');
    assert.ok(!gps.stageLabel.includes('양호'));
    assert.equal(cpcon.stageLabel, 'CPCONⅣ급');
    for (const scenario of ['error', 'invalid-stage', 'wrong-kind', 'missing-field', 'future']) {
      const previous = await read('cpcon');
      await control({ cpcon: { scenario }, gps: { scenario: 'normal', stageCode: '5' } });
      const failed = await waitFor(() => read('cpcon'), item => item.collectionState === 'failed' && item.lastAttempt !== previous.lastAttempt, `CPCON ${scenario}`);
      assert.equal(failed.stageCode, cpcon.stageCode);
      assert.equal(failed.observedAt, previous.observedAt, 'failed feed must not replace the last source timestamp with now');
      assert.equal(failed.lastSuccess, previous.lastSuccess);
      assert.ok(failed.failureCode);
      const healthy = await waitFor(() => read('gps'), item => Number(item.stageCode) === 5 && item.collectionState === 'ok', 'GPS remains independently healthy');
      assert.ok(healthy.stageLabel.includes('양호'));
    }
    await control({ cpcon: { scenario: 'normal', stageCode: '4' }, gps: { scenario: 'error' } });
    const lastGps = await read('gps');
    const failedGps = await waitFor(() => read('gps'), item => item.collectionState === 'failed' && item.lastAttempt !== lastGps.lastAttempt, 'GPS error');
    assert.equal(Number(failedGps.stageCode), 5, 'failure must keep the previous value, labelled as failed');
    assert.equal((await waitFor(() => read('cpcon'), item => item.collectionState === 'ok', 'CPCON recovery')).stageLabel, 'CPCONⅣ급');
    await control({ gps: { scenario: 'stale', stageCode: '2' } });
    const stale = await waitFor(() => read('gps'), item => Number(item.stageCode) === 2 && item.collectionState === 'stale', 'stale source timestamp');
    assert.ok(Date.now() - Date.parse(stale.observedAt) > 120000);
    assert.ok(!stale.stageLabel.includes('양호'));
  } finally { await control({ reset: true }); }
});

contract('reauthentication reloads committed requests and real attachment bytes from the server', [6, 19, 28, 32, 34], async () => {
  const content = '재접속 뒤 파일 보존';
  const file = await upload(clients.requester, 'request', content);
  const request = await create(clients.requester, { attachments: [{ id: file.id }], detail: `서버 재조회 ${runId}` });
  const next = await new ApiClient().login('requester');
  const fetched = await detail(request.requestNumber, next);
  assert.equal(fetched.detail, request.detail);
  assert.equal(fetched.registeredAt, request.registeredAt);
  assert.deepEqual(fetched.attachments, request.attachments);
  await download(next, file, content);
});

contract('direct assigned department change preserves history and blocks started work', [3,12,14,15,19,20,29,30,31], async () => {
  let request=await assign(await create(),[teams[0]],'urgent');
  request=await updateWork(request,clients.wireless,teams[0],{nextStatus:'배정',scheduleIntervals:[scheduleInterval('2026-10-20T01:00:00Z')],memo:'기존 계획'});
  const old=request.workItems[0];const target={requestNumber:request.requestNumber,workNumber:old.workNumber,expectedRevision:old.revision};
  const payload={teamIds:[teams[1]]};
  failure(await clients.requester.command('reassignAssignedWork',payload,target),403,'FORBIDDEN');
  failure(await clients.wireless.command('reassignAssignedWork',payload,target),403,'FORBIDDEN');
  failure(await clients.bnoc.command('reassignAssignedWork',{teamIds:[teams[0]]},target),400,'VALIDATION');
  const id=operation();success(await clients.bnoc.command('reassignAssignedWork',payload,target,id));
  const replay=await clients.bnoc.command('reassignAssignedWork',payload,target,id);
  assert.equal(replay.status,200);assert.equal(replay.json.ok,true);assert.equal(replay.json.replayed,true);
  request=await detail(request.requestNumber);
  const previous=request.workItems.find(work=>work.workNumber===old.workNumber),next=request.workItems.find(work=>!work.resolved);
  assert.equal(previous.status,'배정');assert.equal(previous.returnReason ?? null,null);
  assert.equal(previous.schedule,old.schedule);assert.equal(previous.resolutionKind,'reassigned');
  assert.equal(next.teamId,teams[1]);assert.equal(next.status,'배정');assert.equal(next.schedule ?? null,null);
  assert.equal(next.workNumber,request.requestNumber+'-2');assert.equal(request.priority,'urgent');
  assert.deepEqual(request.teamIds,[teams[1]]);assert.equal(request.progress.totalWorks,1);
  assert.ok((await clients.wireless.read('/api/notifications')).data.items.some(item=>item.event==='배정 변경' && item.relatedRequestId===request.requestNumber));
  assert.ok((await clients.wired.read('/api/notifications')).data.items.some(item=>item.event==='작업 배정' && item.relatedRequestId===request.requestNumber));
  failure(await clients.wireless.command('updateWork',{nextStatus:'작업 중'},{...target,expectedRevision:previous.revision}),409,'INVALID_STATE');
  request=await updateWork(request,clients.wired,teams[1],{nextStatus:'작업 중'});
  failure(await clients.bnoc.command('reassignAssignedWork',{teamIds:[teams[2]]},{requestNumber:request.requestNumber,workNumber:next.workNumber,expectedRevision:next.revision}),409,'CONFLICT');
  const started=request.workItems.find(work=>!work.resolved);
  failure(await clients.bnoc.command('reassignAssignedWork',{teamIds:[teams[2]]},{requestNumber:request.requestNumber,workNumber:started.workNumber,expectedRevision:started.revision}),409,'INVALID_STATE');
  assert.equal((await detail(request.requestNumber)).workItems.length,2);
});
