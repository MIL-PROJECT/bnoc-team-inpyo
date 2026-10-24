import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const evidenceRoot = resolve(process.env.BNOC_TEST_EVIDENCE_DIR ?? join(root, 'runtime/evidence/backend-implementation-20261013'));
mkdirSync(evidenceRoot, { recursive: true });
const output = mkdtempSync(join(evidenceRoot, 'server-sensitivity-'));
const temporary = mkdtempSync(join(tmpdir(), 'bnoc-server-sensitivity-'));
const gradle = process.env.BNOC_GRADLE ?? join(root, '.local/dependencies/gradle-9.3.0/bin/gradle');
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceFiles = [...files(join(root, 'backend/src')), ...files(join(root, 'frontend/src')), join(root, 'backend/build.gradle.kts'), join(root, 'backend/settings.gradle.kts')];
const hashes = () => Object.fromEntries(sourceFiles.map(path => [relative(root, path), hash(path)]));
const before = hashes();
const startedAt = new Date().toISOString();
const results = [];
const mutations = [
  {
    name: 'backend-direct-reassignment-status', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/WorkflowService.kt',
    anchor: 'old.status!=requiredStatus', injected: '(old.status!=requiredStatus && !(direct && old.status=="완료"))',
    assertion: 'DIRECT_REASSIGNMENT_ASSIGNED_ONLY'
  },
  {
    name: 'backend-assignment-schedule', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/WorkflowService.kt',
    anchor: 'WorkRecord("${request.number}-${index+1}",request.number,team,assignedAt=at)',
    injected: 'WorkRecord("${request.number}-${index+1}",request.number,team,scheduleIntervals=listOf(WorkScheduleInterval(at,at)),assignedAt=at)',
    assertion: 'BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE'
  },
  {
    name: 'backend-unclassified-assignment', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/WorkflowService.kt',
    anchor: 'val teams=teamIds(payload);val priority=payload["priority"] as? String\n        if(priority !in listOf("general","urgent"))',
    injected: 'val teams=teamIds(payload);val priority=payload["priority"] as? String\n        if(false)',
    assertion: 'ASSIGNMENT_CLASSIFICATION_REQUIRED'
  },
  {
    name: 'backend-withdrawn-work-discoverability', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/QueryService.kt',
    anchor: 'all.none { it.requestNumber==r.number && it.origin=="assigned" && it.resolutionKind=="open" }',
    injected: 'all.none { it.requestNumber==r.number }',
    assertion: 'WITHDRAWN_REQUEST_MUST_REMAIN_VISIBLE_AS_UNASSIGNED', suite: 'bnoc.OperationsContractTest'
  },
  {
    name: 'backend-reassignment-current-department-duplication', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/WorkflowService.kt',
    anchor: 'if(teams.any { it in currentTeams }) reject("VALIDATION",mapOf("teamIds" to "이미 담당 중인 작업반으로 재배정할 수 없습니다."))',
    injected: 'if(direct && teams.any { it in currentTeams }) reject("VALIDATION",mapOf("teamIds" to "이미 담당 중인 작업반으로 재배정할 수 없습니다."))',
    assertion: 'REASSIGNMENT_MUST_NOT_DUPLICATE_A_CURRENT_DEPARTMENT'
  },
  {
    name: 'backend-planned-team-role', kind: 'planned', file: 'backend/src/main/kotlin/bnoc/PlannedWorkService.kt',
    anchor: 'if(actor.role!="team" || actor.teamId.isNullOrBlank()) reject("FORBIDDEN")',
    injected: '', assertion: 'PLANNED_WORK_TEAM_ROLE_REQUIRED'
  },
  {
    name: 'backend-planned-completion-start-date', kind: 'planned', file: 'backend/src/main/kotlin/bnoc/PlannedWorkService.kt',
    anchor: 'if(parsed.isBefore(date(first,"firstWorkDate")) || parsed.isAfter(today())) reject("VALIDATION",mapOf("completedDate" to "완료일은 업무 기준일 이후, 오늘 이하로 선택하세요."))',
    injected: 'if(parsed.isAfter(today())) reject("VALIDATION",mapOf("completedDate" to "완료일은 오늘 이하로 선택하세요."))', assertion: 'PLANNED_COMPLETION_NOT_BEFORE_START'
  },
  {
    name: 'backend-planned-hard-delete', kind: 'planned', file: 'backend/src/main/kotlin/bnoc/PlannedWorkService.kt',
    anchor: 'val removed=db.jdbc.update("DELETE FROM bnoc_planned_works WHERE planned_work_id=? AND revision=?",work.id,revision)',
    injected: 'val removed=1', assertion: 'PLANNED_DELETE_MUST_REMOVE_TASK'
  },
  {
    name: 'backend-planned-global-operation-id', kind: 'planned', file: 'backend/src/main/kotlin/bnoc/PlannedWorkService.kt',
    anchor: 'if(!globallyInserted) reject("OPERATION_NOT_AVAILABLE")',
    injected: 'if(false) reject("OPERATION_NOT_AVAILABLE")', assertion: 'PLANNED_OPERATION_ID_MUST_BE_GLOBAL'
  },
  {
    name: 'backend-planned-replay-team-ownership', kind: 'planned', file: 'backend/src/main/kotlin/bnoc/PlannedWorkService.kt',
    anchor: 'if(row["team_id"]!=actor.teamId) reject("OPERATION_NOT_AVAILABLE")',
    injected: 'if(false) reject("OPERATION_NOT_AVAILABLE")', assertion: 'PLANNED_REPLAY_MUST_MATCH_CURRENT_TEAM'
  },
  {
    name: 'backend-public-login-location', kind: 'auth', file: 'backend/src/main/kotlin/bnoc/AuthService.kt',
    anchor: '"providerUrl" to "$origin/identity?loginAttempt=',
    injected: '"providerUrl" to "$providerUrl/identity?loginAttempt=',
    assertion: 'BNOC_IDENTITY_MUST_USE_SERVICE_ORIGIN'
  },
  {
    name: 'backend-public-raw-boundary', kind: 'proxy', file: 'backend/src/main/kotlin/bnoc/PublicIdentityController.kt',
    anchor: 'val path=helper.removeSemicolonContent(helper.getPathWithinApplication(request))',
    injected: 'val path=request.requestURI',
    assertion: 'BNOC_IDENTITY_RAW_BOUNDARY_MUST_BE_REJECTED'
  },
  {
    name: 'backend-meeting-form-content-privacy', kind: 'backend', file: 'backend/src/main/kotlin/bnoc/WorkflowService.kt',
    anchor: 'if(excluded) ids.forEach { db.jdbc.update("UPDATE bnoc_attachments SET content_analysis_excluded=TRUE WHERE attachment_ref=?",it) }',
    injected: 'if(false && excluded) ids.forEach { db.jdbc.update("UPDATE bnoc_attachments SET content_analysis_excluded=TRUE WHERE attachment_ref=?",it) }',
    assertion: 'MEETING_SUPPORT_ATTACHMENT_CONTENT_MUST_STAY_EXCLUDED', suite: 'bnoc.DocumentAnalysisContractTest'
  },
  {
    name: 'frontend-login-origin', kind: 'frontend', file: 'frontend/src/api/loginProof.mjs',
    anchor: 'event.origin === origin && ', injected: '', assertion: 'LOGIN_PROVIDER_ORIGIN_REQUIRED'
  },
  {
    name: 'frontend-after-action-completion', kind: 'frontend', file: 'frontend/src/api/requestPayload.mjs',
    anchor: 'completedConfirmed: actual.done, ', injected: '', assertion: 'AFTER_ACTION_COMPLETED_CONFIRMATION_REQUIRED'
  }
];

