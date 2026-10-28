import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCdBundle, verifyCdBundle } from './bundle.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cacheRoot = join(root, '.local/offline-windows/cache');
const outputRoot = join(root, '.local/offline-windows/cd-packages');
const jarPath = join(root, 'backend/build/libs/bnoc-server-1.0.0.jar');
const timeout = AbortSignal.timeout(15 * 60 * 1000);

const runtimeArtifacts = [
  {
    name: 'mysql', version: '8.4.11', archive: 'mysql-8.4.11-winx64.zip',
    url: 'https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip',
    checksumUrl: 'https://cdn.mysql.com//Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip.md5', checksum: 'md5',
    path: 'runtime/mysql-8.4.11-winx64.zip', license: 'GPL-2.0'
  },
  {
    name: 'node', version: '22.18.0', archive: 'node-v22.18.0-win-x64.zip',
    url: 'https://nodejs.org/dist/v22.18.0/node-v22.18.0-win-x64.zip',
    checksum: 'sha256', expected: 'c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511',
    path: 'runtime/node-v22.18.0-win-x64.zip', license: 'MIT'
  },
  {
    name: 'java', version: '17.0.20.1+1', archive: 'OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip',
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip',
    checksum: 'sha256', expected: 'bc21a93923103cdaac93ee337b0ae4365e739fde36df823dd456bc67c8a9d352',
    path: 'runtime/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip', license: 'GPL-2.0-with-Classpath-exception'
  },
  {
    name: 'vcRuntime', version: '14.50.35719.0', archive: 'vc_redist.x64.exe',
    url: 'https://aka.ms/vc14/vc_redist.x64.exe',
    checksum: 'sha256', expected: '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c',
    path: 'runtime/vc_redist.x64.exe', license: 'Microsoft Visual C++ Redistributable'
  }
];

const sha256File = path => digestFile(path, 'sha256');
function digestFile(path, algorithm) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveDigest(hash.digest('hex')));
  });
}
async function fetchText(url) {
  const response = await fetch(url, { signal: timeout, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response.text();
}
async function publishedChecksum(artifact) {
  if (artifact.expected) return artifact.expected;
  const text = await fetchText(artifact.checksumUrl);
  const match = text.match(new RegExp(`^([a-f0-9]{${artifact.checksum === 'md5' ? 32 : 64}})\\s+${artifact.archive.replaceAll('.', '\\.')}\\s*$`, 'im'));
  if (!match) throw new Error(`Official checksum not found for ${artifact.archive}.`);
  return match[1].toLowerCase();
}
async function downloadArtifact(artifact) {
  await mkdir(cacheRoot, { recursive: true });
  const destination = join(cacheRoot, artifact.archive);
  const algorithm = artifact.checksum;
  const expected = await publishedChecksum(artifact);
  if (await access(destination).then(() => true, () => false)) {
    if (await digestFile(destination, algorithm) !== expected) throw new Error(`Cached runtime checksum mismatch: ${destination}`);
    return destination;
  }
  const partial = `${destination}.${process.pid}.part`;
  try {
    const response = await fetch(artifact.url, { signal: timeout, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${artifact.url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    const actual = await digestFile(partial, algorithm);
    if (actual !== expected) throw new Error(`Downloaded runtime checksum mismatch: ${artifact.archive}`);
    await rename(partial, destination);
    return destination;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or later on the connected package-building PC.');
  const jarInfo = await stat(jarPath).catch(() => null);
  if (!jarInfo?.isFile()) throw new Error('BNOC JAR is missing. Run npm run server:build first.');
  const runtimePaths = new Map();
  for (const artifact of runtimeArtifacts) runtimePaths.set(artifact.name, await downloadArtifact(artifact));

  const scriptsRoot = join(root, 'scripts/offline-windows');
  const supportFiles = [
    { source: join(scriptsRoot, 'START-DEMO.cmd'), path: 'START-DEMO.cmd', role: 'support' },
    { source: join(scriptsRoot, 'STOP-DEMO.cmd'), path: 'STOP-DEMO.cmd', role: 'support' },
    { source: join(scriptsRoot, 'launcher.ps1'), path: 'launcher.ps1', role: 'support' },
    { source: join(scriptsRoot, 'THIRD-PARTY-NOTICES.txt'), path: 'THIRD-PARTY-NOTICES.txt', role: 'support' },
    { source: join(scriptsRoot, 'USER-GUIDE.txt'), path: 'USER-GUIDE.txt', role: 'support' }
  ];
  const artifacts = [
    { source: jarPath, path: 'runtime/bnoc-server-1.0.0.jar', role: 'application' },
    { source: join(root, 'mock-provider/server.mjs'), path: 'runtime/mock-provider/server.mjs', role: 'provider' },
    ...runtimeArtifacts.map(item => ({ source: runtimePaths.get(item.name), path: item.path, role: item.name }))
  ];
  const dependencies = {
    application: { path: 'runtime/bnoc-server-1.0.0.jar', version: '1.0.0' },
    ...runtimeArtifacts.reduce((result, item) => ({ ...result, [item.name]: { path: item.path, version: item.version, archive: item.archive, url: item.url } }), {})
  };
  const { destination, manifest } = await createCdBundle({
    outputRoot,
    artifacts,
    publicFiles: supportFiles,
    dependencies,
    application: dependencies.application
  });
  await verifyCdBundle(destination);
  const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  process.stdout.write(`CD package created: ${destination}\n`);
  process.stdout.write(`Release: ${manifest.releaseId}\n`);
  process.stdout.write(`Payload: ${(bytes / 1024 / 1024).toFixed(1)} MiB\n`);
  process.stdout.write('Copy exactly the folder shown after "CD package created" to CD, not its parent folder. On the offline PC, open START-DEMO.cmd.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
