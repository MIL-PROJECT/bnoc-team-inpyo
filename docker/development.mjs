import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chown, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { supervise } from './supervisor.mjs';

export const dependencyFiles = ['frontend/package.json', 'frontend/pnpm-lock.yaml', 'backend/build.gradle.kts', 'backend/settings.gradle.kts'];
export const toolchainFiles = [...dependencyFiles, 'frontend/vite.config.ts', 'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.dev.yaml', 'docker/development.mjs', 'docker/development-backend.mjs', 'docker/development.gradle', 'docker/vite.dev.config.mjs', 'docker/supervisor.mjs', 'docker/health.mjs'];
export async function fingerprint(root, files = dependencyFiles) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(resolve(root, file))).update('\0');
  return hash.digest('hex');
}
export function isServerPath(url = '/') {
  let path = url.split('?')[0];
  for (let i = 0; i < 3; i++) {
    try { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; } catch { break; }
  }
  return /^\/(?:api|identity|control|feeds)(?:$|[\/;\\%])/i.test(path.replaceAll('\\', '/'));
}
export async function validateMounts(root, folders = ['frontend', 'backend', 'mock-provider', 'design', 'docker']) {
  const hidden = new Set(['frontend/node_modules', 'frontend/dist', 'backend/build', 'backend/.gradle']);
  async function visit(path) {
    const stat = await lstat(resolve(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Development mounts must not contain symbolic links: ${path}`);
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(resolve(root, path))) {
      const name = `${path}/${entry}`;
      if (hidden.has(name)) continue;
      if (/^(?:\.env(?:\.|$)|\.git$|\.local$|runtime$|secrets?$|attachments?$)|\.(?:pem|p12|pfx|jks|keystore|sql|dump)$/i.test(entry)) {
        throw new Error(`Private local input must not enter development mounts: ${name}`);
      }
      await visit(name);
    }
  }
  for (const folder of folders) {
    await visit(folder);
  }
}
export function run(binary, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, options);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${binary} failed (${code ?? 'signal'}).`)));
  });
}
export async function main() {
  const root = '/workspace';
  await validateMounts(root, ['frontend', 'backend', 'mock-provider', 'design']);
  await validateMounts('/opt/bnoc', ['docker']);
  const expected = process.env.BNOC_DEV_DEPENDENCIES;
  if (await fingerprint(root) !== expected) throw new Error('Dependencies changed. Run npm run team:up to prepare again.');
  const env = { ...process.env,
    BNOC_DB_PASSWORD: (await readFile('/run/secrets/db_password', 'utf8')).trim(),
    BNOC_MOCK_SECRET: (await readFile('/run/secrets/mock_secret', 'utf8')).trim(),
    GRADLE_USER_HOME: '/cache/gradle', HOME: '/home/node'
  };
  for (const path of ['/cache', '/cache/gradle', '/cache/project', '/cache/pnpm', '/workspace/frontend/node_modules', '/workspace/backend/build', '/data/attachments', '/evidence']) {
    await mkdir(path, { recursive: true }); await chown(path, 1000, 1000);
  }
  const options = { env, stdio: 'inherit', uid: 1000, gid: 1000 };
  const marker = '/workspace/frontend/node_modules/.bnoc-dependencies';
  let prepared;
  try { prepared = await readFile(marker, 'utf8'); } catch { /* First use of this dependency volume. */ }
  if (prepared !== expected) {
    await run('pnpm', ['install', '--frozen-lockfile', '--store-dir', '/cache/pnpm'], { ...options, cwd: '/workspace/frontend' });
    await writeFile(marker, expected);
  }
  const stop = supervise([
    spawn(process.execPath, ['/opt/bnoc/docker/development-backend.mjs'], options),
    spawn('/workspace/frontend/node_modules/.bin/vite', ['--config', '/opt/bnoc/docker/vite.dev.config.mjs', '--configLoader', 'native'], { ...options, cwd: '/workspace/frontend' })
  ]);
  const timer = setInterval(async () => {
    try {
      if (await fingerprint(root) !== expected) {
        console.error('[development] Dependencies changed. Run npm run team:up; data and secrets are preserved.');
        clearInterval(timer); stop(1);
      }
    } catch { clearInterval(timer); stop(1); }
  }, 1000);
  const shutdown = () => { clearInterval(timer); stop(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
