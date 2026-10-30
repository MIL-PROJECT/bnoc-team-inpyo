import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha256File = path => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', chunk => hash.update(chunk));
  input.once('error', reject);
  input.once('end', () => resolveHash(hash.digest('hex')));
});
const safeRelativePath = path => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid bundle path: ${path}`);
  }
  return path;
};
const requiredDependencies = ['application', 'mysql', 'node', 'java', 'vcRuntime'];
function assertRequiredDependencies(dependencies, paths) {
  for (const name of requiredDependencies) {
    const item = dependencies?.[name];
    if (!item || !paths.has(item.path)) throw new Error(`Required ${name} artifact is missing from bundle inputs.`);
  }
}

export async function createCdBundle({ outputRoot, artifacts, dependencies, application, publicFiles }) {
  if (!outputRoot || !Array.isArray(artifacts) || !Array.isArray(publicFiles)) throw new Error('Bundle inputs are incomplete.');
  const root = resolve(outputRoot);
  const inputFiles = [...artifacts, ...publicFiles];
  const paths = new Set();
  const plannedFiles = [];
  for (const item of inputFiles) {
    const path = safeRelativePath(item.path);
    if (paths.has(path) || path === 'bundle-manifest.json') throw new Error(`Duplicate bundle path: ${path}`);
    paths.add(path);
    const source = resolve(item.source);
    const sourceStat = await stat(source).catch(() => null);
    if (!sourceStat?.isFile()) throw new Error(`Required package file is missing: ${item.source}`);
    plannedFiles.push({ source, path, size: sourceStat.size, sha256: await sha256File(source), role: item.role ?? 'support' });
  }
  assertRequiredDependencies(dependencies, paths);
  const app = plannedFiles.find(file => file.path === application.path);
  if (!app || app.role !== 'application') throw new Error('Application JAR must be included as the application artifact.');
  const digestInput = plannedFiles.map(file => `${file.path}\0${file.sha256}\0${file.size}`).sort().join('\n');
  const releaseId = `bnoc-win-x64-${createHash('sha256').update(digestInput).digest('hex').slice(0, 16)}`;
  const destination = join(root, releaseId);
  await mkdir(root, { recursive: true });
  await mkdir(destination, { recursive: false }).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Package already exists; refusing to overwrite: ${destination}`);
    throw error;
  });
  try {
    for (const file of plannedFiles) {
      const target = join(destination, file.path);
      if (!relative(destination, target) || relative(destination, target).startsWith(`..${sep}`)) throw new Error(`Bundle path escaped output: ${file.path}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.source, target);
    }
    const manifest = {
      schemaVersion: 1,
      releaseId,
      target: { platform: 'win32', architecture: 'x64' },
      application: { ...application, sha256: app.sha256, size: app.size },
      dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, item]) => {
        const file = plannedFiles.find(candidate => candidate.path === item.path);
        return [name, { ...item, sha256: file.sha256, size: file.size }];
      })),
      files: plannedFiles.map(({ source: _source, ...file }) => file)
    };
    await writeFile(join(destination, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await verifyCdBundle(destination, manifest);
    return { destination, manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyCdBundle(bundleRoot, manifestInput) {
  const root = resolve(bundleRoot);
  const manifest = manifestInput ?? JSON.parse(await readFile(join(root, 'bundle-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.target?.platform !== 'win32' || manifest.target?.architecture !== 'x64' || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed offline bundle manifest.');
  }
  for (const file of manifest.files) {
    const path = safeRelativePath(file.path);
    const target = resolve(root, path);
    if (!relative(root, target) || relative(root, target).startsWith(`..${sep}`)) throw new Error(`Bundle path escaped root: ${path}`);
    const actualStat = await stat(target).catch(() => null);
    if (!actualStat?.isFile() || actualStat.size !== file.size || await sha256File(target) !== file.sha256) {
      throw new Error(`Bundle integrity check failed: ${path}`);
    }
  }
  assertRequiredDependencies(manifest.dependencies, new Set(manifest.files.map(file => file.path)));
  const expectedPaths = new Set([...manifest.files.map(file => file.path), 'bundle-manifest.json']);
  const actualPaths = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else actualPaths.push(path);
    }
  }
  await walk(root);
  if (actualPaths.some(path => !expectedPaths.has(path)) || [...expectedPaths].some(path => !actualPaths.includes(path))) {
    throw new Error('Offline package contains missing or unlisted files.');
  }
  return true;
}

export async function readBundleManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
