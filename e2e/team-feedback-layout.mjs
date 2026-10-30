// Product UI with isolated memory API responses; no existing service or DB access.
import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { testActor, teamIds } from './survey-test-session.mjs';

assert(process.env.BNOC_TEAM_FEEDBACK_EVIDENCE_DIR, 'Set a fresh evidence directory');
const evidence=resolve(process.env.BNOC_TEAM_FEEDBACK_EVIDENCE_DIR);
await mkdir(evidence,{recursive:false,mode:0o700});
const returnOnly=process.argv.includes('--return-only');
const report={checks:[],failures:[],metrics:[],pageErrors:[],unexpected:[],queries:[],commands:[],external:[]};
const at='2026-10-29T01:00:00.000Z';
const sample='컴퓨터 고장 1대 / 행정실 / 증상을 잘 모르겠어요\n전화기 고장 1대 / 회의실 / 통화가 안 돼요';
const requests=Array.from({length:23},(_,index)=>({requestNumber:String(120-index),requesterDisplayText:'요청자',category:'장비/체계',status:'대기',teamIds:[],updatedAt:at,canReuse:true,detailPreview:index===0?sample:`컴퓨터 고장 1대 / ${index+1}층 / 전원이 안 켜져요`,location:'행정실'}));
const works=[
 {teamId:teamIds[0],status:'완료'}, {teamId:teamIds[0],status:'반환'},
 {teamId:teamIds[1],status:'배정'}, {teamId:teamIds[2],status:'작업 중'},
 {teamId:teamIds[3],status:'배정'}, {teamId:teamIds[4],status:'완료'}
].map((item,index)=>({...item,requestNumber:String(300+index),workNumber:`${300+index}-1`,category:'장비/체계',workType:'고장',source:'assigned',origin:'assigned',canOpenDetail:true,priority:'general',requesterContact:'000-1001',scheduleIntervals:[]}));
const plans=[{teamId:teamIds[0],status:'진행 중'},{teamId:teamIds[2],status:'완료'}].map((item,index)=>({...item,source:'planned',plannedWorkId:`plan-${index}`,title:'계획 점검',firstWorkDate:'2026-10-28'}));
const gps={kind:'gps',stageCode:5,stageLabel:'5단계',collectionState:'ok',scopeKey:'unit',sourceMode:'simulation'};
const cpcon={kind:'cpcon',stageCode:5,collectionState:'ok',scopeKey:'source',sourceMode:'simulation'};
let server,base;
async function check(name,action) {try{await action();report.checks.push(name);}catch(error){report.failures.push({name,message:error.message});}}
async function install(context,role) {
 const actor=testActor(role);
 let rejected=false;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(url.origin!==base){report.external.push(request.url());return route.abort();}
  if(!path.startsWith('/api/'))return route.continue();
  let data;
  if(request.method()!=='GET') {
   const body=request.postDataJSON();report.commands.push({path,body});
   if(path==='/api/commands'&&body.type==='markNotificationsSeen')return route.fulfill({json:{ok:true}});
   if(path==='/api/commands'&&body.type==='rejectRequest'&&body.requestNumber==='300') {rejected=true;return route.fulfill({json:{ok:true,requestNumber:'300',revision:2,status:'기각'}});}
   report.unexpected.push(`${request.method()} ${path}`);return route.abort();
  }
  if(path==='/api/session')data={actor,teams:teamIds,departments:['BNOC',...teamIds],csrfToken:'test'};
  else if(path==='/api/notifications/unseen')data={unseen:0};
  else if(path==='/api/situation')data={gps,cpcon};
  else if(path==='/api/situation/gps')data=gps;
  else if(path==='/api/situation/cpcon')data=cpcon;
  else if(path==='/api/request-draft')data={revision:0,draft:null};
  else if(path==='/api/requesters')data={items:[{requesterRef:'requester',displayName:'요청자',department:'요청 부서'}]};
  else if(path==='/api/requests') {
   const page=Number(url.searchParams.get('page')||0),size=Number(url.searchParams.get('size')||20);
   report.queries.push({path,...Object.fromEntries(url.searchParams)});
   data={items:requests.slice(page*size,page*size+size),total:requests.length,page,size};
  } else if(path==='/api/requests/300')data={requestNumber:'300',requesterDisplayText:'요청자',teamIds:rejected?[]:[teamIds[0]],category:'장비/체계',subcategories:{resourceType:'PC',workType:'고장'},detail:'담당 범위 확인',location:'행정실',contact:'1234',status:rejected?'기각':'대기',registeredBy:'요청자',registeredAt:at,updatedAt:at,revision:rejected?2:1,schedulePreferences:[],attachments:[],history:[],canReject:!rejected,rejectionReason:rejected?'부대 담당 업무가 아닙니다.':null,workItems:[{workNumber:'300-1',teamId:teamIds[0],status:'반환',origin:'assigned',scheduleIntervals:[],previousScheduleIntervals:[],returnReason:'담당 업무 아님',revision:1,resolved:rejected,resolutionKind:rejected?'withdrawn':'open',resolutionReason:rejected?'요청 기각':undefined}]};
  else if(path==='/api/requests/300/history')data={items:[],total:0};
  else if(path==='/api/work-overview') {
   const selected=url.searchParams.get('teamIds')?.split(',').filter(Boolean)||[];
   const status=url.searchParams.get('status'),bucket=url.searchParams.get('bucket')||'assigned';
   const filtered=[...works,...plans].filter(item=>(!selected.length||selected.includes(item.teamId))&&(!status||item.status===status));
   const assigned=filtered.filter(item=>item.source==='assigned'),planned=filtered.filter(item=>item.source==='planned');
   const completed=assigned.filter(item=>item.status==='완료').length,remaining=assigned.length-completed;
   const plannedCompleted=planned.filter(item=>item.status==='완료').length,plannedInProgress=planned.length-plannedCompleted;
   const counts={assigned:assigned.length,completed,remaining,returned:assigned.filter(item=>item.status==='반환').length,unassigned:0,planned:planned.length,plannedCompleted,plannedInProgress,all:filtered.length,allCompleted:completed+plannedCompleted,allRemaining:remaining+plannedInProgress};
   const departments=teamIds.filter(team=>!selected.length||selected.includes(team));
   const byDepartment=departments.map(department=>{
    const entries=filtered.filter(item=>item.teamId===department),assignedRows=entries.filter(item=>item.source==='assigned'),plannedRows=entries.filter(item=>item.source==='planned');
    return {department,assigned:assignedRows.length,completed:assignedRows.filter(item=>item.status==='완료').length,remaining:assignedRows.filter(item=>item.status!=='완료').length,returned:assignedRows.filter(item=>item.status==='반환').length,planned:plannedRows.length,plannedCompleted:plannedRows.filter(item=>item.status==='완료').length,plannedInProgress:plannedRows.filter(item=>item.status!=='완료').length,all:entries.length,allCompleted:entries.filter(item=>item.status==='완료').length,allRemaining:entries.filter(item=>item.status!=='완료').length};
   });
   const rows=bucket==='all'?filtered:bucket==='planned'?planned:bucket==='returned'?assigned.filter(item=>item.status==='반환'):assigned;
   const page=Number(url.searchParams.get('page')||0),size=Number(url.searchParams.get('size')||20);
   report.queries.push({path,...Object.fromEntries(url.searchParams)});
   data={counts,byDepartment,items:rows.slice(page*size,page*size+size),total:rows.length,page,size};
  } else if(path==='/api/notifications')data={items:[{notificationId:'notice-1',event:'작업 반환',relatedRequestId:'300',at,read:true,summary:sample.replaceAll('\n',' ')}],total:1};
  else {report.unexpected.push(path);return route.fulfill({status:404,json:{errorCode:'NOT_FOUND'}});}
  return route.fulfill({json:{data,queriedAt:at}});
 });
}
async function centered(page,selector,label) {
 const metrics=await page.locator(selector).evaluate(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:document.documentElement.clientWidth-box.right,width:box.width,viewport:document.documentElement.clientWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};});
 report.metrics.push({label,selector,...metrics});
 assert(Math.abs(metrics.left-metrics.right)<=2,`${selector} margins ${metrics.left}/${metrics.right}`);
 assert.equal(metrics.overflow,false,'horizontal overflow');
}
try {
 server=await createServer({root:resolve('frontend'),cacheDir:resolve(evidence,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null},logLevel:'error'});
 await server.listen();base=`http://127.0.0.1:${server.httpServer.address().port}`;
 for(const [engineName,engine] of Object.entries({chromium,firefox})) {
  const browser=await engine.launch();
  try {
   for(const width of (returnOnly?[]:[1280,1440,1920,2560])) {
    const label=`${engineName}-${width}`,context=await browser.newContext({viewport:{width,height:1000},locale:'ko-KR',serviceWorkers:'block'});
    try {
     const page=await context.newPage();page.setDefaultTimeout(4000);page.on('pageerror',error=>report.pageErrors.push({label,message:error.message}));
     await install(context,'requester');await page.goto(`${base}/requests`);await expect(page.locator('.request-ledger tbody tr')).toHaveCount(10);
     await check(`${label}: ten request rows and aligned summary`,async()=>{
      await expect(page.locator('.pagination')).toContainText('신청 120~111');
      assert.equal(await page.locator('.request-list-summary').first().innerText(),sample);
      assert.equal(await page.locator('.request-list-summary').first().evaluate(element=>getComputedStyle(element).whiteSpace),'pre-line');
      assert.equal(await page.locator('.request-ledger td').nth(1).evaluate(element=>getComputedStyle(element).verticalAlign),'middle');
      await expect(page.getByRole('button',{name:'신청 120 내용 불러오기'})).toBeVisible();await centered(page,'main',label);
     });
     await check(`${label}: next previous boundaries retain search`,async()=>{
      await page.getByLabel('내용·문서 검색',{exact:true}).fill('고장');await page.getByRole('button',{name:'검색',exact:true}).click();
      await expect(page.locator('.pagination')).toContainText('신청 120~111');
      await page.getByRole('button',{name:'다음 페이지',exact:true}).click();await expect(page.locator('.pagination')).toContainText('신청 110~101');
      await expect(page.getByLabel('내용·문서 검색',{exact:true})).toHaveValue('고장');
      await page.getByRole('button',{name:'다음 페이지',exact:true}).click();await expect(page.locator('.request-ledger tbody tr')).toHaveCount(3);await expect(page.locator('.pagination')).toContainText('신청 100~98');await expect(page.getByRole('button',{name:'다음 페이지',exact:true})).toBeDisabled();
      await page.getByRole('button',{name:'이전 페이지',exact:true}).click();await expect(page.locator('.request-ledger tbody tr')).toHaveCount(10);await expect(page.locator('.pagination')).toContainText('신청 110~101');
     });
     if(width===1440||width===2560)await page.screenshot({path:resolve(evidence,`${label}-requests.png`),fullPage:true});
     await page.goto(`${base}/new`);await expect(page.locator('.guided-intake')).toBeVisible();
     await check(`${label}: centered compact request form`,async()=>{await centered(page,'main',label);await centered(page,'.guided-intake',label);const height=await page.locator('.intake-question').evaluate(element=>element.getBoundingClientRect().height);report.metrics.push({label,questionHeight:height});assert(height<300,`question leaves excessive space: ${height}`);});
     if(width===1440||width===2560)await page.screenshot({path:resolve(evidence,`${label}-request-form.png`),fullPage:true});
     if(width===1440) {
      await page.evaluate(()=>{window.__popupCalls=[];const open=window.open;window.open=function(...args){window.__popupCalls.push(args);return open.apply(this,args);};});
      for(const kind of ['GPS','CPCON'])await check(`${label}: compact ${kind} popup`,async()=>{
       const pending=page.waitForEvent('popup');await page.getByRole('button',{name:new RegExp(`^${kind} `)}).click();const popup=await pending;await popup.waitForLoadState('domcontentloaded');await expect(popup.locator('#situation-card')).toBeVisible();
       const call=await page.evaluate(()=>window.__popupCalls.at(-1));assert(call[2].includes('width=720,height=600'));
       const metrics=await popup.locator('.situation-site').evaluate(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:innerWidth-box.right,width:box.width,padding:getComputedStyle(element).padding,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};});report.metrics.push({label,kind,...metrics});assert(metrics.left<=24&&metrics.right<=24,`popup margins ${metrics.left}/${metrics.right}`);assert.equal(metrics.overflow,false);await popup.screenshot({path:resolve(evidence,`${label}-${kind.toLowerCase()}.png`),fullPage:true});await popup.close();
      });
     }
    }finally{await context.close();}
   }
   const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',serviceWorkers:'block'});
   try {
    const page=await context.newPage();page.setDefaultTimeout(4000);page.on('pageerror',error=>report.pageErrors.push({label:engineName,message:error.message}));await install(context,'bnoc');if(!returnOnly){await page.goto(`${base}/operations`);await expect(page.getByRole('img',{name:'무선반 남음 2건, 완료 1건'})).toBeVisible();
    await check(`${engineName}: selected department union and chart`,async()=>{
     const departments=page.getByRole('group',{name:'부서 선택'});await departments.getByLabel(teamIds[0],{exact:true}).check();await departments.getByLabel(teamIds[2],{exact:true}).check();await page.getByRole('button',{name:'검색',exact:true}).click();
     await expect(page.locator('.department-chart-row')).toHaveCount(2);await expect(page.locator('.department-overview')).toHaveCount(2);
     await expect(page.locator('main')).not.toContainText('포함 내역');await expect(page.locator('main')).not.toContainText('반환 1건 포함');
     assert((await page.locator('.shared-work-detail tbody tr td:nth-child(2)').allTextContents()).every(value=>[teamIds[0],teamIds[2]].includes(value)));
     await page.getByRole('combobox',{name:/목록 종류/}).selectOption('all');await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(5);await centered(page,'main',engineName);
    });await page.screenshot({path:resolve(evidence,`${engineName}-overview.png`),fullPage:true});
    await page.goto(`${base}/notifications`);await expect(page.locator('.notification-summary')).toHaveText(sample.replaceAll('\n',' '));
    await check(`${engineName}: event with one line work context`,async()=>{await expect(page.locator('.notification')).toContainText('작업 반환');assert.equal(await page.locator('.notification-summary').evaluate(element=>getComputedStyle(element).whiteSpace),'nowrap');await centered(page,'main',engineName);});await page.screenshot({path:resolve(evidence,`${engineName}-notifications.png`),fullPage:true});}
    await page.goto(`${base}/requests/300`);
    await check(`${engineName}: reject directly after department return`,async()=>{
     const reject=page.getByRole('button',{name:'요청 기각',exact:true});await expect(reject).toBeVisible();await expect(reject).toBeDisabled();
     await expect(page.getByText('반환된 배정도 함께 해제합니다. 반환 사유와 작업 이력은 보존됩니다.',{exact:true})).toBeVisible();
     await page.getByRole('textbox',{name:'기각 사유',exact:true}).fill('부대 담당 업무가 아닙니다.');await reject.click();
     await expect(page.getByRole('button',{name:'요청 기각',exact:true})).toHaveCount(0);await expect(page.getByText('부대 담당 업무가 아닙니다.',{exact:true})).toBeVisible();
     await expect(page.locator('.work-card')).toContainText('반환된 부서 배정 해제 · 요청 기각');
     const command=report.commands.at(-1).body;assert.equal(command.type,'rejectRequest');assert.equal(command.expectedRevision,1);assert.equal(command.payload.reason,'부대 담당 업무가 아닙니다.');
    });await page.screenshot({path:resolve(evidence,`${engineName}-rejected-return.png`),fullPage:true});
   }finally{await context.close();}
  }finally{await browser.close();}
 }
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.unexpected,[]);assert.deepEqual(report.external,[]);
 assert(report.queries.filter(item=>item.path==='/api/requests').every(item=>item.size==='10'),'request pages must request ten rows');
}catch(error){report.failures.push({name:'runner',message:error.stack});}
finally{if(server)await server.close();await rm(resolve(evidence,'vite-cache'),{recursive:true,force:true});await writeFile(resolve(evidence,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({checks:report.checks.length,failures:report.failures,pageErrors:report.pageErrors.length,unexpected:report.unexpected.length,evidence},null,2));
if(report.failures.length)process.exitCode=1;
