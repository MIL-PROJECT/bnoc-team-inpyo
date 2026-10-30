import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {docxFixture,previewPng,previewPdf} from './document-preview-fixture.mjs';
const base=process.env.BNOC_TEST_URL??'http://127.0.0.1:8083',provider=process.env.BNOC_TEST_PROVIDER_URL??'http://127.0.0.1:8082';
async function login(page:Page,subject='requester'){
 const start=(await (await page.request.get('/api/auth/start')).json()).data,url=new URL(start.providerUrl);
 const ticket=await page.request.post(new URL('/identity/issue',provider).toString(),{data:{subject,loginAttempt:start.loginAttempt,browserBinding:url.searchParams.get('browserBinding')}});
 expect(ticket.status()).toBe(200);
 const response=await page.request.post('/api/auth/complete',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':start.csrfToken},data:{ticket:(await ticket.json()).ticket,loginAttempt:start.loginAttempt}});expect(response.status()).toBe(200);
 return (await (await page.request.get('/api/session')).json()).data;
}
async function read(page:Page,path:string){const response=await page.request.get('/api'+path);expect(response.status()).toBe(200);return (await response.json()).data;}
async function command(page:Page,type:string,payload:any,target:any={}){
 const session=await read(page,'/session'),response=await page.request.post('/api/commands',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{type,payload,...target,operationId:randomUUID()}});expect(response.status(),type).toBe(200);return response.json();
}
const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const at=(page:Page,step:string)=>expect(page.locator('.intake-question')).toHaveAttribute('data-step',step);
async function answer(page:Page,label:string,value:string){await page.getByLabel(label,{exact:true}).fill(value);await button(page,'다음').click();}
async function begin(page:Page){await page.goto('/new');await button(page,'고장').click();await button(page,'컴퓨터 추가').click();await button(page,'선택한 대상 계속').click();await answer(page,'어디에 있나요?','확인 위치');}
async function final(page:Page){await button(page,'작동이 멈췄어요').click();await answer(page,'요청자 군내전화번호','000-1234');await at(page,'review');}
const payload=(detail:string)=>({category:'장비/체계',subcategories:{systemType:'인터넷',resourceType:'PC',workType:'지원'},detail,location:'검증 위치',contact:'000-1234',attachments:[]});
test('team feedback: sequential navigation, clickable stages and a compact final confirmation',async({page},info)=>{
 await login(page);await begin(page);await expect(page.getByText('추가 정보·사진·문서 (선택)',{exact:true})).toBeVisible();await final(page);
 for(const name of ['신청 목적 변경','대상·수량 변경','연락처 수정','정보·첨부 수정'])await expect(button(page,name)).toHaveCount(0);
 await expect(page.getByRole('region',{name:'사진·문서 첨부',exact:true})).toBeVisible();
 await button(page,'이전').click();await at(page,'contact');await button(page,'이전').click();await at(page,'symptom');await button(page,'이전').click();await at(page,'location');
 await button(page,'다음').click();await at(page,'symptom');await button(page,'이전').click();await at(page,'location');await button(page,'이전').click();await at(page,'pick');
 await button(page,'선택한 대상 계속').click();await at(page,'location');await button(page,'다음').click();await at(page,'symptom');await button(page,'작동이 멈췄어요').click();await at(page,'contact');await button(page,'다음').click();await at(page,'review');
 await button(page,'2단계 대상 선택').click();await at(page,'pick');await expect(page.getByLabel('컴퓨터 수량')).toHaveText('1');await button(page,'선택한 대상 계속').click();await at(page,'location');
 await button(page,'다음').click();await at(page,'symptom');await button(page,'작동이 멈췄어요').click();await at(page,'contact');await button(page,'다음').click();await at(page,'review');
 await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/compact-final-${info.project.name}.png`});
 const measurements=await page.locator('.intake-progress button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));expect(measurements.every(height=>height===44)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('team feedback: upload and preview photos PDF HWP and DOCX before registering',async({page},info)=>{
 await login(page);await begin(page);await page.getByText('추가 정보·사진·문서 (선택)',{exact:true}).click();
 const hwp=await readFile('frontend/src/preview/fixtures/support.hwp');
 await page.getByLabel('이 대상의 첨부파일',{exact:true}).setInputFiles([{name:'신청전.hwp',mimeType:'application/octet-stream',buffer:hwp},{name:'신청전.docx',mimeType:'application/octet-stream',buffer:docxFixture()},{name:'신청전.pdf',mimeType:'application/pdf',buffer:previewPdf()},{name:'신청전.png',mimeType:'image/png',buffer:previewPng}]);
 await expect(page.locator('.attachment-row')).toHaveCount(4);await expect(page.getByText('파일을 올리는 중…')).toHaveCount(0);
 for(const extension of ['hwp','docx','pdf','png']){
  const open=button(page,`신청전.${extension} 미리보기`);await open.click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:`신청전.${extension}`})).toBeVisible();
  if(extension==='hwp')await expect(dialog.locator('.hwp-page-view__image')).toBeVisible({timeout:30000});
  if(extension==='docx')await expect(dialog.frameLocator('iframe').getByText('회의 지원 원본 7319')).toBeVisible({timeout:30000});
  if(extension==='pdf')await expect(dialog.locator('iframe[title="원본 PDF"]')).toBeVisible();
  if(extension==='png')await expect(dialog.locator('img')).toBeVisible();
  await expect(dialog.getByText('추출 본문',{exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();await expect(open).toBeFocused();
 }
 await final(page);await expect(page.locator('.intake-review-attachments .attachment-row')).toHaveCount(4);await button(page,'신청전.hwp 미리보기').click();await expect(page.locator('.hwp-page-view__image')).toBeVisible();await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/before-submit-hwp-${info.project.name}.png`});
 await page.getByRole('dialog').getByRole('button',{name:'닫기',exact:true}).click();await button(page,'5단계 최종 확인').click();await button(page,'이전').click();await at(page,'contact');await button(page,'다음').click();await at(page,'review');
 await page.getByLabel('이 대상의 첨부파일',{exact:true}).setInputFiles({name:'최종추가.png',mimeType:'image/png',buffer:previewPng});await expect(page.locator('.intake-review-attachments .attachment-row')).toHaveCount(5);
 const posted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST');await button(page,'신청 등록').click();const created=await (await posted).json();expect(created.ok).toBe(true);const saved=await read(page,`/requests/${created.requestNumber}`);expect(saved.attachments.map((row:any)=>row.fileName).sort()).toEqual(['신청전.hwp','신청전.docx','신청전.pdf','신청전.png','최종추가.png'].sort());expect(saved.requestItems[0].attachmentIds).toHaveLength(5);
});
test('team feedback: telephone input rejects letters on typing and paste across contact fields',async({page})=>{
 await login(page);await begin(page);await button(page,'작동이 멈췄어요').click();
 const phone=page.getByLabel('요청자 군내전화번호',{exact:true});await phone.fill('군내 (000) abc-1234');await expect(phone).toHaveValue('000-1234');await phone.pressSequentially('한글AB+()');await expect(phone).toHaveValue('000-1234');
 await page.getByText('희망 일정·추가 연락처·정비대상자',{exact:true}).click();await page.getByLabel('요청자 개인전화번호',{exact:true}).fill('+82 (010) 12AB-345678');await expect(page.getByLabel('요청자 개인전화번호',{exact:true})).toHaveValue('8201012-345678');
 await page.getByLabel('정비대상자가 요청자와 다름').check();await page.getByLabel('정비대상자 군내전화번호',{exact:true}).fill('내선 123-4');await expect(page.getByLabel('정비대상자 군내전화번호',{exact:true})).toHaveValue('123-4');
});
test('team feedback: request order survives assignment and reuse is visible in list and new form',async({page},info)=>{
 await login(page);const marker=`재사용-${randomUUID()}`;const older=await command(page,'createRequest',payload(marker));const newer=await command(page,'createRequest',payload('신청순서 검증'));
 const before=await read(page,'/requests?page=0&size=20');const expected=before.items.map((row:any)=>row.requestNumber);
 await login(page,'bnoc');const old=await read(page,`/requests/${older.requestNumber}`);await command(page,'assignTeams',{teamIds:['무선반'],priority:'general'},{requestNumber:old.requestNumber,expectedRevision:old.revision});
 await login(page);const after=await read(page,'/requests?page=0&size=20');expect(after.items.map((row:any)=>row.requestNumber)).toEqual(expected);expect(expected.indexOf(newer.requestNumber)).toBeLessThan(expected.indexOf(older.requestNumber));
 await page.goto('/requests');await expect(button(page,`신청 ${older.requestNumber} 내용 불러오기`)).toBeVisible();await button(page,`신청 ${older.requestNumber} 내용 불러오기`).click();await expect(page.getByRole('status').filter({hasText:`요청 ${older.requestNumber}을 불러온`})).toBeVisible();
 page.once('dialog',dialog=>dialog.accept());await button(page,'이전 신청 불러오기').click();const dialog=page.getByRole('dialog',{name:'이전 신청 불러오기'});await dialog.getByLabel('이전 신청 내용 검색').fill(marker);await dialog.getByRole('button',{name:'검색',exact:true}).click();await expect(dialog.locator('.queue-row')).toHaveCount(1);await expect(dialog.locator('.queue-row')).toContainText(marker);await dialog.getByRole('button',{name:'이 내용으로 새 신청'}).click();await expect(dialog).not.toBeVisible();
 await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/reuse-entry-${info.project.name}.png`});expect((await read(page,`/requests/${older.requestNumber}`)).detail).toBe(marker);
});
test('team feedback: requester sees current department phone and admin can edit it persistently',async({page},info)=>{
 await login(page);const created=await command(page,'createRequest',payload('반환 부서 숨김 검증'));await login(page,'bnoc');let detail=await read(page,`/requests/${created.requestNumber}`);await command(page,'assignTeams',{teamIds:['무선반','유선반'],priority:'general'},{requestNumber:detail.requestNumber,expectedRevision:detail.revision});
 await login(page,'team-wireless');detail=await read(page,`/requests/${created.requestNumber}`);const old=detail.workItems.find((row:any)=>row.teamId==='무선반');await command(page,'returnWork',{returnReason:'다른 부서 처리'},{requestNumber:detail.requestNumber,workNumber:old.workNumber,expectedRevision:old.revision});
 await login(page);await page.goto(`/requests/${created.requestNumber}`);await expect(page.locator('.work-card')).toHaveCount(1);await expect(page.locator('.work-card')).toContainText('유선반');await expect(page.locator('.work-card')).not.toContainText('무선반');await expect(page.locator('.department-contact')).toContainText(/000-/);
 await login(page,'access-admin');await page.goto('/operations');const editor=page.locator('.department-contact-editor');await editor.locator('summary').click();const contacts=await read(page,'/department-contacts'),original=contacts.items.find((row:any)=>row.department==='유선반');
 try{
  await editor.getByRole('button',{name:'유선반 대표전화 수정',exact:true}).click();await editor.getByLabel('부서 대표 군내전화').fill('대표 000-9555');await expect(editor.getByLabel('부서 대표 군내전화')).toHaveValue('000-9555');await editor.getByRole('button',{name:'대표전화 저장',exact:true}).click();await expect(editor.getByRole('status').filter({hasText:'유선반 대표전화를 저장했습니다.'})).toBeVisible();await page.reload();await editor.locator('summary').click();await expect(editor.locator('tr').filter({hasText:'유선반'})).toContainText('000-9555');
  await login(page);await page.goto(`/requests/${created.requestNumber}`);await expect(page.locator('.department-contact')).toContainText('000-9555');await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/requester-current-${info.project.name}.png`});
 }finally{await login(page,'access-admin');const current=(await read(page,'/department-contacts')).items.find((row:any)=>row.department==='유선반');await command(page,'saveDepartmentContact',{department:'유선반',phone:original.phone},{expectedRevision:current.revision});}
});
test('team feedback: department comparison follows applied filter and retains it after a failed query',async({page})=>{
 await login(page);await page.goto('/operations');const rows=page.locator('.department-comparison tbody tr');await expect(rows).toHaveCount(5);await page.getByRole('group',{name:'부서 선택'}).getByLabel('무선반',{exact:true}).check();await button(page,'검색').click();await expect(rows).toHaveCount(1);await expect(rows).toContainText('무선반');
 await page.getByRole('group',{name:'부서 선택'}).getByLabel('무선반',{exact:true}).uncheck();await page.getByRole('group',{name:'부서 선택'}).getByLabel('유선반',{exact:true}).check();await expect(rows).toContainText('무선반');await page.route('**/api/work-overview?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,errorCode:'SAVE_FAILED',message:'조회 실패 검증'})}));await button(page,'검색').click();await expect(page.getByRole('alert')).toContainText('조회 실패 검증');await expect(rows).toHaveCount(1);await expect(rows).toContainText('무선반');await page.unroute('**/api/work-overview?**');await button(page,'초기화').click();await expect(rows).toHaveCount(5);
});

async function optionalContact(page:Page){
 await button(page,'작동이 멈췄어요').click();await page.getByLabel('요청자 군내전화번호',{exact:true}).fill('000-1234');
 await page.getByText('희망 일정·추가 연락처·정비대상자',{exact:true}).click();
}
async function submitResponse(page:Page){
 const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/commands'&&row.request().method()==='POST');
 await button(page,'신청 등록').click();return response;
}
for(const subject of ['requester','bnoc'])test(`competition: ${subject} confirms every supplied common option without extra edit actions`,async({page},info)=>{
 await login(page,subject);await begin(page);await optionalContact(page);
 await page.getByLabel('요청자 개인전화번호',{exact:true}).fill('000-0000-0000');await page.getByLabel('문서 참조정보',{exact:true}).fill('검증문서-20261028');
 for(const [rank,date,period] of [[1,'2026-11-01','AM'],[2,'2026-11-02','PM']] as const){await page.getByLabel(`${rank}지망 날짜`,{exact:true}).fill(date);await page.getByLabel(`${rank}지망 오전·오후`,{exact:true}).selectOption(period);}
 await page.getByLabel('정비대상자가 요청자와 다름').check();
 for(const [label,value] of [['소속','검증소속'],['계급','검증구분'],['이름','검증식별값'],['군내전화번호','000-2222']])await page.getByLabel(`정비대상자 ${label}`,{exact:true}).fill(value);
 await button(page,'다음').click();if(subject==='bnoc'){const requesters=await read(page,'/requesters');await page.getByLabel('요청자 계정',{exact:true}).selectOption(requesters[0].requesterRef);await button(page,'최종 확인').click();}
 await at(page,'review');const review=page.locator('.intake-question');
 for(const text of ['000-0000-0000','검증문서-20261028','2026-11-01','오전','2026-11-02','오후','검증소속','검증구분','검증식별값','000-2222'])await expect(review).toContainText(text);
 for(const name of ['신청 목적 변경','대상·수량 변경','연락처 수정','정보·첨부 수정'])await expect(button(page,name)).toHaveCount(0);
 await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/common-options-${subject}-${info.project.name}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const created=await (await submitResponse(page)).json();expect(created.ok).toBe(true);const saved=await read(page,`/requests/${created.requestNumber}`);
 expect(saved.personalContact).toBe('000-0000-0000');expect(saved.documentRef).toBe('검증문서-20261028');expect(saved.schedulePreferences).toEqual([{rank:1,date:'2026-11-01',period:'AM'},{rank:2,date:'2026-11-02',period:'PM'}]);
 if(subject==='requester'){expect(saved.maintenanceTarget).toBeNull();await login(page,'bnoc');}
 expect((await read(page,`/requests/${created.requestNumber}`)).maintenanceTarget).toEqual({department:'검증소속',rank:'검증구분',name:'검증식별값',phone:'000-2222'});
});
for(const error of ['personalContact','schedulePreferences','targetName'])test(`competition: ${error} opens its hidden input and preserves the request through correction`,async({page},info)=>{
 await login(page);await begin(page);await optionalContact(page);await page.getByLabel('문서 참조정보',{exact:true}).fill('오류후보존');
 if(error==='personalContact')await page.getByLabel('요청자 개인전화번호',{exact:true}).fill('123');
 if(error==='schedulePreferences')await page.getByLabel('1지망 날짜',{exact:true}).fill('2026-11-01');
 if(error==='targetName'){
  await page.getByLabel('정비대상자가 요청자와 다름').check();await page.getByLabel('정비대상자 소속',{exact:true}).fill('검증소속');await page.getByLabel('정비대상자 계급',{exact:true}).fill('검증구분');await page.getByLabel('정비대상자 군내전화번호',{exact:true}).fill('000-2222');
 }
 await button(page,'다음').click();await at(page,'review');await page.getByLabel('이 대상의 첨부파일',{exact:true}).setInputFiles({name:'preserved.txt',mimeType:'text/plain',buffer:Buffer.from('preserved attachment')});await expect(page.locator('.attachment-row')).toHaveCount(1);
 const before=(await read(page,'/requests?size=1')).total;expect((await submitResponse(page)).status()).toBe(400);await at(page,'contact');
 expect((await read(page,'/requests?size=1')).total).toBe(before);
 const field=page.getByLabel(error==='personalContact'?'요청자 개인전화번호':error==='targetName'?'정비대상자 이름':'1지망 날짜',{exact:true});
 await expect(field).toBeVisible();await expect(field).toBeFocused();await expect(field).toHaveAttribute('aria-invalid','true');const described=await field.getAttribute('aria-describedby');expect(described).toBeTruthy();await expect(page.locator(`[id="${described}"]`)).toBeVisible();
 await expect(page.getByLabel('문서 참조정보',{exact:true})).toHaveValue('오류후보존');await expect(page.getByLabel('요청자 군내전화번호',{exact:true})).toHaveValue('000-1234');
 await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/recovered-${error}-${info.project.name}.png`});
 if(error==='personalContact')await field.fill('000-0000-0000');if(error==='targetName')await field.fill('검증식별값');if(error==='schedulePreferences')await page.getByLabel('1지망 오전·오후',{exact:true}).selectOption('AM');
 await button(page,'다음').click();await at(page,'review');await expect(page.locator('.intake-summary')).toContainText('확인 위치');await expect(page.locator('.attachment-row')).toHaveCount(1);
 const created=await (await submitResponse(page)).json();expect(created.ok).toBe(true);const saved=await read(page,`/requests/${created.requestNumber}`);expect(saved.requestItems[0].quantity).toBe(1);expect(saved.documentRef).toBe('오류후보존');expect(saved.attachments.map((row:any)=>row.fileName)).toEqual(['preserved.txt']);
});