function copy(label) {
  const directory = join(temporary, label);
  mkdirSync(directory);
  cpSync(join(root, 'backend'), join(directory, 'backend'), { recursive: true, filter: path => !['build', '.gradle'].includes(relative(join(root, 'backend'), path).split('/')[0]) });
  cpSync(join(root, 'mock-provider'), join(directory, 'mock-provider'), { recursive: true });
  cpSync(join(root, 'frontend/src'), join(directory, 'frontend/src'), { recursive: true });
  symlinkSync(join(root, 'frontend/node_modules'), join(directory, 'frontend/node_modules'), 'dir');
  return directory;
}

function run(label, kind, directory, assertion = null, suiteOverride = null) {
  const start = performance.now();
  const serverTest = kind !== 'frontend';
  const suite = suiteOverride ?? { backend: 'bnoc.WorkflowContractTest', planned: 'bnoc.PlannedWorkContractTest', auth: 'bnoc.ExternalBoundaryTest', proxy: 'bnoc.PublicIdentityProxyTest' }[kind];
  const command = serverTest ? gradle : process.execPath;
  const args = serverTest
    ? ['-p', 'backend', 'test', '--tests', suite, '--offline', '--no-daemon']
    : ['--test', '--test-reporter=spec', ...files(join(directory, 'frontend/src')).filter(path => path.endsWith('.test.mjs'))];
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 180000, env: { ...process.env, GRADLE_USER_HOME: join(root, '.local/gradle') } });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.signal, null, `${label}: terminated`);
  let tests, passed, failed, diagnostic = log;
  if (serverTest) {
    const xmlPath = join(directory, `backend/build/test-results/test/TEST-${suite}.xml`);
    assert.ok(existsSync(xmlPath), `${label}: missing executed test report`);
    diagnostic = readFileSync(xmlPath, 'utf8');
    writeFileSync(join(output, label + '.xml'), diagnostic);
    tests = Number(diagnostic.match(/<testsuite[^>]*\btests="(\d+)"/)?.[1]);
    failed = Number(diagnostic.match(/<testsuite[^>]*\bfailures="(\d+)"/)?.[1]);
    assert.equal(Number(diagnostic.match(/<testsuite[^>]*\bskipped="(\d+)"/)?.[1]), 0);
    assert.equal(Number(diagnostic.match(/<testsuite[^>]*\berrors="(\d+)"/)?.[1]), 0);
    assert.ok(tests >= 5, `${label}: selected server contract tests must execute`);
    passed = tests - failed;
  } else {
    const count = key => Number(log.match(new RegExp(`^.*?\\b${key} (\\d+)\\s*$`, 'm'))?.[1]);
    tests = count('tests'); passed = count('pass'); failed = count('fail');
    assert.ok(tests > 0 && passed + failed === tests);
    assert.equal(count('cancelled') + count('skipped') + count('todo'), 0);
  }
  if (assertion) {
    const baseline = results.find(result => result.suite === suite && result.assertion === null);
    assert.ok(baseline, `${label}: selected suite has a normal baseline`);
    assert.equal(tests, baseline.tests, `${label}: test count changed between copies`);
    assert.notEqual(result.status, 0, `${label}: incorrect code passed`);
    assert.equal(failed, 1, `${label}: selected defect must cause one assertion failure`);
    assert.ok(diagnostic.includes(assertion), `${label}: intended assertion did not fail`);
    assert.doesNotMatch(diagnostic, /SyntaxError|ERR_MODULE_NOT_FOUND|Compilation failed|OutOfMemoryError/);
    if (serverTest) assert.match(diagnostic, /type="org\.opentest4j\.AssertionFailedError"/);
  } else {
    assert.equal(result.status, 0, `${label}: normal copy failed`);
    assert.equal(passed, tests);
  }
  results.push({ label, kind, assertion, exitCode: result.status, tests, passed, failed, elapsedMs: Math.round(performance.now() - start), log: label + '.log', ...(serverTest ? { xml: label + '.xml', suite } : {}) });
}

