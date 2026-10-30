import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { applicationConfiguration, assertNativePortOwnership, nativeServiceReady } from './bnoc-runtime.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bnoc-runtime-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'backend/build/libs/bnoc-server-1.0.0.jar');
  await mkdir(join(directory, 'backend/build/libs'), { recursive: true });
  await writeFile(source, 'build A');
  return { directory, source };
}

test('running artifact stays unchanged when a later build replaces its source', async t => {
  const { directory, source } = await fixture(t);
  const first = await applicationConfiguration(true, directory);
  await writeFile(source, 'build B');
  assert.equal((await readFile(first.jar)).toString(), 'build A', 'RUNNING_ARTIFACT_MUST_NOT_CHANGE_WITH_BUILD');
  const second = await applicationConfiguration(true, directory);
  assert.notEqual(first.jar, second.jar);
  assert.notEqual(first.artifactSha256, second.artifactSha256);
  assert.equal((await readFile(second.jar)).toString(), 'build B');
});

test('native configuration selects packaged frontend rather than a mutable development dist', async t => {
  const { directory } = await fixture(t);
  const configuration = await applicationConfiguration(true, directory);
  assert.notEqual(configuration.frontendRoot, join(directory, 'frontend/dist'), 'RUNNING_FRONTEND_MUST_MATCH_FROZEN_JAR');
  assert.equal(configuration.frontendRoot, join(directory, '.local/bnoc-runtime/jar-frontend'));
});

test('application and verification identify their own port even with the same artifact', async t => {
  const { directory } = await fixture(t);
  const app = await applicationConfiguration(false, directory), verify = await applicationConfiguration(true, directory);
  assert.equal(app.name, 'application'); assert.equal(verify.name, 'verification');
  assert.equal(app.artifactSha256, verify.artifactSha256);
  assert.notEqual(app.signature, verify.signature, 'PROCESS_SIGNATURE_MUST_DISTINGUISH_ROLES');
  for (const entry of [app, verify]) {
    assert.deepEqual(entry.args, ['-jar', entry.jar, `--server.port=${entry.port}`]);
    assert.equal(entry.signature, `${entry.jar} --server.port=${entry.port}`);
  }
});

test('an unchanged build reuses the same artifact and launch configuration', async t => {
  const { directory } = await fixture(t);
  assert.deepEqual(await applicationConfiguration(true, directory), await applicationConfiguration(true, directory));
});

test('missing build is rejected before selecting a runnable artifact', async t => {
  const { directory, source } = await fixture(t); await rm(source);
  await assert.rejects(applicationConfiguration(true, directory), /Application JAR missing/);
});

test('a corrupted retained artifact is rejected rather than replaced or run', async t => {
  const { directory, source } = await fixture(t);
  const retained = await applicationConfiguration(true, directory);
  await writeFile(retained.jar, 'corrupted retained bytes');
  await writeFile(source, 'build A');
  await assert.rejects(applicationConfiguration(true, directory), /does not match its SHA/, 'CORRUPTED_RETAINED_ARTIFACT_MUST_NOT_RUN');
});

test('legacy process ownership requires its actual listening port and preserves a different role', { timeout: 10000 }, async t => {
  async function listener() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', "import {createServer} from 'node:net';const server=createServer();server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)));"], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } });
    const [value] = await once(child.stdout, 'data');
    return { pid: child.pid, port: Number(value.toString()) };
  }
  const own = await listener(), other = await listener();
  assertNativePortOwnership(own, own.port);
  assert.throws(() => assertNativePortOwnership(own, other.port), /existing process preserved/, 'OTHER_ROLE_PROCESS_MUST_NOT_BE_ACCEPTED');
  assertNativePortOwnership(own, own.port);
  assertNativePortOwnership(other, other.port);
});

test('simultaneous application and verification retention publishes only a complete shared artifact', async t => {
  const { directory, source } = await fixture(t);
  const bytes = Buffer.alloc(16 * 1024 * 1024, 97); await writeFile(source, bytes);
  const entries = await Promise.all(Array.from({ length: 8 }, (_, index) => applicationConfiguration(index % 2 === 0, directory)));
  assert.ok(entries.every(entry => entry.jar === entries[0].jar && entry.artifactSha256 === entries[0].artifactSha256), 'SAME_SHA_CONCURRENT_RETENTION_MUST_SUCCEED');
  assert.deepEqual(await readFile(entries[0].jar), bytes);
  assert.deepEqual(await readdir(join(directory, '.local/bnoc-runtime/artifacts')), [entries[0].artifactSha256 + '.jar']);
});

