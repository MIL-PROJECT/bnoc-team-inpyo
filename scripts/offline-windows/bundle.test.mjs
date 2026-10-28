import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCdBundle, verifyCdBundle } from './bundle.mjs';

const publicFiles = [
  ['START-DEMO.cmd', 'launcher'],
  ['STOP-DEMO.cmd', 'stopper'],
  ['launcher.ps1', 'powershell'],
  ['THIRD-PARTY-NOTICES.txt', 'notices'],
  ['USER-GUIDE.txt', 'guide']
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bnoc-offline-bundle-'));
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  const make = async (name, content) => {
    const path = join(sourceRoot, name);
    await writeFile(path, content);
    return path;
  };
  const artifacts = [
    { role: 'application', path: 'runtime/bnoc-server.jar', source: await make('app.jar', 'jar bytes') },
    { role: 'provider', path: 'runtime/mock-provider/server.mjs', source: await make('server.mjs', 'provider source') },
    { role: 'mysql', path: 'runtime/mysql.zip', source: await make('mysql.zip', 'mysql archive') },
    { role: 'node', path: 'runtime/node.zip', source: await make('node.zip', 'node archive') },
    { role: 'java', path: 'runtime/java.zip', source: await make('java.zip', 'java archive') },
    { role: 'vcRuntime', path: 'runtime/vc_redist.x64.exe', source: await make('vc_redist.x64.exe', 'redistributable installer') }
  ];
  const support = await Promise.all(publicFiles.map(async ([path, name]) => ({
    path,
    source: await make(name, name === 'guide' ? 'STOP-DEMO.cmd PC방' : `${name} content`),
    role: 'support'
  })));
  const dependencies = {
    application: { path: 'runtime/bnoc-server.jar', version: '1.0.0' },
    mysql: { path: 'runtime/mysql.zip', version: '8.4.11', archive: 'mysql-8.4.11-winx64.zip' },
    node: { path: 'runtime/node.zip', version: '22.18.0', archive: 'node-v22.18.0-win-x64.zip' },
    java: { path: 'runtime/java.zip', version: '17.0.20.1+1', archive: 'OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip' },
    vcRuntime: { path: 'runtime/vc_redist.x64.exe', version: '14.50.35719.0', archive: 'vc_redist.x64.exe' }
  };
  return {
    root,
    sourceRoot,
    artifacts,
    publicFiles: support,
    dependencies,
    application: { path: 'runtime/bnoc-server.jar', version: '1.0.0' }
  };
}

test('offline bundle is versioned, complete, and verifies every shipped file', async t => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await createCdBundle({ outputRoot: join(data.root, 'output'), ...data });
  assert.match(result.manifest.releaseId, /^bnoc-win-x64-[a-f0-9]{16}$/);
  assert.equal(result.manifest.target.platform, 'win32');
  assert.equal(result.manifest.target.architecture, 'x64');
  assert.equal(result.manifest.files.length, 11);
  assert.equal(await verifyCdBundle(result.destination), true);
  assert.equal((await readFile(join(result.destination, 'bundle-manifest.json'), 'utf8')).includes('mysql-8.4.11-winx64.zip'), true);
  assert.match(await readFile(join(result.destination, 'USER-GUIDE.txt'), 'utf8'), /STOP-DEMO\.cmd/);
  assert.match(await readFile(join(result.destination, 'USER-GUIDE.txt'), 'utf8'), /PC방/);
});

test('offline bundle refuses overwrite and detects changed payload bytes', async t => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const outputRoot = join(data.root, 'output');
  const first = await createCdBundle({ outputRoot, ...data });
  await assert.rejects(createCdBundle({ outputRoot, ...data }), /refusing to overwrite/);
  await writeFile(join(first.destination, 'runtime/mysql.zip'), 'changed bytes');
  await assert.rejects(verifyCdBundle(first.destination), /integrity check failed/);
});

test('offline bundle rejects incomplete runtime inputs and path traversal', async t => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await assert.rejects(createCdBundle({ outputRoot: join(data.root, 'missing'), ...data, dependencies: { ...data.dependencies, java: undefined } }), /Required java artifact/);
  await assert.rejects(createCdBundle({ outputRoot: join(data.root, 'missing-vc'), ...data, dependencies: { ...data.dependencies, vcRuntime: undefined } }), /Required vcRuntime artifact/);
  const artifacts = data.artifacts.map(item => item.path === 'runtime/mysql.zip' ? { ...item, path: '../mysql.zip' } : item);
  await assert.rejects(createCdBundle({ outputRoot: join(data.root, 'traversal'), ...data, artifacts }), /Invalid bundle path/);
});
