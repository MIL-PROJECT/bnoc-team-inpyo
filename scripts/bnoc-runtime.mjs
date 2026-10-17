import { readFile, writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const runtimeRoot = join(root, '.local/bnoc-runtime');
const mysqlHome = process.env.BNOC_MYSQL_HOME ?? join(root, '.local/dependencies/mysql-8.4.11-macos15-arm64');
const gradle = process.env.BNOC_GRADLE ?? join(root, '.local/dependencies/gradle-9.3.0/bin/gradle');
const manifestPath = join(runtimeRoot, 'services.json');
const secretPath = join(runtimeRoot, 'secrets.json');
const mysqlBinary = name => join(mysqlHome, 'bin', name);
// The Korean checkout path exceeds MySQL's Unix socket path limit.
const socket = join('/private/tmp', `bnoc-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.sock`);
assert.ok(Buffer.byteLength(socket) <= 103, 'MYSQL_SOCKET_PATH_LIMIT');
const exists = path => access(path).then(() => true, () => false);
async function loadJson(path, fallback) { return exists(path).then(async present => present ? JSON.parse(await readFile(path, 'utf8')) : fallback); }
async function saveJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600); }
export async function readSecrets() { return JSON.parse(await readFile(secretPath, 'utf8')); }
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${executable.split('/').at(-1)} failed: ${(result.stderr ?? result.error?.message ?? '').slice(0, 600)}`);
  return result.stdout;
}
async function clientConfig(name, user, password, database) {
  const path = join(runtimeRoot, name + '.cnf');
  await writeFile(path, `[client]\nuser=${user}\npassword=${password}\nprotocol=socket\nsocket=${socket}\n${database ? `database=${database}\n` : ''}`, { mode: 0o600 });
  await chmod(path, 0o600); return path;
}
async function manifest() { return loadJson(manifestPath, {}); }
function running(entry) {
  if (!entry?.pid || !entry.signature) return false;
  const result = spawnSync('ps', ['-p', String(entry.pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error || /not permitted|permission denied/i.test(result.stderr ?? '')) return null;
  return result.status === 0 && result.stdout.includes(entry.signature);
}
async function launch(name, executable, args, env, signature, metadata = {}) {
  const entries = await manifest();
  if (running(entries[name]) === null) throw new Error('Process ownership cannot be checked in this restricted environment.');
  if (running(entries[name])) return entries[name];
  const log = join(runtimeRoot, 'logs', name + '.log');
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd); child.unref();
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  entries[name] = { pid: child.pid, signature, log, startedAt: new Date().toISOString(), ...metadata };
  await saveJson(manifestPath, entries); return entries[name];
}
async function waitUntil(check, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${description} did not become ready; see .local/bnoc-runtime/logs`);
}
async function apiReady(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.status === 200 || response.status === 401; } catch { return false; } }

