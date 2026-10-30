import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export const demoAccounts=[
  ['requester','김공군 중위'],['requester-secondary','최우진 중위'],
  ['bnoc','한도윤 대위'],['bnoc-secondary','임서준 중위'],['access-admin','윤지훈 대위'],
  ['team-wireless','박하늘 중사'],['team-wired','이정훈 하사'],['team-display','정민준 하사'],
  ['team-info','최서진 중사'],['team-crypto','강도현 하사']
];
const groups=[
  ['무선반',[['박하늘','중사'],['김민준','병장'],['이서준','상병'],['최도윤','일병'],['오지훈','중위']]],
  ['유선반',[['이정훈','하사'],['박준서','병장'],['정시우','상병'],['한지호','일병'],['유도현','소위']]],
  ['전장반(전산장비)',[['정민준','하사'],['강준호','병장'],['김태윤','상병'],['신우진','일병'],['서지훈','중위']]],
  ['정체반',[['최서진','중사'],['윤시온','병장'],['임지환','상병'],['조현우','일병'],['백승민','중위']]],
  ['암호반',[['강도현','하사'],['송지우','병장'],['장민재','상병'],['배준혁','일병'],['권도윤','소위']]],
  ['BNOC',[['한도윤','대위'],['김공군','중위'],['박지성','하사']]]
];
export const demoPersonnel=groups.flatMap(([department,people])=>people.map(([displayName,rank])=>({department,displayName,rank})))
  .map((person,index)=>({...person,category:['이병','일병','상병','병장'].includes(person.rank)?'병':'간부',serviceNumber:`26-${970001+index}`,internalPhone:`000-${2101+index}`,active:true}));
const hex=value=>`CONVERT(X'${Buffer.from(String(value)).toString('hex')}' USING utf8mb4)`;

