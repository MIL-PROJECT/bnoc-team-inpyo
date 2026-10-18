import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { access, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, toolchainFiles, validateMounts } from '../docker/development.mjs';

export const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const actions = new Set(['doctor', 'setup', 'up', 'verify', 'status', 'down']);
export function configuration(action, directory = root, environment = process.env) {
  if (!actions.has(action)) throw new Error('Use doctor, setup, up, verify, status or down.');
  const mode = action === 'verify' ? 'verify' : 'dev';
  const prefix = environment.BNOC_TEAM_PROJECT ?? `bnoc-${createHash('sha256').update(directory).digest('hex').slice(0, 10)}`;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error('BNOC_TEAM_PROJECT must use lowercase letters, numbers or hyphens (maximum 40 characters).');
  const port = mode === 'verify' ? 18083 : Number(environment.BNOC_TEAM_PORT ?? 18081);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BNOC_TEAM_PORT must be an integer from 1024 through 65535.');
  const secretDirectory = join(directory, '.local', 'team', mode);
  const evidenceDirectory = join(directory, 'runtime', 'evidence', 'team-collaboration-20261017', mode);
  return { mode, project: `${prefix}-${mode}`, secretDirectory, evidenceDirectory,
    env: { ...environment, BNOC_TEAM_PORT: String(port), BNOC_TEAM_TARGET: mode === 'verify' ? 'verification' : 'development',
      BNOC_TEAM_SECRET_DIR: secretDirectory, BNOC_TEAM_EVIDENCE_DIR: evidenceDirectory,
      BNOC_TEAM_PUBLIC_URL: `http://127.0.0.1:${mode === 'verify' ? 8083 : port}`,
      BNOC_TEAM_POLL_MS: mode === 'verify' ? '1000' : '30000', BNOC_TEAM_TIMEOUT_MS: mode === 'verify' ? '1000' : '5000' } };
}
export function composeArguments(config, args) {
  return ['compose', '--project-name', config.project, '--file', join(root, 'compose.yaml'), ...(config.mode === 'dev' ? ['--file', join(root, 'compose.dev.yaml')] : []), ...args];
}
function execute(binary, args, env = process.env, capture = false) {
  const result = spawnSync(binary, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${binary} command failed${result.error?.code === 'ENOENT' ? ': executable not installed' : ` (exit ${result.status ?? 'unknown'})`}.`);
  return result.stdout;
}
async function prepare(config) {
  await mkdir(config.secretDirectory, { recursive: true, mode: 0o700 });
  for (const file of ['db-password', 'db-root-password', 'mock-secret']) {
    const path = join(config.secretDirectory, file);
    try { await writeFile(path, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await chmod(path, 0o600);
  }
  await mkdir(config.evidenceDirectory, { recursive: true });
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) throw new Error('One action only; extra flags are not accepted.');
  const action = argv[0] ?? 'doctor';
  const config = configuration(action);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  execute('docker', ['compose', 'version'], config.env);
  execute('docker', ['info', '--format', '{{.ServerVersion}}'], config.env);
  if (action === 'doctor') {
    console.log('Docker engine and Compose available. Application builds run inside Docker.');
    return;
  }
  const compose = args => execute('docker', composeArguments(config, args), config.env);
  if (action === 'status' || action === 'down') {
    for (const mode of ['dev', 'verify']) {
      const current = configuration(mode === 'dev' ? 'up' : 'verify');
      try { await access(current.secretDirectory); } catch { console.log(`${current.project}: not initialized`); continue; }
      execute('docker', composeArguments(current, action === 'status' ? ['ps', '--all'] : ['down']), current.env);
    }
    return;
  }
  if (action === 'verify') {
    config.evidenceDirectory = join(config.evidenceDirectory, new Date().toISOString().replaceAll(':', '-'));
    config.env.BNOC_TEAM_EVIDENCE_DIR = config.evidenceDirectory;
  }
  await prepare(config);
  if (action === 'up' || action === 'setup') {
    await validateMounts(root);
    for (const path of ['frontend/node_modules', 'frontend/dist', 'backend/build', 'backend/.gradle']) await mkdir(join(root, path), { recursive: true });
    config.env.BNOC_DEV_FINGERPRINT = await fingerprint(root, toolchainFiles);
    config.env.BNOC_DEV_DEPENDENCIES = await fingerprint(root);
    const image = spawnSync('docker', ['image', 'inspect', `${config.project}-app`, '--format', '{{ index .Config.Labels "bnoc.development.fingerprint" }}'], { env: config.env, encoding: 'utf8' });
    const prepareImage = action === 'setup' || image.status !== 0 || image.stdout.trim() !== config.env.BNOC_DEV_FINGERPRINT;
    if (prepareImage) {
      console.log('Preparing development tools. Ordinary source edits do not rebuild this image.');
      execute('docker', ['build', '--target', 'development', '--tag', `${config.project}-app`, '--build-arg', `BNOC_DEV_FINGERPRINT=${config.env.BNOC_DEV_FINGERPRINT}`, '--build-arg', `BNOC_DEV_DEPENDENCIES=${config.env.BNOC_DEV_DEPENDENCIES}`, root], config.env);
    }
    compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '600']);
    console.log(`BNOC ready: ${config.env.BNOC_TEAM_PUBLIC_URL}. Source edits apply automatically.`);
    return;
  }
  const lock = join(config.secretDirectory, 'verification.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Verification already running or interrupted. Confirm it stopped before removing .local/team/verify/verification.lock.');
    throw error;
  }
  const record = { project: config.project, startedAt: new Date().toISOString(), status: 'running' };
  const saveRecord = () => writeFile(join(config.evidenceDirectory, 'run.json'), JSON.stringify(record, null, 2) + '\n');
  try {
    await saveRecord();
    execute('docker', ['build', '--target', 'verification', '--tag', `${config.project}-app`, root], config.env);
    compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
    compose(['exec', '-T', 'app', 'node', 'docker/verify.mjs']);
    compose(['exec', '-T', 'app', 'node', 'docker/persistence.mjs', 'seed']);
    compose(['stop', 'app']);
    compose(['restart', 'db']);
    compose(['up', '--detach', '--wait', '--wait-timeout', '180']);
    compose(['exec', '-T', 'app', 'node', 'docker/persistence.mjs', 'check']);
    record.status = 'passed';
    console.log(`Verification passed. Evidence: ${config.evidenceDirectory}`);
  } catch (error) {
    record.status = 'failed';
    throw error;
  } finally {
    try { compose(['stop']); } catch (error) { record.status = 'failed'; throw error; } finally {
      record.finishedAt = new Date().toISOString();
      try { await saveRecord(); } finally { await rm(lock, { recursive: true, force: true }); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
