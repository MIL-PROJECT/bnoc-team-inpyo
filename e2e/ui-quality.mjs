import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTestSession, teamIds } from './survey-test-session.mjs';
const before=process.argv.includes('--before');
const base=process.env.BNOC_QUALITY_URL||'http://127.0.0.1:5178';
const evidence=`${process.env.BNOC_QUALITY_EVIDENCE_DIR||'runtime/evidence/ui-quality-20261027'}/${before?'before':'after'}`;
await mkdir(evidence,{recursive:true});
const report={before,checks:[],measurements:[],errors:[]};
const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),at=new Date().toISOString();
const people=['이병','병장','중사','준위','소위','대령'].map((rank,i)=>({personRef:`quality-${i}`,displayName:`인원 ${String.fromCharCode(65+i)}`,category:i<2?'병':'간부',rank,department:teamIds[0],serviceNumber:`TEST-${i}`,internalPhone:'0000',active:true,complete:true,absences:i===0?[{absenceRef:'absence-0',absenceType:'휴가',startDate:today,endDate:today,revision:1}]:[]}));
const summaries=Array.from({length:8},(_,i)=>({requestNumber:`REQ-QUALITY-${i}`,requesterDisplayText:'요청자',category:'장비/체계',status:i%2?'배정':'대기',teamIds:i%2?[teamIds[i%5]]:[],updatedAt:at,progress:{currentDepartments:i%2?1:0,completedDepartments:0,totalWorks:i%2?1:0,completedWorks:0,returnedWorks:0,hadAssignment:!!(i%2),departments:[]}}));
const departmentRows=teamIds.map((department,i)=>({department,assigned:8+i,completed:3+i,remaining:5,returned:i===0?1:0,afterAction:1,planned:3,plannedInProgress:2,plannedCompleted:1,all:11+i,allCompleted:4+i,allRemaining:7}));
const counts={assigned:50,completed:25,remaining:25,returned:1,unassigned:4,'after-action':5,planned:15,plannedCompleted:5,plannedInProgress:10,all:65,allCompleted:30,allRemaining:35};
const works=teamIds.flatMap((teamId,i)=>Array.from({length:3},(_,j)=>({workNumber:`WRK-QUALITY-${i}-${j}`,requestNumber:`REQ-QUALITY-${i}`,teamId,category:'장비/체계',workType:'지원',status:j===0?'완료':j===1?'배정':'반환',source:'assigned',priority:'general',requesterContact:'0000',canOpenDetail:true,scheduleIntervals:[{startsAt:`${today}T09:00:00+09:00`,endsAt:`${today}T11:00:00+09:00`}]})));
async function install(page){
 await page.route(url=>url.pathname.startsWith('/api/'),async(route,fallback)=>{
  const url=new URL(route.request().url()),p=url.pathname;let data;
  if(p==='/api/situation')data={gps:{kind:'gps',stageCode:3,stageLabel:'Ⅲ급',collectionState:'ok',sourceMode:'test'},cpcon:{kind:'cpcon',stageCode:3,collectionState:'ok',sourceMode:'test'}};
  else if(p==='/api/situation/gps'||p==='/api/situation/cpcon')data={kind:p.endsWith('/gps')?'gps':'cpcon',stageCode:3,stageLabel:'Ⅲ급',collectionState:'ok',scopeKey:p.endsWith('/gps')?'unit':'source',sourceMode:'simulation'};
  else if(p==='/api/operations/status')data={collectionState:'ok',items:[{itemId:'posture',kind:'posture',displayName:'태세',stageCode:'3'}],groups:['통신시설','체계','네트워크'].map(groupId=>({groupId,items:[{itemId:groupId+'-a',displayName:groupId+' A',health:'normal'},{itemId:groupId+'-b',displayName:groupId+' B',health:'normal'}]}))};
  else if(p==='/api/personnel-roster')data={entries:people,revision:1};
  else if(p==='/api/personnel')data={total:6,current:5,absent:1,departments:[{department:teamIds[0],total:6,current:5,absent:1,byAbsenceType:{휴가:1}}]};
  else if(p==='/api/duty-schedules')data={entries:[{date:today,seat:'duty_officer',scopeKey:'',revision:1,people:[people[4]]},{date:today,seat:'team_night',scopeKey:teamIds[0],revision:1,people:[people[1]]}]};
  else if(p==='/api/work-overview'){const team=url.searchParams.get('teamId'),bucket=url.searchParams.get('bucket');let items=bucket==='unassigned'?summaries.filter(request=>request.status==='대기'&&!request.teamIds.length):works.filter(w=>!team||w.teamId===team);if(bucket==='completed')items=items.filter(w=>w.status==='완료');else if(bucket==='remaining')items=items.filter(w=>w.status!=='완료');else if(bucket==='returned')items=items.filter(w=>w.status==='반환');data={counts,byDepartment:departmentRows.filter(row=>!team||row.department===team),items,total:items.length};}
  else if(p==='/api/requests/REQ-QUALITY-0')data={...summaries[0],status:'배정',teamIds:[teamIds[0]],registeredAt:at,registeredBy:'requester',revision:1,detail:'확인이 필요한 작업 설명입니다. '.repeat(30),location:'점검 위치',contact:'0000',schedulePreferences:[],subcategories:{systemType:'인터넷'},attachments:[],history:[],workItems:[{...works[1],resolved:false,previousScheduleIntervals:[],revision:1,editable:true}]};
  else if(p==='/api/requests/REQ-QUALITY-0/history')data={items:[],total:0};
  else if(p==='/api/requests')data={items:summaries,total:summaries.length};
  else if(p==='/api/overview')data={total:8,byStatus:{대기:4,배정:4},list:summaries};
  else if(p==='/api/schedule')data={entries:works.slice(0,3).map(w=>({...w,request:{requestNumber:w.requestNumber},location:'점검 위치',origin:'assigned'})),completedRecords:[],unscheduled:[],plans:[]};
  else if(p==='/api/notices')data={items:[{noticeRef:'quality-notice',title:'업무 안내',body:'안내 내용',createdAt:at,updatedAt:at,createdBy:'BNOC',revision:1,attachments:[]}],total:1};
  else if(p==='/api/notifications')data={items:[],total:0};
  else if(p==='/api/planned-works')data={workDate:today,inProgress:[{id:'plan',plannedWorkId:'plan',title:'체계 점검',teamId:teamIds[0],department:teamIds[0],firstWorkDate:today,status:'진행 중',revision:1}],completed:[]};
  else if(p==='/api/request-draft')data={revision:0,draft:null};
  else if(p==='/api/requesters')data={items:[{requesterRef:'requester',displayName:'요청자',department:'요청 부서'}],total:1};
  else if(p==='/api/notices/quality-notice')data={noticeRef:'quality-notice',title:'업무 안내',body:'안내 내용',createdAt:at,updatedAt:at,createdBy:'BNOC',revision:1,attachments:[]};
  else return route.fallback();
  return route.fulfill({json:{data,queriedAt:at}});
 });
}
for(const [name,engine]of Object.entries({chromium,firefox})){
 const browser=await engine.launch();
 try{
  const page=await browser.newPage({locale:'ko-KR'});page.setDefaultTimeout(10000);
  page.on('pageerror',e=>report.errors.push(`${name}: ${e.message}`));
  page.on('console',message=>{if(message.type()==='error'&&/Encountered two children|unique "key" prop/.test(message.text()))report.errors.push(`${name}: ${message.text()}`);});
  await setTestSession(page,'bnoc');await install(page);
  const screens=[['bnoc','operations-status'],['bnoc','personnel'],['bnoc','roster'],['team','schedule'],['bnoc','operations'],['bnoc','overview'],['requester','requests'],['team','planned-maintenance'],['bnoc','notices'],['requester','night-duty'],['bnoc','notifications'],['admin','access'],['bnoc','requests/REQ-QUALITY-0'],['requester','new'],['bnoc','new'],['team','after-action'],['bnoc','notices/new'],['bnoc','notices/quality-notice'],['bnoc','external-systems/gps/index.html'],['bnoc','external-systems/cpcon/index.html']];
  for(const [width,height]of [[1366,768],[1440,900],[1280,768]]){
   await page.setViewportSize({width,height});
   for(const [role,path]of screens){
    await setTestSession(page,role);await page.goto(`${base}/${path}`);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main').getByText('불러오는 중…',{exact:true})).toHaveCount(0);
    if(path==='new')await expect(page.getByText('임시저장 상태를 확인하는 중…',{exact:true})).toHaveCount(0);
    if(path.startsWith('external-systems/'))await expect(page.locator('#situation-card')).toBeVisible();
    const measure=await page.locator('main').evaluate(main=>{const firstControl=[...main.querySelectorAll('button,input,select,textarea')].find(node=>node.getClientRects().length);return {headingTop:Math.round(main.querySelector('h1').getBoundingClientRect().top),firstControlTop:firstControl?Math.round(firstControl.getBoundingClientRect().top):null,pageHeight:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth,firstTable:main.querySelector('table')?Math.round(main.querySelector('table').getBoundingClientRect().top):null,nestedScroll:[...main.querySelectorAll('*')].filter(n=>['scroll','auto'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1).length};});
    report.measurements.push({name,role,path,width,height,...measure});
    assert.equal(measure.overflow,false,`${path} ${width}: overflow`);
    assert(measure.headingTop>=0&&measure.headingTop<height/2,`${path}: heading must be in the first viewport`);
    if(measure.firstControlTop!==null)assert(measure.firstControlTop>=0&&measure.firstControlTop<height,`${path}: initial control must be in the first viewport`);
    if(!before){
     assert(!/\d+\/\d+ 정상|부재 없음|조회 선택:|조회 결과 · 조건:/.test(await page.locator('main').innerText()),`${path}: removed filler`);
     if(path==='roster'||path==='personnel')assert.deepEqual(await page.locator('tbody[aria-label] th[scope=rowgroup]').allTextContents(),['간부 4명','병 2명']);
     if(path==='operations') {assert(measure.firstTable<350,'department comparison must be first');assert.equal(await page.locator('.department-comparison tbody tr').count(),5);assert(measure.nestedScroll===0,'overview nested scroll');}
    }
    if(['operations-status','personnel','schedule','operations','overview','night-duty'].includes(path))await page.screenshot({path:`${evidence}/${name}-${width}-${path.replaceAll('/','-')}.png`});
    if(['new','after-action','notices/new','notices/quality-notice'].includes(path)&&width!==1280)await page.screenshot({path:`${evidence}/${name}-${width}-${role}-${path.replaceAll('/','-')}.png`});
   }
  }
  if(!before){
   await setTestSession(page,'bnoc');await page.goto(`${base}/requests/REQ-QUALITY-0`);
   const content=page.locator('.request-long-content');await expect(content).toBeVisible();await content.locator('summary').focus();await page.keyboard.press('Enter');await expect(content.locator('p')).toContainText('확인이 필요한 작업 설명');
   assert(!/첨부 없음|희망 일정.*없음/.test(await page.locator('main').innerText()));
   report.checks.push(`${name}: long request description expands by keyboard and empty metadata omitted`);
   await setTestSession(page,'team');await page.goto(`${base}/requests/REQ-QUALITY-0`);await expect(page.locator('.assigned-person-group h4')).toHaveCount(2);
   assert.deepEqual(await page.locator('.assigned-person-group h4').allTextContents(),['간부','병']);
   const candidateText=await page.locator('.assigned-person-group').first().innerText();assert(candidateText.indexOf('대령')<candidateText.indexOf('소위'),'work assignee choices follow rank');
   report.checks.push(`${name}: work assignee choices share the roster military rank order`);

   await page.setViewportSize({width:1366,height:768});await setTestSession(page,'bnoc');await page.goto(`${base}/operations`);
   const selected=page.locator('.department-comparison tbody tr').first();
   await selected.getByRole('button',{name:teamIds[0],exact:true}).click();
   await page.screenshot({path:`${evidence}/${name}-department-click.png`});
   await expect(page.getByLabel('부서',{exact:true})).toHaveValue(teamIds[0]);
   await expect(page.locator('#shared-work-list-title')).toContainText('할당 작업');
   await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(3);
   await page.getByLabel('부서',{exact:true}).selectOption(teamIds[1]);
   await expect(page.locator('.query-context')).toContainText('조건 편집 중');
   await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(3);
   await page.getByRole('button',{name:'검색',exact:true}).click();
   await expect(page.locator('.query-context')).toHaveCount(0);
   await expect(page.locator('.shared-work-detail tbody tr td:nth-child(2)').first()).toHaveText(teamIds[1]);
   report.checks.push(`${name}: department comparison selects and filters without changing draft-search semantics`);
   await setTestSession(page,'bnoc');await page.goto(`${base}/personnel`);
   await page.getByLabel('정렬',{exact:true}).selectOption('rank-asc');
   assert.deepEqual(await page.locator('tbody[aria-label] th[scope=rowgroup]').allTextContents(),['병 2명','간부 4명']);
   await expect(page.locator('.personnel-absence')).toContainText('휴가');
   report.checks.push(`${name}: roster ascending/descending display groups and absence exception preserved`);
   await page.route('**/api/operations/status',route=>route.fulfill({json:{data:{collectionState:'stale',items:[],groups:[{groupId:'통신시설',items:[{itemId:'fault',displayName:'통신시설 A',health:'abnormal'}]}]},queriedAt:at}}));
   await page.goto(`${base}/operations-status`);await expect(page.getByText('마지막 수집값이 오래됐습니다.',{exact:true})).toBeVisible();await expect(page.getByText('이상',{exact:true})).toBeVisible();
   report.checks.push(`${name}: stale data and abnormal operation remain visible`);
   await setTestSession(page,'team');await page.goto(`${base}/planned-maintenance`);
   await page.route('**/api/planned-works',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{code:'SAVE_FAILED',message:'계획 저장 실패'}}):route.fallback());
   await page.getByLabel('작업 제목',{exact:true}).fill('점검 일정');await page.getByRole('button',{name:'작업 추가',exact:true}).click();
   const feedback=page.getByRole('alert').filter({hasText:'저장 결과가 확인되지 않았습니다.'});await expect(feedback).toBeFocused();
   const box=await feedback.boundingBox();assert(box&&box.y>=0&&box.y+box.height<=768,'planned save error must be visible');
   await expect(page.getByLabel('작업 제목',{exact:true})).toHaveValue('점검 일정');
   report.checks.push(`${name}: planned save error focuses visible feedback and retains input`);
   page.once('dialog',dialog=>dialog.accept());await page.reload();await page.evaluate(()=>sessionStorage.clear());await setTestSession(page,'bnoc');
   const many=Array.from({length:1000},(_,index)=>({...people[index%people.length],personRef:`many-${index}`,displayName:`인원 ${index}`,serviceNumber:`TEST-${index}`}));
   await page.route('**/api/personnel-roster*',route=>route.fulfill({json:{data:{entries:many,revision:1},queriedAt:at}}));
   await page.goto(`${base}/roster`);await expect(page.locator('.personnel-department tbody tr:not(.personnel-group)')).toHaveCount(1000);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large roster overflow');
   await page.screenshot({path:`${evidence}/${name}-large-roster.png`});
   await page.route('**/api/requests?**',route=>route.fulfill({json:{data:{items:[],total:0},queriedAt:at}}));
   await page.goto(`${base}/requests`);await expect(page.getByText('조건에 맞는 신청이 없습니다.',{exact:true})).toBeVisible();
   report.checks.push(`${name}: 1000-person roster and empty request list retain layout and empty feedback`);


  }
  report.checks.push(`${name}: ${screens.length} role/routes at 1366x768,1440x900,1280x768`);
 }catch(e){report.errors.push(`${name}: ${e.stack}`);}finally{await browser.close();await writeFile(`${evidence}/results.json`,JSON.stringify(report,null,2));}
}
console.log(JSON.stringify({checks:report.checks,errors:report.errors},null,2));if(report.errors.length)process.exitCode=1;
