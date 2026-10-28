import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainPublicArtifact} from './bnoc-public.mjs';

test('public execution keeps its bytes when a later build replaces the source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bnoc-public-artifact-'));
  try{
    const source=join(root,'build.jar'),destination=join(root,'artifacts');
    await writeFile(source,'first validated package');
    const first=await retainPublicArtifact(source,destination);
    await writeFile(source,'next build');
    assert.equal(await readFile(first.path,'utf8'),'first validated package','RUNNING_ARTIFACT_MUST_SURVIVE_NEW_BUILD');
    const next=await retainPublicArtifact(source,destination);assert.notEqual(next.path,first.path);
    assert.deepEqual(await retainPublicArtifact(source,destination),next);
    await writeFile(next.path,'damaged retained package');
    await assert.rejects(retainPublicArtifact(source,destination),/does not match its SHA/,'CORRUPTED_ARTIFACT_MUST_NOT_RUN');
    assert.equal(await readFile(next.path,'utf8'),'damaged retained package');
  }finally{await rm(root,{recursive:true,force:true});}
});
