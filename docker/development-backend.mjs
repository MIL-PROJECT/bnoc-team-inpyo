import { spawn } from 'node:child_process';
import { readFile, readdir, lstat, cp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function sourceFingerprint(root) {
  const hash = createHash('sha256');
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Development sources must not be symbolic links.');
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    else if (stat.isFile()) hash.update(relative(root, path)).update('\0').update(await readFile(path));
  }
  await visit(join(root, 'backend/src/main')); await visit(join(root, 'mock-provider/server.mjs'));
  return hash.digest('hex');
}
export async function watchSources(snapshot, apply, signal, interval = 700) {
  let previous;
  while (!signal.aborted) {
    let current;
    try { current = await snapshot(); } catch { await delay(interval); continue; }
    if (current !== previous) {
      if (previous !== undefined) await delay(250);
      try { previous = await snapshot(); } catch { continue; }
      await apply();
    }
    await delay(interval);
  }
}
export async function stopChild(child, graceMs = 15000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(accept => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => { clearTimeout(timer); accept(); });
    child.kill('SIGTERM');
  });
}
export async function main() {
  const signal = new AbortController();
  let java, provider, compiler;
  const options = { stdio: 'inherit', env: process.env };
  const shutdown = async () => {
    if (signal.signal.aborted) return;
    signal.abort();
    await Promise.all([stopChild(java), stopChild(provider), stopChild(compiler)]);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  await watchSources(() => sourceFingerprint('/workspace'), async () => {
    await Promise.all([stopChild(java), stopChild(provider)]);
    java = undefined; provider = undefined;
    if (signal.signal.aborted) return;
    await mkdir('/cache/backend', { recursive: true });
    await rm('/cache/backend/src', { recursive: true, force: true });
    for (const file of ['src', 'build.gradle.kts', 'settings.gradle.kts']) await cp(`/workspace/backend/${file}`, `/cache/backend/${file}`, { recursive: true });
    console.log('[development] Compiling changed backend sources. Docker image is unchanged.');
    const compiled = await new Promise(accept => {
      compiler = spawn('gradle', ['-p', '/cache/backend', '-I', '/opt/bnoc/docker/development.gradle', '--project-cache-dir', '/cache/project', '--console', 'plain', '--max-workers=2', 'classes', 'bnocDevClasspath'], options);
      compiler.once('error', error => { console.error(error.message); accept(false); });
      compiler.once('exit', code => accept(code === 0));
    });
    compiler = undefined;
    if (signal.signal.aborted) return;
    if (!compiled) { console.error('[development] Compile failed. Fix the source and save again; the watcher is still running.'); return; }
    const classpath = (await readFile('/workspace/backend/build/bnoc-dev-classpath', 'utf8')).trim();
    java = spawn('java', ['-cp', classpath, 'bnoc.ApplicationKt'], options);
    provider = spawn(process.execPath, ['/workspace/mock-provider/server.mjs'], options);
    for (const child of [java, provider]) {
      child.on('error', error => console.error(error.message));
      child.on('exit', code => { if (!signal.signal.aborted && !child.killed && code) console.error('[development] Runtime failed. Fix the source and save again.'); });
    }
    console.log('[development] Backend processes restarted; database and attachments retained.');
  }, signal.signal);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