export async function bootstrapDatabase() {
  await mkdir(join(runtimeRoot, 'logs'), { recursive: true });
  await mkdir(join(runtimeRoot, 'attachments'), { recursive: true });
  await mkdir(join(runtimeRoot, 'verify-attachments'), { recursive: true });
  if (!await exists(mysqlBinary('mysqld'))) throw new Error('MySQL 8.4 runtime missing. See README.');
  const data = join(runtimeRoot, 'mysql');
  if (!await exists(join(data, 'auto.cnf'))) {
    await mkdir(data, { recursive: true });
    command(mysqlBinary('mysqld'), ['--no-defaults', '--initialize-insecure', `--basedir=${mysqlHome}`, `--datadir=${data}`, `--log-error=${join(runtimeRoot, 'logs/mysql-initialize.log')}`]);
  }
  const pidFile = join(runtimeRoot, 'mysql.pid');
  const savedPid = await exists(pidFile) ? Number((await readFile(pidFile, 'utf8')).trim()) : null;
  if (savedPid && running({ pid: savedPid, signature: data })) {
    const entries = await manifest(); entries.mysql = { pid: savedPid, signature: data, log: join(runtimeRoot, 'logs/mysql.log') }; await saveJson(manifestPath, entries);
  } else {
    await launch('mysql', mysqlBinary('mysqld'), ['--no-defaults', `--basedir=${mysqlHome}`, `--datadir=${data}`, '--port=3307', '--bind-address=127.0.0.1', `--socket=${socket}`, `--pid-file=${pidFile}`, `--log-error=${join(runtimeRoot, 'logs/mysql.log')}`, '--mysqlx=OFF', '--skip-log-bin'], {}, data);
  }
  await waitUntil(async () => (await exists(socket)), 'Project MySQL');
  let secrets = await loadJson(secretPath, null);
  if (!secrets) { secrets = { rootPassword: randomBytes(32).toString('hex'), appPassword: randomBytes(32).toString('hex'), verifyPassword: randomBytes(32).toString('hex'), mockSecret: randomBytes(32).toString('hex'), initialized: false }; await saveJson(secretPath, secrets); }
  const rootConfig = await clientConfig('root', 'root', secrets.rootPassword);
  if (!secrets.initialized) {
    const sql = `CREATE DATABASE IF NOT EXISTS bnoc CHARACTER SET utf8mb4; CREATE DATABASE IF NOT EXISTS bnoc_verify CHARACTER SET utf8mb4;
      CREATE USER IF NOT EXISTS 'bnoc_app'@'localhost' IDENTIFIED BY '${secrets.appPassword}';
      CREATE USER IF NOT EXISTS 'bnoc_app'@'127.0.0.1' IDENTIFIED BY '${secrets.appPassword}';
      CREATE USER IF NOT EXISTS 'bnoc_verify'@'localhost' IDENTIFIED BY '${secrets.verifyPassword}';
      CREATE USER IF NOT EXISTS 'bnoc_verify'@'127.0.0.1' IDENTIFIED BY '${secrets.verifyPassword}';
      GRANT ALL PRIVILEGES ON bnoc.* TO 'bnoc_app'@'localhost'; GRANT ALL PRIVILEGES ON bnoc.* TO 'bnoc_app'@'127.0.0.1';
      GRANT ALL PRIVILEGES ON bnoc_verify.* TO 'bnoc_verify'@'localhost'; GRANT ALL PRIVILEGES ON bnoc_verify.* TO 'bnoc_verify'@'127.0.0.1';
      ALTER USER 'root'@'localhost' IDENTIFIED BY '${secrets.rootPassword}';`;
    try { command(mysqlBinary('mysql'), [`--defaults-extra-file=${rootConfig}`, '--batch'], { input: sql }); }
    catch { command(mysqlBinary('mysql'), ['--no-defaults', '--user=root', '--protocol=socket', `--socket=${socket}`, '--batch'], { input: sql }); }
    secrets.initialized = true; await saveJson(secretPath, secrets);
  }
  await clientConfig('app', 'bnoc_app', secrets.appPassword, 'bnoc');
  await clientConfig('verify', 'bnoc_verify', secrets.verifyPassword, 'bnoc_verify');
  command(mysqlBinary('mysql'), [`--defaults-extra-file=${rootConfig}`, '--batch', '--execute=SELECT VERSION();']);
  return secrets;
}

