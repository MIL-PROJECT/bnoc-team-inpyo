import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { dependencyFiles, fingerprint, validateMounts, isServerPath } from './development.mjs';
import { sourceFingerprint, watchSources, stopChild } from './development-backend.mjs';
import { configuration, composeArguments } from '../scripts/bnoc-team.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bnoc-development-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [...dependencyFiles, 'frontend/src/view.tsx', 'backend/src/main/kotlin/App.kt', 'mock-provider/server.mjs']) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), 'initial');
  }
  await mkdir(join(root, 'docker'));
  await mkdir(join(root, 'design'));
  return root;
}
test('ordinary source edits do not require a toolchain rebuild; dependency edits do', async t => {
  const root = await fixture(t), initial = await fingerprint(root), backend = await sourceFingerprint(root);
  await writeFile(join(root, 'frontend/src/view.tsx'), 'view changed');
  await writeFile(join(root, 'backend/src/main/kotlin/App.kt'), 'backend changed');
  assert.equal(await fingerprint(root), initial);
  assert.notEqual(await sourceFingerprint(root), backend);
  await writeFile(join(root, 'frontend/pnpm-lock.yaml'), 'dependency changed');
  assert.notEqual(await fingerprint(root), initial);
});
test('development source mounts reject local credential files', async t => {
  const root = await fixture(t);
  await validateMounts(root);
  await writeFile(join(root, 'frontend/.env.local'), 'PRIVATE=placeholder');
  await assert.rejects(validateMounts(root), /Private local input/);
});
test('development mounts reject nested credentials and symbolic links', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'frontend/src/private.pem'), 'placeholder');
  await assert.rejects(validateMounts(root), /Private local input/);
  await rm(join(root, 'frontend/src/private.pem'));
  await symlink(join(root, 'backend/src'), join(root, 'frontend/src/linked'), 'junction');
  await assert.rejects(validateMounts(root), /symbolic links/);
});
test('same-origin server proxy includes encoded provider aliases without exposing source routes', () => {
  for (const path of ['/api/session', '/identity', '/identity/verify', '/%69dentity/verify', '/identity%2fverify', '/control', '/feeds/gps', '/IDENTITY', '/identity;v=1/verify']) assert.equal(isServerPath(path), true, path);
  for (const path of ['/', '/requests/101', '/src/app/App.tsx', '/@vite/client', '/node_modules/.vite/react.js']) assert.equal(isServerPath(path), false, path);
});
test('watcher recovers after failed compile and includes edits made during compile', async () => {
  let version = 'first'; const applied = [], controller = new AbortController();
  await watchSources(async () => version, async () => {
    applied.push(version);
    if (applied.length === 1) version = 'fixed';
    else controller.abort();
    return false;
  }, controller.signal, 1);
  assert.deepEqual(applied, ['first', 'fixed']);
});
test('managed JVM can be terminated before replacement without leaving the old process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await new Promise(accept => child.once('spawn', accept));
  await stopChild(child, 1000);
  assert.notEqual(child.signalCode, null);
});
test('editing environment overrides apply to development only', () => {
  const dev = configuration('up', '/tmp/check-out', {}), verify = configuration('verify', '/tmp/check-out', {});
  assert.equal(dev.env.BNOC_TEAM_TARGET, 'development');
  assert.ok(composeArguments(dev, ['up']).some(path => basename(path) === 'compose.dev.yaml'));
  assert.ok(!composeArguments(verify, ['up']).some(path => basename(path) === 'compose.dev.yaml'));
});
