import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// One container keeps the provider on loopback without relaxing AuthService.
export function supervise(children, exit = code => process.exit(code), graceMs = 20000) {
  let stopping = false;
  let timer;
  let exitCode = 0;
  const alive = new Set(children);
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of alive) child.kill('SIGTERM');
    timer = setTimeout(() => {
      for (const child of alive) child.kill('SIGKILL');
      exit(code);
    }, graceMs);
    timer.unref?.();
    if (!alive.size) { clearTimeout(timer); exit(code); }
  }
  for (const child of children) {
    child.once('error', () => { alive.delete(child); stop(1); });
    child.once('exit', code => {
      alive.delete(child);
      if (!stopping) stop(code === 0 ? 1 : code ?? 1);
      else if (!alive.size) { clearTimeout(timer); exit(exitCode); }
    });
  }
  return stop;
}

export async function main() {
  const env = { ...process.env,
    BNOC_DB_PASSWORD: (await readFile('/run/secrets/db_password', 'utf8')).trim(),
    BNOC_MOCK_SECRET: (await readFile('/run/secrets/mock_secret', 'utf8')).trim()
  };
  const options = { env, stdio: 'inherit', uid: 1000, gid: 1000 };
  const stop = supervise([
    spawn(process.execPath, ['mock-provider/server.mjs'], options),
    spawn('java', ['-jar', 'server.jar'], options)
  ]);
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Container startup failed; check secret files and runtime configuration.');
  process.exitCode = 1;
});
