import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, firefox } from '@playwright/test';

const root = new URL('../', import.meta.url);
const sourceOption = process.argv.indexOf('--html');
const htmlUrl = sourceOption < 0 ? new URL('아키텍처설계.html', root) : pathToFileURL(resolve(process.argv[sourceOption + 1]));
const html = await readFile(htmlUrl, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'DESIGN_SCRIPT_REQUIRED');
const data = JSON.parse(JSON.stringify(runInNewContext(script.split('// ---------- derived ----------')[0] + ';({SRS,CLASSES,DEPLOY_SRS,EDGE_INFO,DOMAINS:typeof DOMAINS === "undefined"?{}:DOMAINS})')));
const classes = Object.fromEntries(data.CLASSES.map(c => [c.id,c]));
assert.ok(classes.RequestCommands?.methods.some(m => m.sig.startsWith('changePriority(')), 'BNOC_PRIORITY_CORRECTION_REQUIRED');
assert.ok(classes.RequestCommands?.methods.some(m => m.sig.startsWith('addTeams(')), 'TEAM_ADDITION_COMMAND_REQUIRED');
assert.ok(classes.WorkItemCommands?.methods.some(m => m.sig.startsWith('withdrawReturnedWork(')), 'RETURN_WITHDRAWAL_COMMAND_REQUIRED');
for (const id of ['RequestQueryService','OpsQueryService','SharedWorkQueryService']) {
  assert.ok(classes[id]?.depends.includes('RequestStatusCalculator'), `EFFECTIVE_WORK_RULE_MUST_BE_SHARED:${id}`);
}
assert.match(data.SRS['SR-BE-015']?.x ?? '', /유효 작업0개는 완료가 아닌 미배정 대기/, 'EMPTY_WORK_SET_MUST_WAIT');
assert.match(data.SRS['SR-BE-024']?.x ?? '', /지정된 개인.*departmentManager.*소속/, 'DEPARTMENT_MANAGER_MUST_BE_INDIVIDUAL_AND_SCOPED');
assert.match(data.SRS['SR-BE-010']?.pending ?? '', /과거 BNOC 배정 이력과 저장된 general\/urgent가 있어야/, 'TEAM_ADDITION_MUST_NOT_BYPASS_FIRST_ASSIGNMENT');
assert.ok(classes.HistoryAndNotificationQueryService?.methods.some(m => m.sig.startsWith('markNotificationsSeen(') && m.sig.includes('notificationIds')), 'NOTIFICATION_CONFIRMATION_MUST_USE_DISPLAYED_IDS');
assert.match(data.SRS['SR-BE-016']?.x ?? '', /미분류/, 'AFTER_ACTION_MUST_START_UNCLASSIFIED');
assert.ok(classes.PersonnelService?.methods.some(m => /명부/.test(m.plain)), 'DEPARTMENT_ROSTER_CONTRACT_REQUIRED');
assert.ok(classes.DirectiveService?.methods.some(m => m.sig.startsWith('updateDirective(')), 'BNOC_NOTICE_UPDATE_REQUIRED');
assert.equal(classes.ApiController?.domain, 'backend', 'BACKEND_BOUNDARY_REQUIRED');
assert.equal(classes.RequestCommands?.domain, 'backend', 'BUSINESS_RULES_MUST_RUN_ON_SERVER');
assert.equal(classes.TransactionStore?.domain, 'backend', 'PERSISTENCE_MUST_RUN_ON_SERVER');
assert.equal(classes.SituationService?.domain, 'backend', 'GPS_COLLECTION_MUST_RUN_ON_SERVER');
assert.equal(classes.ExternalSituationFeed?.domain, 'external', 'GPS_EXTERNAL_SOURCE_REQUIRED');
assert.ok(data.SRS['SR-BE-035']?.t.includes('CPCON'), 'CPCON_FUNCTION_REQUIRED');
assert.equal(classes.ExternalCpconFeed?.domain, 'external', 'CPCON_SOURCE_REQUIRED');
assert.ok(classes.SituationService.srs.includes('SR-BE-035') && classes.OperationsView.srs.includes('SR-BE-035'), 'CPCON_COLLECTION_AND_DISPLAY_REQUIRED');
assert.equal(classes.DemoIdentityProvider?.domain, 'external', 'DEMO_IDENTITY_PROVIDER_REQUIRED');
assert.equal(classes.DemoSituationFeed?.domain, 'external', 'DEMO_SITUATION_PROVIDER_REQUIRED');
assert.ok(classes.SessionManager.depends.includes('DemoIdentityProvider'), 'DEMO_LOGIN_USES_SERVER_SESSION');
assert.ok(classes.SituationService.depends.includes('DemoSituationFeed'), 'DEMO_FEED_USES_SERVER_COLLECTION');
assert.match(data.SRS['SR-BE-001'].failure, /운영 모드에서는 모의 인증을 거절/, 'NO_DEMO_AUTH_IN_OPERATION');
assert.match(data.SRS['SR-BE-001'].failure, /시작 브라우저 불일치/, 'LOGIN_MUST_BIND_INITIATING_BROWSER');
assert.match(data.SRS['SR-BE-035'].failure, /GPS(?:의)? .*5=양호.*부대 공통.*CPCON에 복사하지 않는다/, 'CPCON_HAS_OWN_STAGE_RULES');
assert.match(classes.SituationService.failure, /GPS와 CPCON.*각각.*실패/, 'INDEPENDENT_SITUATION_RESULTS');
assert.match(classes.SituationService.failure, /시도 전만 미수집.*첫 시도 실패는 성공 값 없음/, 'FIRST_COLLECTION_FAILURE_IS_NOT_UNCOLLECTED');
assert.ok(classes.ApiClient.methods.some(m=>m.sig.startsWith('completeLogin(')) && classes.ApiController.methods.some(m=>m.sig.startsWith('completeLogin(')), 'AUTH_COMPLETION_API_PATH_REQUIRED');
assert.equal(classes.ApiClient?.domain, 'frontend');
assert.match(data.SRS['SR-BE-011'].x, /BNOC.*최초 배정 전 반드시/, 'ASSIGNMENT_CLASSIFICATION_REQUIRED');
assert.match(data.SRS['SR-BE-010'].failure, /미분류.*최초 배정 거절/, 'UNCLASSIFIED_ASSIGNMENT_REJECTED');
assert.match(data.SRS['SR-BE-010'].x, /접수 시간은.*서버가 기록하는 배정 시각/, 'RECEPTION_MEANS_ASSIGNMENT_TIME');
assert.match(data.SRS['SR-BE-010'].x, /반장 지정.*없다/, 'CHIEF_ASSIGNMENT_REMOVED');
assert.match(data.SRS['SR-BE-012'].x, /작업반.*자기 작업.*선택 일정/, 'TEAM_OWNS_OPTIONAL_WORK_SCHEDULE');
assert.match(data.SRS['SR-BE-010'].x, /작업 일정은 작업반이 정하며 희망 일정을 복사하지 않는다/, 'BNOC_MUST_NOT_SET_WORK_SCHEDULE');
assert.match(data.SRS['SR-BE-023'].x, /일반 요청자.*전체 작업 목록.*상세는 기존 권한/, 'SHARED_LIST_MUST_NOT_EXPAND_DETAIL_ACCESS');
assert.match(data.SRS['SR-BE-024'].x, /자기 부서.*휴가·출장·가용.*모든 부서/, 'PERSONNEL_SCOPE_REQUIRED');
assert.match(data.SRS['SR-BE-025'].x, /근무가 없는 부서는 입력하지 않아도/, 'NIGHT_DUTY_SKIP_ALLOWED');
assert.match(data.SRS['SR-BE-026'].x, /외부 자동 수집.*1~5단계.*5단계만 양호/, 'GPS_FEED_DECISION_REQUIRED');
assert.match(data.SRS['SR-BE-027'].x, /공지게시판.*BNOC.*첨부.*게시.*읽음 확인.*없다/, 'BNOC_NOTICE_ATTACHMENTS_REQUIRED');
assert.match(data.SRS['SR-BE-027'].x, /BNOC 계정이면 작성자와 무관하게 수정/, 'ALL_BNOC_MAY_EDIT_NOTICE');
assert.ok(classes.DirectiveService.depends.includes('AttachmentService'), 'NOTICE_ATTACHMENT_BOUNDARY_REQUIRED');
assert.ok(classes.AttachmentService.srs.includes('SR-BE-027'));
assert.ok(!classes.SituationService.methods.some(m => /setGps|saveGps|updateGps|setStage/.test(m.sig)), 'NO_MANUAL_GPS_API');
assert.equal(new Set(data.CLASSES.map(c => c.id)).size, data.CLASSES.length);
for (const c of data.CLASSES) {
  assert.ok(data.DOMAINS[c.domain] && c.resp && c.input && c.output && c.failure && c.methods.length, `MODULE_CONTRACT_REQUIRED:${c.id}`);
  for (const method of c.methods) assert.ok(method.sig.includes(':') && method.plain);
  for (const dependency of c.depends) {
    assert.ok(classes[dependency], `UNKNOWN_DEPENDENCY:${dependency}`);
    const edge = data.EDGE_INFO[c.id + '->' + dependency];
    assert.ok(edge?.label && edge.request && edge.response, `CALL_CONTRACT_REQUIRED:${c.id}->${dependency}`);
    if (c.domain === 'frontend') assert.ok(classes[dependency].domain === 'frontend' || c.id === 'ApiClient' && dependency === 'ApiController', 'FRONTEND_MUST_USE_API_BOUNDARY');
    if (c.domain === 'backend') assert.notEqual(classes[dependency].domain, 'frontend', 'SERVER_MUST_NOT_DEPEND_ON_BROWSER');
  }
  for (const sr of c.srs) assert.ok(data.SRS[sr], `UNKNOWN_REQUIREMENT:${sr}`);
}
const spec = await readFile(new URL('시스템요구사항.md',root),'utf8');
const architecture = await readFile(new URL('아키텍처설계.md',root),'utf8');
const development = await readFile(new URL('개발명세서.md',root),'utf8');
const runtimeCombination = development.match(/^\| 실행 조합 \| (.+?)\. 직접 SQL\/JDBC/m)?.[1];
assert.ok(runtimeCombination, 'TECH_STACK_CONTRACT_REQUIRED');
assert.ok(data.SRS['SR-BE-034'].pending.includes(runtimeCombination), 'TECH_STACK_DRIFT:SR-BE-034');
for (const [id,s] of Object.entries(data.SRS)) {
  const owners = data.CLASSES.filter(c => c.srs.includes(id)).map(c => c.id);
  assert.ok(owners.length, `UNALLOCATED_REQUIREMENT:${id}`);
  assert.deepEqual(owners,s.owners, `OWNER_LIST_DRIFT:${id}`);
  for (const field of ['t','x','input','output','failure','basis','usecase','status','check']) assert.ok(s[field], `${id}:${field}`);
  for (const field of ['t','x','input','output','failure']) assert.ok(spec.includes(s[field]), `SPEC_WEB_DRIFT:${id}:${field}`);
  if (s.pending) assert.ok(spec.includes(s.pending), `SPEC_WEB_DRIFT:${id}:pending`);
  assert.ok(spec.includes(`id="${id.toLowerCase()}"`));
  assert.ok(s.sources.length >= 2, `SOURCE_CHAIN_REQUIRED:${id}`);
  for (const source of s.sources) assert.ok(source.href.endsWith('#current-requirements') || source.href.endsWith('#current-usecases'));
}
for(const c of data.CLASSES) {
  assert.ok(architecture.includes(`id="${c.id.toLowerCase()}"`), `MODULE_DOCUMENT_MISSING:${c.id}`);
  for(const field of ['resp','input','output','failure']) assert.ok(architecture.includes(c[field]),`MODULE_WEB_DRIFT:${c.id}:${field}`);
  if(c.pending) assert.ok(architecture.includes(c.pending),`MODULE_WEB_DRIFT:${c.id}:pending`);
  for(const m of c.methods) {
    assert.ok(architecture.includes(m.sig),`METHOD_WEB_DRIFT:${c.id}`);
    if(m.note) assert.ok(architecture.includes(m.note),`METHOD_CONDITION_DRIFT:${c.id}:${m.sig}`);
  }
}
assert.match(html,/백엔드 서버/);assert.match(html,/설계 0\.8 구현 완료/);assert.doesNotMatch(html,/구현 진행 중|현재 제품은 0\.7/);assert.match(html,/docs\/작업기록\.md#usability-design-20261017/);
assert.ok(!html.includes('id="restoration-note"'));
const evidenceOption = process.argv.indexOf('--evidence-dir');
const evidence = evidenceOption < 0 ? new URL('.local/external-integration-design/',root) : pathToFileURL(resolve(process.argv[evidenceOption + 1]) + '/');
await mkdir(evidence,{recursive:true});
const summary={scope:'design review only; no product/API/SSO/DB execution',requirements:Object.keys(data.SRS).length,modules:data.CLASSES.length,connections:Object.keys(data.EDGE_INFO).length};
if(process.argv.includes('--static')) {
 console.log(JSON.stringify({...summary,static:'passed'}));process.exit(0);
}
if(process.argv.includes('--fault-check')) {
 const initialHash=createHash('sha256').update(html).digest('hex');
 const folder=await mkdtemp(new URL('fault-',evidence));
 const outcomes=[];
 const checkerSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
 try {
  for(const [name,kind,change,expected] of [
   ['server-rule-in-browser','CLASSES',value=>{value.find(c=>c.id==='RequestCommands').domain='frontend';},'BUSINESS_RULES_MUST_RUN_ON_SERVER'],
   ['missing-team-addition','CLASSES',value=>{value.find(c=>c.id==='RequestCommands').methods=value.find(c=>c.id==='RequestCommands').methods.filter(m=>!m.sig.startsWith('addTeams('));},'TEAM_ADDITION_COMMAND_REQUIRED'],
   ['missing-return-withdrawal','CLASSES',value=>{value.find(c=>c.id==='WorkItemCommands').methods=value.find(c=>c.id==='WorkItemCommands').methods.filter(m=>!m.sig.startsWith('withdrawReturnedWork('));},'RETURN_WITHDRAWAL_COMMAND_REQUIRED'],
   ['split-effective-work-rule','CLASSES',value=>{value.find(c=>c.id==='SharedWorkQueryService').depends=value.find(c=>c.id==='SharedWorkQueryService').depends.filter(id=>id!=='RequestStatusCalculator');},'EFFECTIVE_WORK_RULE_MUST_BE_SHARED:SharedWorkQueryService'],
   ['empty-work-set-completion','SRS',value=>{value['SR-BE-015'].x=value['SR-BE-015'].x.replace('유효 작업0개는 완료가 아닌 미배정 대기다.','유효 작업0개는 전체 완료다.');},'EMPTY_WORK_SET_MUST_WAIT'],
   ['unscoped-department-manager','SRS',value=>{value['SR-BE-024'].x=value['SR-BE-024'].x.replace('지정된 개인의 departmentManager와 소속을 함께 검사','BNOC 범용 관리자로 소속 없이 처리');},'DEPARTMENT_MANAGER_MUST_BE_INDIVIDUAL_AND_SCOPED'],
   ['first-assignment-bypass','SRS',value=>{value['SR-BE-010'].pending=value['SR-BE-010'].pending.replace('과거 BNOC 배정 이력과 저장된 general/urgent가 있어야','신규 미배정·분류null이어도');},'TEAM_ADDITION_MUST_NOT_BYPASS_FIRST_ASSIGNMENT'],
   ['notification-cursor-confirms-hidden-items','CLASSES',value=>{const method=value.find(c=>c.id==='HistoryAndNotificationQueryService').methods.find(m=>m.sig.startsWith('markNotificationsSeen('));method.sig=method.sig.replace('notificationIds','throughNotificationId');},'NOTIFICATION_CONFIRMATION_MUST_USE_DISPLAYED_IDS'],
   ['optional-classification','SRS',value=>{value['SR-BE-011'].x=value['SR-BE-011'].x.replace('최초 배정 전 반드시','최초 배정 전 선택적으로');},'ASSIGNMENT_CLASSIFICATION_REQUIRED'],
   ['missing-cpcon','SRS',value=>{delete value['SR-BE-035'];},'CPCON_FUNCTION_REQUIRED'],
   ['demo-auth-in-operation','SRS',value=>{value['SR-BE-001'].failure=value['SR-BE-001'].failure.replace('운영 모드에서는 모의 인증을 거절','운영 모드에서도 모의 인증을 허용');},'NO_DEMO_AUTH_IN_OPERATION'],
   ['missing-priority-correction','CLASSES',value=>{value.find(c=>c.id==='RequestCommands').methods=value.find(c=>c.id==='RequestCommands').methods.filter(m=>!m.sig.startsWith('changePriority('));},'BNOC_PRIORITY_CORRECTION_REQUIRED'],
   ['after-action-auto-classification','SRS',value=>{value['SR-BE-016'].x=value['SR-BE-016'].x.replaceAll('미분류','일반으로 자동 분류');},'AFTER_ACTION_MUST_START_UNCLASSIFIED'],
   ['missing-notice-update','CLASSES',value=>{value.find(c=>c.id==='DirectiveService').methods=value.find(c=>c.id==='DirectiveService').methods.filter(m=>!m.sig.startsWith('updateDirective('));},'BNOC_NOTICE_UPDATE_REQUIRED'],
   ['module-condition-drift','CLASSES',value=>{value.find(c=>c.id==='TransactionStore').pending+=' 잘못된 보존 조건';},'MODULE_WEB_DRIFT:TransactionStore:pending'],
   ['runtime-combination-drift','SRS',value=>{value['SR-BE-034'].pending=value['SR-BE-034'].pending.replace('Gradle 9.3.0','Gradle 9.8');},'TECH_STACK_DRIFT:SR-BE-034']
  ]){
   const value=structuredClone(data[kind]);change(value);
   const begin=html.indexOf('const '+kind+' = '),end=html.indexOf('\nconst ',begin+1);
   assert.ok(begin>0 && end>begin);
   const mutated=html.slice(0,begin)+'const '+kind+' = '+JSON.stringify(value,null,2)+';'+html.slice(end);
   const path=resolve(folder,name+'.html');await writeFile(path,mutated);
   const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--static','--html',path],{encoding:'utf8'});
   assert.equal(result.status,1);assert.ok(result.stderr.includes(expected), result.stderr);
   const diff=spawnSync('git',['diff','--no-index','--',fileURLToPath(htmlUrl),path],{encoding:'utf8'});
   assert.equal(diff.status,1);assert.ok(diff.stdout.includes('@@'));
   outcomes.push({name,expectedAssertion:expected,exitCode:result.status,detected:true,mutationDiff:diff.stdout,mutatedHtmlSha256:createHash('sha256').update(mutated).digest('hex')});
  }
 } finally {await rm(folder,{recursive:true,force:true});}
 assert.equal(createHash('sha256').update(await readFile(htmlUrl)).digest('hex'),initialHash);
 await writeFile(new URL('fault-check.json',evidence),JSON.stringify({...summary,normalStaticPassed:true,checkerSha256,originalHtmlSha256:initialHash,outcomes,originalUnchanged:true,temporaryCopiesRemoved:true,limit:'Tests detect defects in the design description, not runtime authorization.'},null,2)+'\n');
 console.log(`${outcomes.length} isolated design faults rejected at intended assertions; original unchanged.`);process.exit(0);
}
const results=[];
for(const [name,engine] of [['chromium',chromium],['firefox',firefox]]) {
 const browser=await engine.launch();
 try {
  for(const width of [1280,1440]) {
   const page=await browser.newPage({viewport:{width,height:1000},colorScheme:'light'});
   const errors=[],external=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});
   await page.goto(htmlUrl.href);
   assert.equal(await page.locator('.node').count(),data.CLASSES.length);
   assert.match(await page.locator('#panel').innerText(),/서버 API 진입점/);
   for(const [id,pattern] of [['SR-BE-010',/반장 지정.*없다/],['SR-BE-011',/최초 배정 전 반드시/],['SR-BE-024',/휴가·출장·가용/],['SR-BE-025',/입력하지 않아도/],['SR-BE-026',/외부 자동 수집/],['SR-BE-027',/BNOC.*첨부.*게시/s]]) {
    await page.locator('#sr-select').selectOption(id);
    assert.match(await page.locator('#sr-context').innerText(),pattern);
    assert.equal(await page.locator('.node.sr-hl').count(),data.SRS[id].owners.length);
    assert.ok(await page.locator('#sr-context a').count()>=3);
   }
   await page.locator('#sr-context [data-jump="DirectiveService"]').click();
   assert.match(await page.locator('#panel').innerText(),/BNOC 공지게시판 처리/);
   await page.locator('#panel [data-jump="AttachmentService"]').click();
   assert.match(await page.locator('#panel').innerText(),/request\/notice/);
   assert.match(await page.locator('#panel').innerText(),/해당 요청\/공지 권한/);
   await page.locator('#sr-select').selectOption('SR-BE-035');
   assert.match(await page.locator('#sr-context').innerText(),/CPCON.*GPS와 별도/s);
   assert.equal(await page.locator('.node.sr-hl').count(),data.SRS['SR-BE-035'].owners.length);
   await page.locator('#sr-context [data-jump="SituationService"]').click();
   assert.match(await page.locator('#panel').innerText(),/collectCpcon/);
   await page.locator('#panel [data-jump="DemoSituationFeed"]').click();
   assert.match(await page.locator('#panel').innerText(),/GPS와 CPCON을 독립 제어/);
   await page.locator('#module-select').selectOption('SessionManager');
   await page.locator('#panel [data-jump="DemoIdentityProvider"]').click();
   assert.match(await page.locator('#panel').innerText(),/verifyAndConsume/);
   assert.match(await page.locator('#integration-note').innerText(),/모의 서버.*CPCON.*후속 전환/s);
   await page.locator('#module-select').selectOption('RequestCommands');
   assert.equal(await page.locator('#panel .method').count(),classes.RequestCommands.methods.length);
   assert.match(await page.locator('#panel').innerText(),/assignTeams/);
   await page.locator('#panel [data-jump="AccessPolicy"]').click();
   assert.match(await page.locator('#panel').innerText(),/서버 권한 판정/);
   await page.locator('#sr-clear').click();
   assert.equal(await page.locator('.node.sr-hl').count(),0);
   await page.locator('#module-select').selectOption('TransactionStore');
   await page.locator('#n-TransactionStore').focus();await page.keyboard.press('Enter');
   assert.match(await page.locator('#panel').innerText(),/트랜잭션·영구 저장/);
   await page.locator('#n-TransactionStore').focus();await page.keyboard.press('Space');
   assert.match(await page.locator('#panel').innerText(),/TransactionStore/);
   await page.locator('.boundaries button[data-domain="frontend"]').click();
   assert.equal(await page.locator('#module-select').inputValue(),'ApiClient');
   await page.locator('.boundaries button[data-domain="backend"]').click();
   assert.equal(await page.locator('#module-select').inputValue(),'ApiController');
   const oldZoom=await page.locator('#zoom-label').innerText();
   await page.locator('#zoom-in').click();assert.notEqual(await page.locator('#zoom-label').innerText(),oldZoom);
   await page.locator('#zoom-out').click();assert.equal(await page.locator('#zoom-label').innerText(),oldZoom);
   await page.locator('#zoom-fit').click();
   const fitZoom=await page.locator('#zoom-label').innerText();const bounds=await page.locator('#map-scroll').boundingBox();
   await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,-120);
   await page.waitForFunction(previous=>document.querySelector('#zoom-label').textContent!==previous,fitZoom);
   await page.locator('#zoom-in').click();await page.locator('#zoom-in').click();
   await page.locator('#map-scroll').evaluate(m=>{m.scrollLeft=60;m.scrollTop=60;});
   const before=await page.locator('#map-scroll').evaluate(m=>({x:m.scrollLeft,y:m.scrollTop}));
   await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2-40,bounds.y+bounds.height/2-60,{steps:5});await page.mouse.up();
   const after=await page.locator('#map-scroll').evaluate(m=>({x:m.scrollLeft,y:m.scrollTop}));assert.ok(before.x!==after.x||before.y!==after.y);
   await page.goto(htmlUrl.href+'#sr=SR-BE-026');await page.reload();
   assert.equal(await page.locator('#sr-select').inputValue(),'SR-BE-026');
   assert.match(await page.locator('#sr-context').innerText(),/5단계만 양호/);
   await page.goto(htmlUrl.href+'#module=ApiClient');await page.reload();
   assert.equal(await page.locator('#module-select').inputValue(),'ApiClient');
   assert.match(await page.locator('#panel').innerText(),/HTTPS/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:fileURLToPath(new URL(`${name}-${width}.png`,evidence)),fullPage:true});
   if(width===1440){await page.locator('#sr-select').selectOption('SR-BE-027');await page.screenshot({path:fileURLToPath(new URL('notice-review.png',evidence)),fullPage:true});}
   await page.goto(htmlUrl.href+'#sr=SR-BE-035');await page.reload();
   assert.equal(await page.locator('#sr-select').inputValue(),'SR-BE-035');
   assert.match(await page.locator('#sr-context').innerText(),/CPCONⅠ급~Ⅴ급/);
   assert.match(await page.locator('#sr-context').innerText(),/모든 로그인/);
   assert.match(await page.locator('#sr-context').innerText(),/GPS 5=양호.*CPCON에 복사하지 않는다/);
   await page.locator('#sr-context [data-jump="DemoSituationFeed"]').click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:fileURLToPath(new URL(`integration-${name}-${width}.png`,evidence)),fullPage:true});
   await page.goto(htmlUrl.href+'#module=DemoIdentityProvider');await page.reload();
   assert.equal(await page.locator('#module-select').inputValue(),'DemoIdentityProvider');
   assert.deepEqual(errors,[]);assert.ok(external.every(url=>url.startsWith('https://fonts.googleapis.com/')));
   results.push({browser:name,width,interactions:'passed',pageErrors:0,pageOverflow:false,optionalFontRequestsBlocked:external.length});await page.close();
  }
 } finally {await browser.close();}
}
await writeFile(new URL('browser-results.json',evidence),JSON.stringify({...summary,results},null,2)+'\n');
console.log('4 PC browser/width combinations passed; design boundaries and functional allocation are navigable.');
