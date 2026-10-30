import { readFile, writeFile, mkdir, mkdtemp, link, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function retainArtifact(source, destination) {
  const bytes = await readFile(source), sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, sha256 + '.jar');
  const stage = await mkdtemp(join(destination, '.stage-'));
  try {
    const staged = join(stage, 'artifact.jar');
    await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
    try { await link(staged, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await rm(stage, { recursive: true, force: true }); }
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) throw new Error('Retained artifact does not match its SHA.');
  return { path, sha256 };
}