async function main(){
  const apply=process.argv.includes('--apply');
  const evidenceArg=process.argv.find(value=>value.startsWith('--evidence='));
  assert(evidenceArg,'Set a new private --evidence=<absolute folder>');
  const evidence=resolve(evidenceArg.slice('--evidence='.length));
  await mkdir(evidence,{recursive:false,mode:0o700});
  const report={mode:apply?'apply':'plan',target:'owned-public-competition-demo',accounts:[],personnelAdded:[],personnelRetained:[],contactsChanged:[],contactsRetained:[],errors:[]};
  const config=join(root,'.local/bnoc-public/mysql.cnf');
  const mysql=join(root,'.local/dependencies/mysql-8.4.11-macos15-arm64/bin/mysql');
  const sql=query=>{
    const result=spawnSync(mysql,[`--defaults-extra-file=${config}`,'--default-character-set=utf8mb4','--batch','--raw','--skip-column-names'],{input:query,encoding:'utf8'});
    assert.equal(result.status,0,'Owned public database query failed; inspect private configuration');
    return result.stdout.trim();
  };
  let requester,bnoc,admin;
  try{
    const manifest=JSON.parse(await readFile(join(root,'.local/bnoc-public/services.json'),'utf8'));
    assert.equal(sql('SELECT DATABASE();'),'bnoc_public_demo');
    assert(manifest.configuredUrl?.startsWith('https://'));
    const command=spawnSync('ps',['-p',String(manifest.application.pid),'-o','command='],{encoding:'utf8'});
    assert.equal(command.status,0);assert(command.stdout.includes(manifest.application.signature));
    const owners=spawnSync('lsof',['-nP','-iTCP:8085','-sTCP:LISTEN','-t'],{encoding:'utf8'}).stdout.trim().split(/\s+/);
    assert.deepEqual([...new Set(owners)],[String(manifest.application.pid)]);
    const subjects=()=>JSON.parse(sql("SELECT JSON_ARRAYAGG(JSON_OBJECT('id',subject_id,'ref',subject_ref,'name',display_label,'role',role_name,'department',department,'team',team_id,'active',active,'manager',department_manager,'admin',access_admin,'revision',revision)) FROM bnoc_subjects;"));
    const before=subjects();
    const {request}=await import('@playwright/test');
    const login=async subject=>{
      const client=await request.newContext({baseURL:manifest.configuredUrl});
      try{
        const started=await client.get('/api/auth/start');assert.equal(started.status(),200);
        const challenge=(await started.json()).data;
        const issued=await client.post('http://127.0.0.1:8086/identity/issue',{data:{subject,loginAttempt:challenge.loginAttempt,browserBinding:new URL(challenge.providerUrl).searchParams.get('browserBinding')}});assert.equal(issued.status(),200);
        const completed=await client.post('/api/auth/complete',{headers:{Origin:manifest.configuredUrl,'X-CSRF-Token':challenge.csrfToken},data:{ticket:(await issued.json()).ticket,loginAttempt:challenge.loginAttempt}});assert.equal(completed.status(),200);
        return client;
      }catch(error){await client.dispose();throw error;}
    };
    const read=async(client,path)=>{const response=await client.get('/api'+path);assert.equal(response.status(),200,path);return (await response.json()).data;};
    const save=async(client,type,payload,expectedRevision)=>{
      const session=await read(client,'/session');
      const response=await client.post('/api/commands',{headers:{Origin:manifest.configuredUrl,'X-CSRF-Token':session.csrfToken},data:{type,payload,expectedRevision,operationId:randomUUID()}});
      const body=await response.json();assert.equal(response.status(),200,`${type}: ${body.errorCode??'failed'}`);assert.equal(body.ok,true);return body;
    };
    bnoc=await login('bnoc');admin=await login('access-admin');
    assert.equal((await read(bnoc,'/session')).sourceMode,'simulation');
    const originalRoster=await read(bnoc,'/personnel-roster');
    const originalContacts=await read(admin,'/department-contacts');
    await writeFile(join(evidence,'before.json'),JSON.stringify({subjects:before,roster:originalRoster,contacts:originalContacts},null,2)+'\n',{flag:'wx',mode:0o600});
    for(const [id,name] of demoAccounts){
      const actor=before.find(row=>row.id===id);assert(actor,`Known demo account missing: ${id}`);
      if(actor.name===name){report.accounts.push({id,name,changed:false});continue;}
      if(apply){
        const rows=sql(`UPDATE bnoc_subjects SET display_label=${hex(name)},revision=revision+1 WHERE subject_id=${hex(id)} AND subject_ref=${hex(actor.ref)} AND display_label=${hex(actor.name)} AND revision=${Number(actor.revision)} AND role_name=${hex(actor.role)}; SELECT ROW_COUNT();`);
        assert.equal(rows,'1',`Account changed concurrently: ${id}; rerun safely`);
      }
      report.accounts.push({id,name,changed:apply});
    }
    for(const person of demoPersonnel){
      const roster=apply?await read(bnoc,'/personnel-roster'):originalRoster;
      const existing=roster.entries.find(row=>row.serviceNumber===person.serviceNumber);
      if(existing){report.personnelRetained.push(existing.personRef);continue;}
      assert(!roster.entries.some(row=>row.department===person.department&&row.displayName===person.displayName),'Existing name collision; preserve it and choose another fixture');
      assert(roster.categories[person.category].includes(person.rank));
      if(apply){const result=await save(bnoc,'saveCentralPerson',person,roster.revision);report.personnelAdded.push(result.publicRef);}
      else report.personnelAdded.push(person.serviceNumber);
    }
    for(const [index,department] of groups.slice(0,5).map(row=>row[0]).entries()){
      const contact=(await read(admin,'/department-contacts')).items.find(row=>row.department===department);assert(contact,`Department contact row missing: ${department}`);
      if(contact.phone?.trim()){report.contactsRetained.push({department,phone:contact.phone});continue;}
      const phone=`000-${1001+index}`;
      if(apply)await save(admin,'saveDepartmentContact',{department,phone},contact.revision);
      report.contactsChanged.push({department,phone});
    }
    const after=subjects();
    for(const actor of before){
      const next=after.find(row=>row.id===actor.id);assert(next);
      for(const field of ['id','ref','role','department','team','active','manager','admin'])assert.deepEqual(next[field],actor[field]);
      if(apply&&demoAccounts.some(([id])=>id===actor.id))assert.equal(next.name,demoAccounts.find(([id])=>id===actor.id)[1]);
    }
    const roster=await read(bnoc,'/personnel-roster');
    for(const original of originalRoster.entries)assert.deepEqual(roster.entries.find(row=>row.personRef===original.personRef),original);
    if(apply)for(const person of demoPersonnel)assert.equal(roster.entries.filter(row=>row.serviceNumber===person.serviceNumber).length,1);
    report.personnelTotal=roster.entries.length;
    await writeFile(join(evidence,'after.json'),JSON.stringify({subjects:after,roster,contacts:await read(admin,'/department-contacts')},null,2)+'\n',{flag:'wx',mode:0o600});
    requester=await login('requester');assert.equal((await read(requester,'/session')).actor.role,'requester');
    if(apply)assert.equal((await read(requester,'/session')).actor.displayName,'김공군 중위');
  }catch(error){report.errors.push(error.message);process.exitCode=1;}
  finally{
    for(const client of [requester,bnoc,admin])if(client){try{
      const session=await client.get('/api/session');
      if(session.ok()){const data=(await session.json()).data;await client.post('/api/auth/logout',{headers:{Origin:JSON.parse(await readFile(join(root,'.local/bnoc-public/services.json'),'utf8')).configuredUrl,'X-CSRF-Token':data.csrfToken}});}
    }catch{}await client.dispose();}
    await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  console.log(JSON.stringify({mode:report.mode,accounts:report.accounts.length,added:report.personnelAdded.length,retained:report.personnelRetained.length,contacts:report.contactsRetained.length+report.contactsChanged.length,errors:report.errors}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
