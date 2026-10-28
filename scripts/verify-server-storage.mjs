import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root, runtimeRoot, testEnvironment, runVerifySQL, stopService, startApplication } from './bnoc-runtime.mjs';

const environment = await testEnvironment();
const base = environment.BNOC_TEST_URL;
const provider = environment.BNOC_MOCK_URL;
assert.equal(base, 'http://127.0.0.1:8083', 'ONLY_SEPARATE_VERIFICATION_SERVER');
const mode = process.argv[2];
assert.ok(['concurrency', 'rollback', 'persistence','eligibility'].includes(mode), 'Choose concurrency, rollback, persistence or eligibility.');
const evidence = process.env.BNOC_TEST_EVIDENCE_DIR ?? join(root, 'runtime/evidence/backend-implementation-20261013');
await mkdir(evidence, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observations = [];

class Client {
  cookies = new Map();
  csrf = '';
  async call(method, path, body) {
    const headers = { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (method !== 'GET') Object.assign(headers, { Origin: base, 'X-CSRF-Token': this.csrf });
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    for (const cookie of response.headers.getSetCookie()) { const [key, ...value] = cookie.split(';')[0].split('='); this.cookies.set(key, value.join('=')); }
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes.toString()) : null;
    return { status: response.status, json, bytes };
  }
  async get(path) { const result = await this.call('GET', path); assert.equal(result.status, 200); return result.json.data; }
  async login(subject) {
    const challenge = await this.get('/api/auth/start'); this.csrf = challenge.csrfToken;
    const response = await fetch(provider + '/identity/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, loginAttempt: challenge.loginAttempt, browserBinding: new URL(challenge.providerUrl).searchParams.get('browserBinding') }) });
    assert.equal(response.status, 200); const { ticket } = await response.json();
    assert.equal((await this.call('POST', '/api/auth/complete', { ticket, loginAttempt: challenge.loginAttempt })).status, 200);
    this.session = await this.get('/api/session'); this.csrf = this.session.csrfToken; return this;
  }
  async command(type, payload, target = {}, operationId = randomUUID()) { return this.call('POST', '/api/commands', { type, payload, ...target, operationId }); }
}
async function providerControl(payload) {
  const secrets=JSON.parse(await readFile(join(runtimeRoot,'secrets.json'),'utf8'));
  const response=await fetch(provider+'/control',{method:'POST',headers:{'Content-Type':'application/json','X-Mock-Key':secrets.mockSecret},body:JSON.stringify(payload)});
  assert.equal(response.status,200,'MOCK_PROVIDER_CONTROL_ISOLATED_FROM_PRODUCT_DATABASE');
}
const success = result => { assert.equal(result.status, 200, result.json?.code); assert.equal(result.json.ok, true); return result.json; };
const input = () => ({ category: '장비/체계', subcategories: { systemType: '인터넷', resourceType: 'PC', workType: '지원' }, detail: '지원 처리 검증', location: '요청 위치', contact: '000-1234', attachments: [] });

// This lock uses only a test-created request in bnoc_verify. No product fault endpoint.
async function holdSQL(sql) {
  const mysql = join(process.env.BNOC_MYSQL_HOME ?? join(root, '.local/dependencies/mysql-8.4.11-macos15-arm64'), 'bin/mysql');
  const child = spawn(mysql, [`--defaults-extra-file=${join(runtimeRoot, 'verify.cnf')}`, '--batch', '--skip-column-names', '--unbuffered'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Verification lock client failed: ' + errors.slice(0, 250)))); });
  const ready = new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('Verification request lock not acquired.')), 5000);
    child.stdout.on('data', bytes => { text += bytes.toString(); if (text.includes('LOCK_HELD')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  child.stdin.write(`START TRANSACTION; ${sql} SELECT 'LOCK_HELD';\n`);
  try { await ready; } catch (error) { child.stdin.end('ROLLBACK;\n'); await closed.catch(() => {}); throw error; }
  let released = false;
  return async () => { if (released) return; released = true; child.stdin.end('COMMIT;\n'); await closed; };
}
async function holdRequest(number) {
  assert.match(number, /^\d+$/);
  return holdSQL(`SELECT request_number FROM bnoc_requests WHERE request_number='${number}' FOR UPDATE;`);
}
async function concurrency() {
  const [requester, bnoc, wireless, wired] = await Promise.all(['requester', 'bnoc', 'team-wireless', 'team-wired'].map(async subject => new Client().login(subject)));
  const saved = success(await requester.command('createRequest', input()));
  let request = await bnoc.get('/api/requests/' + saved.requestNumber);
  success(await bnoc.command('assignTeams', { teamIds: ['무선반', '유선반'], priority: 'general' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  request = await bnoc.get('/api/requests/' + saved.requestNumber);
  const release = await holdRequest(request.requestNumber);
  let responses, waiting;
  try {
    const writes = request.workItems.map(work => (work.teamId === '무선반' ? wireless : wired).command('updateWork', { nextStatus: '완료' }, { requestNumber: request.requestNumber, workNumber: work.workNumber, expectedRevision: work.revision }));
    await pause(500);
    waiting = Number((await runVerifySQL("SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER='bnoc_verify' AND (INFO LIKE 'SELECT%bnoc_requests%FOR UPDATE%' OR INFO LIKE '%bnoc_resource_locks%');")).trim());
    assert.ok(waiting >= 2, 'BOTH_CHANGES_MUST_WAIT_ON_CONTROLLED_REQUEST_LOCK');
    await release();
    responses = await Promise.all(writes);
  } finally { await release().catch(() => {}); }
  responses.forEach(success);
  const latest = await bnoc.get('/api/requests/' + request.requestNumber);
  assert.ok(latest.workItems.every(work => work.status === '완료'), 'BOTH_TEAM_COMPLETIONS_MUST_COMMIT');
  const expectedStale = process.argv.includes('--expect-stale');
  observations.push({ check: 'CONTROLLED_INNODB_CONCURRENT_COMPLETION', requestNumber: latest.requestNumber, waitingTransactions: waiting, workStates: latest.workItems.map(work => work.status), aggregateState: latest.status, expectedStale });
  if (expectedStale) assert.notEqual(latest.status, '완료', 'REPEATABLE_READ_STALE_AGGREGATE_MUST_BE_REPRODUCED');
  else assert.equal(latest.status, '완료', 'ALL_COMMITTED_COMPLETIONS_MUST_UPDATE_AGGREGATE');

  const pending=success(await requester.command('createRequest',input()));
  let assigned=await bnoc.get('/api/requests/'+pending.requestNumber);
  success(await bnoc.command('assignTeams',{teamIds:['무선반'],priority:'general'},{requestNumber:assigned.requestNumber,expectedRevision:assigned.revision}));
  assigned=await bnoc.get('/api/requests/'+pending.requestNumber);
  const original=assigned.workItems[0],target={requestNumber:assigned.requestNumber,workNumber:original.workNumber,expectedRevision:original.revision};
  const unlockAssignment=await holdRequest(assigned.requestNumber);
  let race;
  try {
    const writes=[wireless.command('updateWork',{nextStatus:'작업 중'},target),bnoc.command('reassignAssignedWork',{teamIds:['유선반']},target)];
    await pause(500);
    const waiting=Number((await runVerifySQL("SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER='bnoc_verify' AND INFO LIKE 'SELECT%bnoc_requests%FOR UPDATE%';")).trim());
    assert.ok(waiting>=2,'START_AND_REASSIGN_MUST_WAIT_ON_REQUEST_LOCK');
    await unlockAssignment();race=await Promise.all(writes);
  } finally {await unlockAssignment();}
  assert.deepEqual(race.map(result=>result.status).sort(),[200,409],'START_OR_REASSIGN_ONLY_ONE_MAY_COMMIT');
  assert.equal(race.find(result=>result.status===409).json.code,'CONFLICT');
  const raced=await bnoc.get('/api/requests/'+assigned.requestNumber);
  const current=raced.workItems.filter(work=>!work.resolved);
  assert.equal(current.length,1);
  assert.equal(current[0].teamId,race[0].status===200?'무선반':'유선반');
  assert.equal(current[0].status,race[0].status===200?'작업 중':'배정');
  observations.push({check:'DIRECT_ASSIGNMENT_START_RACE',httpStatuses:race.map(result=>result.status),currentDepartment:current[0].teamId,workState:current[0].status});

  const directory=await bnoc.get('/api/personnel-roster?department='+encodeURIComponent('무선반'));
  const directoryLock=await holdSQL("INSERT INTO bnoc_resource_locks(resource_key) VALUES ('personnel-directory') ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key); SELECT resource_key FROM bnoc_resource_locks WHERE resource_key='personnel-directory' FOR UPDATE;");
  let rosterResults,rosterWaiting;
  try {
    const writes=[1,2].map(index=>bnoc.command('saveCentralPerson',{department:'무선반',category:'병',rank:'상병',displayName:`동시 명부 검사 ${randomUUID()}`,serviceNumber:`CONCURRENCY-${randomUUID().replaceAll('-','')}`,internalPhone:'7654',active:true},{expectedRevision:directory.revision}));
    await pause(500);
    const pendingSql="SELECT CONCAT(COALESCE(USER,''),'|',COALESCE(INFO,'')) FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID<>CONNECTION_ID() AND USER='bnoc_verify' AND INFO IS NOT NULL;";
    const pendingInfo=(await runVerifySQL(pendingSql)).trim();
    rosterWaiting=pendingInfo?pendingInfo.split('\n').length:0;
    assert.ok(rosterWaiting>=2,`BOTH_CENTRAL_ROSTER_WRITES_MUST_WAIT_ON_DIRECTORY_LOCK: ${pendingInfo}`);
    await directoryLock();rosterResults=await Promise.all(writes);
  } finally {await directoryLock();}
  const rosterStatuses=rosterResults.map(result=>result.status).sort();
  observations.push({check:'CONTROLLED_INNODB_CENTRAL_ROSTER_VERSION',waitingTransactions:rosterWaiting,httpStatuses:rosterStatuses,expectedStale});
  if(expectedStale) assert.deepEqual(rosterStatuses,[200,200],'STALE_DIRECTORY_VERSION_MUST_BE_REPRODUCED');
  else {
    assert.deepEqual(rosterStatuses,[200,409],'SECOND_STALE_CENTRAL_ROSTER_WRITE_MUST_CONFLICT');
    assert.equal(rosterResults.find(result=>result.status===409).json.code,'CONFLICT');
  }
}

async function rollback() {
  const requester = await new Client().login('requester');
  const key = randomUUID();
  const counts = () => runVerifySQL('SELECT (SELECT COUNT(*) FROM bnoc_requests),(SELECT COUNT(*) FROM bnoc_works),(SELECT COUNT(*) FROM bnoc_history),(SELECT COUNT(*) FROM bnoc_notifications),(SELECT COUNT(*) FROM bnoc_receipts),(SELECT COUNT(*) FROM bnoc_operation_locks);');
  const before = (await counts()).trim();
  const trigger = 'verification_notification_failure';
  assert.equal((await runVerifySQL(`SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='${trigger}';`)).trim(), '0', 'NEVER_REPLACE_EXISTING_TRIGGER');
  let result;
  await runVerifySQL(`CREATE TRIGGER ${trigger} BEFORE INSERT ON bnoc_notifications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled verification failure';`);
  try { result = await requester.command('createRequest', input(), {}, key); }
  finally { await runVerifySQL(`DROP TRIGGER ${trigger};`); }
  assert.equal(result.status, 500); assert.equal(result.json.code, 'SAVE_FAILED');
  assert.equal((await counts()).trim(), before, 'BUSINESS_HISTORY_NOTIFICATION_RECEIPT_MUST_ROLL_BACK_TOGETHER');
  assert.equal((await runVerifySQL(`SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='${trigger}';`)).trim(), '0');
  const retry = success(await requester.command('createRequest', input(), {}, key));
  observations.push({ check: 'NOTIFICATION_INSERT_FAILURE_ROLLBACK', httpStatus: result.status, code: result.json.code, allCountsUnchanged: true, temporaryTriggerRemoved: true, sameSubmissionRetrySucceeded: true, retryRequestNumber: retry.requestNumber });
  const bnoc=await new Client().login('bnoc');
  let assigned=await bnoc.get('/api/requests/'+retry.requestNumber);
  success(await bnoc.command('assignTeams',{teamIds:['무선반'],priority:'urgent'},{requestNumber:assigned.requestNumber,expectedRevision:assigned.revision}));
  assigned=await bnoc.get('/api/requests/'+retry.requestNumber);
  const work=assigned.workItems[0],target={requestNumber:assigned.requestNumber,workNumber:work.workNumber,expectedRevision:work.revision};
  const unchanged=(await counts()).trim(),directKey=randomUUID();
  await runVerifySQL(`DELIMITER $$\nCREATE TRIGGER ${trigger} BEFORE INSERT ON bnoc_notifications FOR EACH ROW BEGIN IF NEW.event_name='작업 배정' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled assignment failure'; END IF; END$$\nDELIMITER ;\n`);
  let failed;
  try {failed=await bnoc.command('reassignAssignedWork',{teamIds:['유선반']},target,directKey);}
  finally {await runVerifySQL(`DROP TRIGGER ${trigger};`);}
  assert.equal(failed.status,500);assert.equal(failed.json.code,'SAVE_FAILED');
  assert.deepEqual(await bnoc.get('/api/requests/'+assigned.requestNumber),assigned,'DIRECT_ASSIGNMENT_FAILURE_MUST_RESTORE_ORIGINAL_WORK');
  assert.equal((await counts()).trim(),unchanged,'DIRECT_ASSIGNMENT_HISTORY_NOTIFICATIONS_RECEIPT_MUST_ROLL_BACK');
  success(await bnoc.command('reassignAssignedWork',{teamIds:['유선반']},target,directKey));
  assert.equal((await bnoc.get('/api/requests/'+assigned.requestNumber)).workItems.length,2);
  observations.push({check:'DIRECT_ASSIGNMENT_SECOND_NOTIFICATION_FAILURE_ROLLBACK',httpStatus:failed.status,allCountsUnchanged:true,sameSubmissionRetrySucceeded:true});

}

async function persistence() {
  const [requester, bnoc, wireless] = await Promise.all(['requester', 'bnoc', 'team-wireless'].map(async subject => new Client().login(subject)));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const plannedTitle = `서버 재시작 계획 작업 ${randomUUID()}`;
  const plannedCreate = await wireless.call('POST', '/api/planned-works', { operationId: randomUUID(), title: plannedTitle, firstWorkDate: today });
  assert.equal(plannedCreate.status, 200, plannedCreate.json?.code);
  const planned = plannedCreate.json.data.plannedWork;
  const plannedBefore = (await wireless.get(`/api/planned-works?workDate=${today}`)).inProgress.find(item => item.id === planned.id);
  assert.ok(plannedBefore, 'PLANNED_WORK_MUST_BE_SAVED_BEFORE_RESTART');
  const content = Buffer.from('첨부 내용 보존 검증', 'utf8');
  const form = new FormData(); form.set('resourceKind', 'request'); form.set('file', new Blob([content], { type: 'text/plain' }), '업무문서.txt');
  const uploaded = await requester.call('POST', '/api/attachments', form); assert.equal(uploaded.status, 200);
  const file = uploaded.json.data;
  const saved = success(await requester.command('createRequest', { ...input(), attachments: [{ id: file.id }] }));
  let request = await bnoc.get('/api/requests/' + saved.requestNumber);
  success(await bnoc.command('assignTeams', { teamIds: ['무선반'], priority: 'urgent' }, { requestNumber: request.requestNumber, expectedRevision: request.revision }));
  request=await bnoc.get('/api/requests/'+saved.requestNumber);
  const original=request.workItems[0];
  success(await bnoc.command('reassignAssignedWork',{teamIds:['유선반']},{requestNumber:request.requestNumber,workNumber:original.workNumber,expectedRevision:original.revision}));
  const notice = success(await bnoc.command('createDirective', { title: '업무 안내', body: '서버 재시작 보존 검증', attachmentRefs: [] }));
  const department='무선반';
  const directory=await bnoc.get('/api/personnel-roster?department='+encodeURIComponent(department));
  const person=success(await bnoc.command('saveCentralPerson',{department,category:'병',rank:'상병',displayName:`재시작 보존 ${randomUUID()}`,serviceNumber:`PERSIST-${randomUUID().replaceAll('-','')}`,internalPhone:'7654',active:true},{expectedRevision:directory.revision}));
  const absenceDate=today.endsWith('-01')?`${today.slice(0,7)}-02`:`${today.slice(0,7)}-01`;
  success(await bnoc.command('saveAbsence',{personRef:person.publicRef,absenceType:'출장',startDate:absenceDate,endDate:absenceDate},{expectedRevision:0}));
  let dutyMonth='',dutyDate='';
  for(let offset=0;offset<13&&!dutyDate;offset++){
    const monthStart=new Date(`${today.slice(0,7)}-01T00:00:00Z`);monthStart.setUTCMonth(monthStart.getUTCMonth()+offset);
    const candidateMonth=monthStart.toISOString().slice(0,7),schedule=await wireless.get(`/api/duty-schedules?month=${candidateMonth}&seat=team_night`);
    const occupied=new Set((schedule.entries??[]).map(entry=>entry.date));
    const days=new Date(Date.UTC(monthStart.getUTCFullYear(),monthStart.getUTCMonth()+1,0)).getUTCDate();
    for(let day=1;day<=days;day++){
      const candidateDate=`${candidateMonth}-${String(day).padStart(2,'0')}`;
      if(candidateDate!==absenceDate&&!occupied.has(candidateDate)){dutyMonth=candidateMonth;dutyDate=candidateDate;break;}
    }
  }
  assert.ok(dutyDate,'DUTY_SCHEDULE_TEST_MUST_USE_AN_UNOCCUPIED_DATE');
  success(await wireless.command('saveDutySchedule',{month:dutyMonth,date:dutyDate,seat:'team_night',personRefs:[person.publicRef]},{expectedRevision:0}));
  const roster=await bnoc.get('/api/personnel-roster?department='+encodeURIComponent(department));
  const dutySchedule=await wireless.get(`/api/duty-schedules?month=${dutyMonth}&seat=team_night`);
  let operationsBefore;
  await providerControl({reset:true});
  const operationsHealthy=await bnoc.get('/api/operations/status');
  assert.equal(operationsHealthy.items.length,14,'OPERATIONS_STATUS_SOURCE_MUST_BE_STORED');
  await providerControl({operations:{scenario:'error'}});
  await pause(1500);
  operationsBefore=await bnoc.get('/api/operations/status');
  assert.equal(operationsBefore.collectionState,'failed','OPERATIONS_SOURCE_FAILURE_MUST_KEEP_STORED_SNAPSHOT');
  const before = { request: await bnoc.get('/api/requests/' + saved.requestNumber), history: await bnoc.get(`/api/requests/${saved.requestNumber}/history`), notice: await bnoc.get('/api/notices/' + notice.publicRef), roster, dutySchedule, planned: plannedBefore };
  try {
    await stopService('verification');
    await startApplication(true);
    await Promise.all([requester.login('requester'), bnoc.login('bnoc'), wireless.login('team-wireless')]);
    const plannedAfter = (await wireless.get(`/api/planned-works?workDate=${today}`)).inProgress.find(item => item.id === planned.id);
    const after = { request: await bnoc.get('/api/requests/' + saved.requestNumber), history: await bnoc.get(`/api/requests/${saved.requestNumber}/history`), notice: await bnoc.get('/api/notices/' + notice.publicRef), roster: await bnoc.get('/api/personnel-roster?department=' + encodeURIComponent(department)), dutySchedule: await wireless.get(`/api/duty-schedules?month=${dutyMonth}&seat=team_night`), planned: plannedAfter };
    assert.deepEqual(after, before, 'REQUEST_WORK_HISTORY_NOTICE_ROSTER_AND_PLANNED_WORK_MUST_SURVIVE_SERVER_RESTART');
    const operationsAfter=await bnoc.get('/api/operations/status');
    assert.deepEqual(operationsAfter.items,operationsBefore.items,'OPERATIONS_STATUS_VALUES_MUST_SURVIVE_SERVER_RESTART_AND_SOURCE_FAILURE');
    assert.equal(operationsAfter.lastSuccess,operationsBefore.lastSuccess,'OPERATIONS_STATUS_LAST_SUCCESS_MUST_SURVIVE_SERVER_RESTART');
    const downloaded = await requester.call('GET', '/api/attachments/' + file.id);
    assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, content, 'ATTACHMENT_BYTES_MUST_SURVIVE_SERVER_RESTART');
    observations.push({ check: 'SERVER_RESTART_PERSISTENCE', requestNumber: saved.requestNumber, plannedWorkId: planned.id, requestWorkHistoryNoticePersonnelAbsenceDutySchedulePlannedWorkUnchanged: true, operationsStatusItemsAndLastSuccessUnchanged: true, attachmentBytesUnchanged: true, attachmentSha256: createHash('sha256').update(downloaded.bytes).digest('hex') });
  } finally { await providerControl({reset:true}); }
}

async function eligibility() {
  const [requester,bnoc,team]=await Promise.all(['requester','bnoc','team-wireless'].map(subject=>new Client().login(subject)));
  const directory=await bnoc.get('/api/personnel-roster');
  const person=success(await bnoc.command('saveCentralPerson',{department:'무선반',category:'병',rank:'상병',displayName:`잠금 검증 ${randomUUID()}`,serviceNumber:`LOCK-${randomUUID()}`,active:true},{expectedRevision:directory.revision}));
  const ref=person.publicRef,year=6000+parseInt(randomUUID().slice(0,4),16)%3000,month=`${year}-01`,day=`${month}-10`;
  const saved=success(await requester.command('createRequest',input()));
  let detail=await bnoc.get('/api/requests/'+saved.requestNumber);
  success(await bnoc.command('assignTeams',{teamIds:['무선반'],priority:'general'},{requestNumber:saved.requestNumber,expectedRevision:detail.revision}));
  detail=await team.get('/api/requests/'+saved.requestNumber);const work=detail.workItems[0];
  const absenceRef=randomUUID(),at=new Date().toISOString();
  const unlock=await holdSQL(`INSERT INTO bnoc_resource_locks(resource_key) VALUES ('personnel-directory') ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key); SELECT resource_key FROM bnoc_resource_locks WHERE resource_key='personnel-directory' FOR UPDATE; INSERT INTO bnoc_absences(absence_ref,person_ref,absence_type,starts_on,ends_on,revision,recorded_by,recorded_at,updated_at) VALUES ('${absenceRef}','${ref}','휴가','${day}','${day}',1,'bnoc','${at}','${at}');`);
  let dutyDone=false,workDone=false;
  const duty=team.command('saveDutySchedule',{month,date:day,seat:'team_night',personRefs:[ref]},{expectedRevision:0}).then(result=>{dutyDone=true;return result;});
  const assignment=team.command('updateWork',{nextStatus:'배정',assignedPersonRefs:[ref],scheduleIntervals:[{startsAt:`${day}T01:00:00Z`,endsAt:`${day}T02:00:00Z`}]},{requestNumber:saved.requestNumber,workNumber:work.workNumber,expectedRevision:work.revision}).then(result=>{workDone=true;return result;});
  try {
    await pause(400);
    assert.equal(dutyDone,false,'DUTY_VALIDATION_MUST_WAIT_FOR_PERSONNEL_COMMIT');
    assert.equal(workDone,false,'WORK_VALIDATION_MUST_WAIT_FOR_PERSONNEL_COMMIT');
    await unlock();
    const results=await Promise.all([duty,assignment]);
    for(const result of results){assert.equal(result.status,400,'COMMITTED_ABSENCE_MUST_BLOCK_NEW_SELECTION');assert.equal(result.json.code,'VALIDATION');}
    observations.push({check:'SHARED_PERSONNEL_LOCK_RECHECKS_ABSENCE_AFTER_COMMIT',dutyWaited:true,workWaited:true,httpStatuses:results.map(result=>result.status),personRef:ref});
  } finally {await unlock();await Promise.allSettled([duty,assignment]);}
}

let status = 'failed', error = null;
try { await ({ concurrency, rollback, persistence,eligibility })[mode](); status = process.argv.includes('--expect-stale') ? 'reproduced' : 'passed'; }
catch (failure) { error = failure.message; process.exitCode = 1; }
const jar = await readFile(join(root, 'backend/build/libs/bnoc-server-1.0.0.jar'));
const service = JSON.parse(await readFile(join(runtimeRoot, 'services.json'), 'utf8')).verification;
const filename = `${mode}-${process.argv.includes('--expect-stale') ? 'before-fix' : 'final'}-${Date.now()}.json`;
await writeFile(join(evidence, filename), JSON.stringify({ kind: 'real-mysql-storage-check', mode, status, error, observations, runningPid: service?.pid, runningJarSha256: service?.artifactSha256 ?? null, onDiskJarSha256: createHash('sha256').update(jar).digest('hex'), recordedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(JSON.stringify({ status, evidence: filename, observations, error }, null, 2));