let status = 'failed', failure = null;
let selectedMutationSpecs = [];
try {
  const meetingPrivacyOnly = process.argv.includes('--meeting-form-privacy-only');
  const assignmentScheduleOnly = process.argv.includes('--assignment-schedule-only');
  const normal = copy('normal');
  if (meetingPrivacyOnly) run('normal-document-analysis', 'backend', normal, null, 'bnoc.DocumentAnalysisContractTest');
  else if (assignmentScheduleOnly) run('normal-backend', 'backend', normal, null, 'bnoc.WorkflowContractTest');
  else {
    run('normal-backend', 'backend', normal);
    run('normal-planned', 'planned', normal);
    run('normal-operations', 'backend', normal, null, 'bnoc.OperationsContractTest');
    run('normal-document-analysis', 'backend', normal, null, 'bnoc.DocumentAnalysisContractTest');
    run('normal-auth', 'auth', normal);
    run('normal-proxy', 'proxy', normal);
    run('normal-frontend', 'frontend', normal);
  }
  const selectedMutations = meetingPrivacyOnly ? mutations.filter(item => item.name === 'backend-meeting-form-content-privacy')
    : assignmentScheduleOnly ? mutations.filter(item => item.name === 'backend-assignment-schedule') : mutations;
  selectedMutationSpecs = selectedMutations;
  for (const mutation of selectedMutations) {
    const directory = copy(mutation.name);
    const path = join(directory, mutation.file);
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(mutation.anchor).length, 2, `${mutation.name}: mutation requires one target`);
    const changed = original.replace(mutation.anchor, mutation.injected);
    writeFileSync(path, changed);
    const diff = spawnSync('diff', ['-u', '--label', 'original/' + mutation.file, '--label', mutation.name + '/' + mutation.file, join(root, mutation.file), path], { encoding: 'utf8' });
    assert.equal(diff.status, 1, `${mutation.name}: mutation diff missing`);
    writeFileSync(join(output, mutation.name + '.patch'), diff.stdout);
    mutation.sourceSha256 = hash(join(root, mutation.file));
    mutation.mutatedSha256 = hash(path);
    run(mutation.name, mutation.kind, directory, mutation.assertion, mutation.suite ?? null);
  }
  status = 'passed';
} catch (error) {
  failure = error.message;
  process.exitCode = 1;
} finally {
  const unchanged = JSON.stringify(hashes()) === JSON.stringify(before);
  rmSync(temporary, { recursive: true, force: true });
  const cleaned = !existsSync(temporary);
  if (!unchanged || !cleaned) { status = 'failed'; failure = 'Original source changed or temporary source remains.'; process.exitCode = 1; }
  const summary = { kind: 'isolated-error-sensitivity', status, startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version, runnerSha256: hash(new URL(import.meta.url)), results, selectedMutationCount: selectedMutationSpecs.length, mutations: selectedMutationSpecs, sourceHashes: before, originalSourceUnchanged: unchanged, temporarySourceRemoved: cleaned, failure, limitations: [`${selectedMutationSpecs.length} selected artificial defects; no general error-prevention or productivity claim.`, 'Real HTTP/MySQL and browser acceptance are separate checks.'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ status, output: relative(root, output), results, failure }, null, 2));
}