export async function runVerifySQL(sql) {
  const config = join(runtimeRoot, 'verify.cnf');
  return command(mysqlBinary('mysql'), [`--defaults-extra-file=${config}`, '--batch', '--skip-column-names'], { input: sql });
}
export async function testEnvironment() {
  const secrets = await readSecrets();
  return { BNOC_TEST_URL: 'http://127.0.0.1:8083', BNOC_MOCK_URL: 'http://127.0.0.1:8082', BNOC_MOCK_SECRET: secrets.mockSecret };
}
async function startProvider(secrets) {
  const path = join(root, 'mock-provider/server.mjs');
  const entry = await launch('provider', process.execPath, [path], { BNOC_MOCK_SECRET: secrets.mockSecret, BNOC_MOCK_ALLOWED_ORIGINS: 'http://127.0.0.1:8081,http://127.0.0.1:8083' }, path);
  await waitUntil(() => running(entry) && apiReady('http://127.0.0.1:8082/health'), 'Mock provider');
}
export async function startApplication(verification = false) {
  const secrets = await bootstrapDatabase(); await startProvider(secrets);
  const port = verification ? 8083 : 8081;
  const jar = join(root, 'backend/build/libs/bnoc-server-1.0.0.jar');
  if (!await exists(jar)) throw new Error('Application JAR missing. Run npm run server:build.');
  const environment = {
    BNOC_PORT: String(port), BNOC_PUBLIC_URL: `http://127.0.0.1:${port}`,
    BNOC_DB_URL: `jdbc:mysql://127.0.0.1:3307/${verification ? 'bnoc_verify' : 'bnoc'}?useUnicode=true&characterEncoding=UTF-8&serverTimezone=Asia/Seoul`,
    BNOC_DB_USER: verification ? 'bnoc_verify' : 'bnoc_app', BNOC_DB_PASSWORD: verification ? secrets.verifyPassword : secrets.appPassword,
    BNOC_MOCK_SECRET: secrets.mockSecret, BNOC_PROVIDER_URL: 'http://127.0.0.1:8082', BNOC_INTEGRATION_MODE: 'competition',
    BNOC_FILE_ROOT: join(runtimeRoot, verification ? 'verify-attachments' : 'attachments'),
    ...(verification ? { BNOC_GPS_POLL_MS: '1000', BNOC_CPCON_POLL_MS: '1000', BNOC_GPS_TIMEOUT_MS: '1000', BNOC_CPCON_TIMEOUT_MS: '1000' } : {})
  };
  const entry = await launch(verification ? 'verification' : 'application', 'java', ['-jar', jar], environment, jar + '', { artifactSha256: createHash('sha256').update(await readFile(jar)).digest('hex') });
  await waitUntil(() => running(entry) && apiReady(`http://127.0.0.1:${port}/api/session`), 'BNOC application');
  return { url: `http://127.0.0.1:${port}`, pid: entry.pid, mode: 'competition' };
}
export async function stopService(name) {
  const entries = await manifest(), entry = entries[name];
  const owned = running(entry);
  if (owned === null) throw new Error('Process ownership cannot be checked in this restricted environment.');
  if (owned) {
    process.kill(entry.pid, 'SIGTERM');
    await waitUntil(async () => running(entry) === false, name + ' shutdown');
  }
  delete entries[name]; await saveJson(manifestPath, entries);
}
async function build() {
  command('npm', ['run', 'build'], { stdio: 'inherit' });
  if (!await exists(gradle)) throw new Error('Gradle 9.3.0 runtime missing. See README.');
  command(gradle, ['-p', 'backend', 'test', 'bootJar', '--no-daemon'], { env: { ...process.env, GRADLE_USER_HOME: join(root, '.local/gradle') }, stdio: 'inherit' });
}
async function status() {
  const entries = await manifest();
  return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, { running: running(entry), pid: entry.pid, log: entry.log }]));
}
async function main() {
  const action = process.argv[2] ?? 'status';
  if (action === 'build') return build();
  if (action === 'bootstrap') { await bootstrapDatabase(); await startProvider(await readSecrets()); return console.log('Project MySQL and mock provider ready; credentials retained privately.'); }
  if (action === 'start' || action === 'verify-start') return console.log(JSON.stringify(await startApplication(action === 'verify-start')));
  if (action === 'stop') { for (const name of ['verification', 'application', 'provider', 'mysql']) await stopService(name); return console.log('Project services stopped.'); }
  if (action === 'verify-stop') return stopService('verification');
  if (action === 'test-api' || action === 'test-ui') {
    const env = { ...process.env, ...await testEnvironment() };
    return action === 'test-api' ? command(process.execPath, ['--test', 'e2e/server-api.test.mjs'], { env, stdio: 'inherit' }) : command('npx', ['playwright', 'test', '--config=e2e/server-playwright.config.ts'], { env, stdio: 'inherit' });
  }
  if (action === 'status') return console.log(JSON.stringify(await status(), null, 2));
  throw new Error('Unknown runtime action.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