async function readinessProcess(t, listening = true, status = 401) {
  const signature = 'bnoc-readiness-' + randomUUID();
  const script = `import {createServer} from 'node:http';
    let status=Number(process.env.BNOC_READINESS_STATUS);
    function listen(port=0){const server=createServer((request,response)=>{response.writeHead(status);response.end();});server.listen(port,'127.0.0.1',()=>process.send({port:server.address().port}));}
    process.on('message',message=>{if(message.listen)listen(message.port);else{status=message.status;process.send({status});}});
    if(process.env.BNOC_READINESS_LISTEN==='yes')listen();else process.send({idle:true});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, signature], {
    env: { ...process.env, BNOC_READINESS_LISTEN: listening ? 'yes' : 'no', BNOC_READINESS_STATUS: String(status) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
  });
  const [ready] = await once(child, 'message');
  return { child, entry: { pid: child.pid, signature }, port: ready.port };
}

test('native readiness accepts its own listener with the existing HTTP200/401 statuses', { timeout: 10000 }, async t => {
  const own = await readinessProcess(t);
  const url = `http://127.0.0.1:${own.port}/api/session`;
  assert.equal(await nativeServiceReady(own.entry, own.port, url), true);
  const changed = once(own.child, 'message'); own.child.send({ status: 200 }); await changed;
  assert.equal(await nativeServiceReady(own.entry, own.port, url), true);
});

for (const [name, status, path] of [['application', 401, '/api/session'], ['provider', 200, '/health']]) {
  test(`native readiness rejects a different ${name} responder while its own process is not bound`, { timeout: 10000 }, async t => {
    const other = await readinessProcess(t, true, status), own = await readinessProcess(t, false);
    await assert.rejects(nativeServiceReady(own.entry, other.port, `http://127.0.0.1:${other.port}${path}`), /belongs to another process/, 'READINESS_MUST_BELONG_TO_OWN_PROCESS');
    assert.equal(await nativeServiceReady(other.entry, other.port, `http://127.0.0.1:${other.port}${path}`), true, 'OTHER_LISTENER_MUST_BE_PRESERVED');
  });
}

test('native readiness rejects its process listening on a different port from the responder', { timeout: 10000 }, async t => {
  const other = await readinessProcess(t), own = await readinessProcess(t);
  await assert.rejects(nativeServiceReady(own.entry, other.port, `http://127.0.0.1:${other.port}/api/session`), /belongs to another process/, 'READINESS_MUST_BELONG_TO_OWN_PROCESS');
  assert.equal(await nativeServiceReady(own.entry, own.port, `http://127.0.0.1:${own.port}/api/session`), true);
});

test('native readiness waits through an unbound port and later accepts its own binding', { timeout: 10000 }, async t => {
  const own = await readinessProcess(t, false), reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}/api/session`;
  assert.equal(await nativeServiceReady(own.entry, port, url), false);
  const bound = once(own.child, 'message'); own.child.send({ listen: true, port }); await bound;
  assert.equal(await nativeServiceReady(own.entry, port, url), true);
});

test('native readiness stops on an exited or mismatched process instead of trusting a live responder', { timeout: 10000 }, async t => {
  const other = await readinessProcess(t), own = await readinessProcess(t, false);
  const url = `http://127.0.0.1:${other.port}/api/session`;
  await assert.rejects(nativeServiceReady({ ...other.entry, signature: 'wrong-' + randomUUID() }, other.port, url), /exited or no longer matches/, 'MISMATCHED_PROCESS_MUST_NOT_BE_READY');
  const ended = once(own.child, 'exit'); own.child.kill('SIGTERM'); await ended;
  await assert.rejects(nativeServiceReady(own.entry, other.port, url), /exited or no longer matches/, 'EXITED_PROCESS_MUST_NOT_BE_READY');
});

test('native readiness keeps HTTP failure separate from port ownership', { timeout: 10000 }, async t => {
  const own = await readinessProcess(t, true, 500);
  assert.equal(await nativeServiceReady(own.entry, own.port, `http://127.0.0.1:${own.port}/api/session`), false);
  assertNativePortOwnership(own.entry, own.port);
});

test('native readiness reports unavailable process ownership checks', { timeout: 10000 }, async t => {
  const own = await readinessProcess(t);
  const script = `import assert from 'node:assert/strict';import {nativeServiceReady} from ${JSON.stringify(new URL('./bnoc-runtime.mjs', import.meta.url).href)};await assert.rejects(nativeServiceReady(${JSON.stringify(own.entry)},${own.port},'http://127.0.0.1:${own.port}/api/session'),/Process ownership cannot be checked/,'UNVERIFIABLE_PROCESS_MUST_NOT_BE_READY');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: '' } });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, errors);
});
