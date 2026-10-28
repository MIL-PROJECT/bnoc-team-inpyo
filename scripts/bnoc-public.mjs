import { readFile, writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { root, runtimeRoot, bootstrapDatabase } from './bnoc-runtime.mjs';

const directory = join(root, '.local/bnoc-public');
const manifestPath = join(directory, 'services.json');
const secretsPath = join(directory, 'secrets.json');
const database = 'bnoc_public_demo';
const user = 'bnoc_public_demo';
const applicationPort = 8085;
const providerPort = 8086;
const mysqlHome = process.env.BNOC_MYSQL_HOME ?? join(root, '.local/dependencies/mysql-8.4.11-macos15-arm64');
const tunnelBinary = join(root, '.local/dependencies/cloudflared/cloudflared');
const exists = path => access(path).then(() => true, () => false);
export async function retainPublicArtifact(source, destination) {
  const bytes = await readFile(source), sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, sha256 + '.jar');
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) throw new Error('Retained public artifact does not match its SHA.');
  return { path, sha256 };
}
const json = async (path, fallback) => await exists(path) ? JSON.parse(await readFile(path, 'utf8')) : fallback;
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}
function owned(entry) {
  if (!entry?.pid || !entry.signature) return false;
  const result = spawnSync('ps', ['-p', String(entry.pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error || /not permitted|permission denied/i.test(result.stderr ?? '')) throw new Error('Cannot verify ownership of public services.');
  return result.status === 0 && result.stdout.includes(entry.signature);
}
async function launch(name, executable, args, environment, signature) {
  const manifest = await json(manifestPath, {});
  if (owned(manifest[name])) return manifest[name];
  const log = join(directory, name + '.log');
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...environment }, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd); child.unref();
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const entry = { pid: child.pid, signature, log, startedAt: new Date().toISOString() };
  manifest[name] = entry; await save(manifestPath, manifest); return entry;
}
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(description + ' is not ready; inspect the private public-service logs.');
}
async function ready(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.status === 200 || response.status === 401; }
  catch { return false; }
}
async function stop(name) {
  const manifest = await json(manifestPath, {});
  const entry = manifest[name];
  if (owned(entry)) { process.kill(entry.pid, 'SIGTERM'); await waitFor(async () => !owned(entry), name + ' shutdown'); }
  delete manifest[name]; await save(manifestPath, manifest);
}
async function provision() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(join(directory, 'attachments'), { recursive: true, mode: 0o700 });
  await bootstrapDatabase();
  let secrets = await json(secretsPath, null);
  if (!secrets) {
    const check = spawnSync(join(mysqlHome, 'bin/mysql'), [`--defaults-extra-file=${join(runtimeRoot, 'root.cnf')}`, '--batch', '--skip-column-names'], {
      encoding: 'utf8', input: `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${database}';\n`
    });
    if (check.status !== 0 || check.stdout.trim() !== '0') throw new Error('Public database already exists without its owned runtime credentials.');
    secrets = { password: randomBytes(32).toString('hex'), mockSecret: randomBytes(32).toString('hex') };
    await save(secretsPath, secrets);
  }
  const sql = `CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${secrets.password}';
CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '${secrets.password}';
GRANT ALL PRIVILEGES ON ${database}.* TO '${user}'@'localhost';
GRANT ALL PRIVILEGES ON ${database}.* TO '${user}'@'127.0.0.1';\n`;
  const result = spawnSync(join(mysqlHome, 'bin/mysql'), [`--defaults-extra-file=${join(runtimeRoot, 'root.cnf')}`, '--batch'], { encoding: 'utf8', input: sql });
  if (result.status !== 0) throw new Error('Could not provision the isolated public database.');
  const socket = join('/private/tmp', `bnoc-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.sock`);
  const config = join(directory, 'mysql.cnf');
  await writeFile(config, `[client]\nuser=${user}\npassword=${secrets.password}\nprotocol=socket\nsocket=${socket}\ndatabase=${database}\n`, { mode: 0o600 });
  await chmod(config, 0o600);
  return secrets;
}
async function startTunnel() {
  if (!await exists(tunnelBinary)) throw new Error('Official cloudflared binary missing in .local/dependencies/cloudflared.');
  let manifest = await json(manifestPath, {});
  if (owned(manifest.tunnel) && manifest.url) return manifest.url;
  if (!owned(manifest.application)) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', () => reject(new Error('Public application port is already used by an unowned service.')));
      probe.listen(applicationPort, '127.0.0.1', () => probe.close(resolve));
    });
  }
  // Only the dedicated application port is exposed; never tunnel the provider, DB or workspace.
  const log = join(directory, 'tunnel.log');
  await writeFile(log, '', { mode: 0o600 });
  const entry = await launch('tunnel', tunnelBinary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${applicationPort}`, '--protocol', 'http2'], {}, `--url http://127.0.0.1:${applicationPort}`);
  let url;
  await waitFor(async () => {
    if (!owned(entry)) throw new Error('Public tunnel stopped before assigning a URL.');
    url = (await readFile(log, 'utf8')).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
    return Boolean(url);
  }, 'Public HTTPS tunnel');
  manifest = await json(manifestPath, {}); manifest.url = url; await save(manifestPath, manifest);
  return url;
}
async function startApplication(url, secrets) {
  const source = join(root, 'backend/build/libs/bnoc-server-1.0.0.jar');
  if (!await exists(source)) throw new Error('Build the BNOC JAR before starting public access.');
  const artifact = await retainPublicArtifact(source, join(directory, 'artifacts'));
  const jar = artifact.path, artifactSha256 = artifact.sha256;
  const previous = await json(manifestPath, {});
  if ((previous.configuredUrl && previous.configuredUrl !== url) || (previous.artifactSha256 && previous.artifactSha256 !== artifactSha256) || (previous.application && previous.application.artifactPath !== jar)) {
    await stop('application'); await stop('provider');
  }
  const providerPath = join(root, 'mock-provider/server.mjs');
  const provider = await launch('provider', process.execPath, [providerPath, '--public-runtime'], {
    BNOC_MOCK_PORT: String(providerPort), BNOC_MOCK_SECRET: secrets.mockSecret, BNOC_MOCK_ALLOWED_ORIGINS: url
  }, '--public-runtime');
  await waitFor(() => owned(provider) && ready(`http://127.0.0.1:${providerPort}/health`), 'Public mock provider');
  const application = await launch('application', 'java', ['-jar', jar, `--server.port=${applicationPort}`], {
    BNOC_PORT: String(applicationPort), BNOC_PUBLIC_URL: url,
    BNOC_DB_URL: `jdbc:mysql://127.0.0.1:3307/${database}?useUnicode=true&characterEncoding=UTF-8&serverTimezone=Asia/Seoul`,
    BNOC_DB_USER: user, BNOC_DB_PASSWORD: secrets.password,
    BNOC_PROVIDER_URL: `http://127.0.0.1:${providerPort}`, BNOC_MOCK_SECRET: secrets.mockSecret,
    BNOC_INTEGRATION_MODE: 'competition', BNOC_FILE_ROOT: join(directory, 'attachments'),
    BNOC_BIND: '127.0.0.1', BNOC_COOKIE_SECURE: 'true', BNOC_BOOTSTRAP_ADMIN: 'access-admin',
    BNOC_DEPARTMENTS: '', BNOC_FRONTEND_ROOT: join(directory, 'jar-frontend'),
    BNOC_GPS_POLL_MS: '30000', BNOC_CPCON_POLL_MS: '30000', BNOC_GPS_TIMEOUT_MS: '5000',
    BNOC_CPCON_TIMEOUT_MS: '5000', BNOC_GPS_VALID_SECONDS: '120', BNOC_CPCON_VALID_SECONDS: '120',
    BNOC_CPCON_CODES: '1,2,3,4,5'
  }, `--server.port=${applicationPort}`);
  await waitFor(() => owned(application) && ready(`http://127.0.0.1:${applicationPort}/api/session`), 'Public BNOC server');
  const manifest = await json(manifestPath, {});
  manifest.application.artifactPath = jar;
  manifest.artifactSha256 = artifactSha256; manifest.configuredUrl = url; await save(manifestPath, manifest);
  return { url, mode: 'competition', availability: 'while-computer-and-services-are-running', artifactSha256: manifest.artifactSha256 };
}
async function main() {
  const action = process.argv[2] ?? 'status';
  if (action === 'prepare') { await provision(); return console.log(JSON.stringify({ url: await startTunnel(), serverStarted: false })); }
  if (action === 'start' || action === 'restart') {
    const secrets = await provision();
    if (action === 'restart') { await stop('application'); await stop('provider'); }
    return console.log(JSON.stringify(await startApplication(await startTunnel(), secrets)));
  }
  if (action === 'stop') { for (const name of ['application', 'provider', 'tunnel']) await stop(name); return console.log('Public services stopped; saved demo data retained.'); }
  if (action === 'status') {
    const manifest = await json(manifestPath, {});
    return console.log(JSON.stringify({ url: manifest.url ?? null, services: Object.fromEntries(['application','provider','tunnel'].map(name => [name, { running: owned(manifest[name]), pid: manifest[name]?.pid ?? null }])), artifactSha256: manifest.artifactSha256 ?? null }));
  }
  throw new Error('Unknown public runtime action.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
