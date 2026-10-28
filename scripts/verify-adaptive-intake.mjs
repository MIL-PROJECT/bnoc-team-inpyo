import {mkdtemp,cp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),evidence=join(root,'runtime/evidence/adaptive-intake-20261027/sensitivity');
await mkdir(evidence,{recursive:true});
const source=join(root,'backend/src/main/kotlin/bnoc/IntakePolicy.kt'),original=await readFile(source,'utf8');
const sha=value=>createHash('sha256').update(value).digest('hex');
const originalSha=sha(original),folder=await mkdtemp(join(tmpdir(),'bnoc-adaptive-sensitivity-'));
const cases=[{name:'normal',change:value=>value,failed:false},
 {name:'quantity-total-bypass',change:value=>value.replace('if(items.groupBy{it.kind}.mapValues{(_,values)->values.sumOf{it.quantity}}!=counts)fail(', 'if(false&&items.groupBy{it.kind}.mapValues{(_,values)->values.sumOf{it.quantity}}!=counts)fail('),failed:true,test:'initial totals and positive integral quantities are enforced atomically'},
 {name:'installation-model-leak',change:value=>value.replace('if(work!="신설"&&kind in setOf("PC","프린터","CCTV"))','if(kind in setOf("PC","프린터","CCTV"))'),failed:true,test:'installation never stores hidden equipment model or fault fields'}];
const results=[];
try{
 for(const scenario of cases){
  const target=join(folder,scenario.name,'backend');
  await cp(join(root,'backend'),target,{recursive:true,filter:path=>path!==join(root,'backend/build')&&path!==join(root,'backend/.gradle')});
  const changed=scenario.change(original);if(scenario.failed)assert.notEqual(changed,original);
  await writeFile(join(target,'src/main/kotlin/bnoc/IntakePolicy.kt'),changed);
  await writeFile(join(evidence,scenario.name+'-injection.json'),JSON.stringify({source:'backend/src/main/kotlin/bnoc/IntakePolicy.kt',originalSha,mutatedSha:sha(changed),test:scenario.test??null},null,2));
  const run=spawnSync(join(root,'.local/dependencies/gradle-9.3.0/bin/gradle'),['-g',join(root,'.local/gradle'),'-p',target,'test','--tests','bnoc.AdaptiveIntakeContractTest','--console=plain','--no-daemon'],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
  await writeFile(join(evidence,scenario.name+'.log'),(run.stdout??'')+(run.stderr??''));
  const files=await readdir(join(target,'build/test-results/test'));
  const xml=(await Promise.all(files.filter(name=>name.endsWith('.xml')).map(name=>readFile(join(target,'build/test-results/test',name),'utf8')))).join('\n');
  await writeFile(join(evidence,scenario.name+'.xml'),xml);
  if(!scenario.failed){assert.equal(run.status,0);assert.match(xml,/failures="0"/);}
  else {assert.notEqual(run.status,0);const escaped=scenario.test.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const failedCase=xml.match(new RegExp(`<testcase name="${escaped}\\(\\)"[^>]*(?<!/)>[^]*?</testcase>`));assert.ok(failedCase,scenario.name+' exact failed test must exist');assert.match(failedCase[0],/<failure[^]*org.opentest4j.AssertionFailedError/);assert.match(xml,/failures="1"/);}
  results.push({name:scenario.name,status:run.status,intendedAssertionDetected:scenario.failed?true:null});
  console.log(JSON.stringify(results.at(-1)));
 }
}finally{await rm(folder,{recursive:true,force:true});assert.equal(sha(await readFile(source)),originalSha);await writeFile(join(evidence,'results.json'),JSON.stringify({results,originalUnchanged:true,temporaryCopiesRemoved:true},null,2));}
