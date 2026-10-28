import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
const base=process.env.BNOC_TEST_URL??'http://127.0.0.1:8083';
const provider=process.env.BNOC_TEST_PROVIDER_URL??'http://127.0.0.1:8082';
async function login(page:Page,subject='requester'){
 const start=(await (await page.request.get('/api/auth/start')).json()).data;
 const url=new URL(start.providerUrl);
 const issued=await page.request.post(new URL('/identity/issue',provider).toString(),{data:{subject,loginAttempt:start.loginAttempt,browserBinding:url.searchParams.get('browserBinding')}});
 const complete=await page.request.post('/api/auth/complete',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':start.csrfToken},data:{ticket:(await issued.json()).ticket,loginAttempt:start.loginAttempt}});expect(complete.status()).toBe(200);
 return (await (await page.request.get('/api/session')).json()).data;
}
const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const question=(page:Page)=>page.locator('.intake-question');
async function at(page:Page,step:string){await expect(question(page)).toHaveAttribute('data-step',step);}
async function textAnswer(page:Page,label:string,value:string){await page.getByLabel(label,{exact:true}).fill(value);await button(page,'다음').click();}
async function contact(page:Page){
 if(await page.getByLabel('요청자 군내전화번호',{exact:true}).isVisible())await textAnswer(page,'요청자 군내전화번호','000-1234');
 await at(page,'review');await expect(question(page)).toContainText('군내전화 000-1234');
}
async function openItem(page:Page,label:string){
 if(!await button(page,'이 대상 확인 완료').isVisible())await button(page,'3단계 대상 정보').click();
 await at(page,'itemReview');
 const select=page.getByLabel('수정할 대상',{exact:true});
 if(await select.isVisible()){const [kind,...location]=label.split(' ');const option=(await select.locator('option').allTextContents()).find(value=>value.startsWith(kind+' ')&&value.includes(location.join(' ')));expect(option).toBeTruthy();await select.selectOption({label:option!});}
}
async function review(page:Page){if(await question(page).getAttribute('data-step')!=='review')await page.getByRole('button',{name:/단계 최종 확인$/}).click();await at(page,'review');}
async function showExtras(page:Page){const section=page.locator('.intake-entry-extras');if(await section.getAttribute('open')===null)await section.locator('summary').click();}

async function extra(page:Page,field:string){
 const section=page.locator('.intake-optional-information');
 if(await section.getAttribute('open')===null)await section.locator('summary').click();
 await button(page,field+' 수정').click();
}
async function filePicker(page:Page){
 const section=page.locator('details').filter({has:page.locator('summary').filter({hasText:'사진·문서 첨부'})});
 if(await section.getAttribute('open')===null)await section.locator('summary').click();
 return page.getByLabel('이 대상의 첨부파일',{exact:true});
}
async function applyItem(page:Page){await button(page,'이 대상 확인 완료').click();await contact(page);}
async function clearDraft(page:Page,session:any){
 const prior=(await (await page.request.get('/api/request-draft')).json()).data;
 if(prior.draft){const removed=await page.request.delete('/api/request-draft',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{role:'requester',expectedRevision:prior.revision,operationId:randomUUID()}});expect(removed.status()).toBe(200);}
}
async function draftSaved(page:Page){await expect(page.getByRole('status').filter({hasText:'신청서를 임시저장했습니다.'})).toBeVisible();}
async function lines(page:Page){
 await page.goto('/new');await button(page,'신설').click();await button(page,'회선 추가').click();await button(page,'회선 추가').click();await button(page,'선택한 대상 계속').click();
 await textAnswer(page,'어디에 있나요?','첫 설치 위치');await textAnswer(page,'어떤 도움이 필요한가요?','회선 연결');await contact(page);
 await openItem(page,'회선 첫 설치 위치');await extra(page,'망·체계');await button(page,'인트라넷').click();await at(page,'itemReview');await review(page);
 await openItem(page,'회선 첫 설치 위치');await button(page,'일부는 정보가 달라요').click();await button(page,'이 수량 나누기').click();await button(page,'망·체계').click();await button(page,'인터넷').click();await at(page,'itemReview');
 await button(page,'위치 수정').click();await textAnswer(page,'어디에 있나요?','두 번째 설치 위치');await at(page,'itemReview');await applyItem(page);await contact(page);
}
async function save(page:Page){
 const posted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/commands'&&r.request().method()==='POST');await button(page,'신청 등록').click();const response=await posted;expect(response.status()).toBe(200);const body=await response.json();expect(body.ok).toBe(true);return body.requestNumber as string;
}
for(const subject of ['requester','bnoc'])test(`adaptive intent: ${subject} sees four purposes and only the selected branch`,async({page},info)=>{
 await login(page,subject);await page.goto('/new');
 const choices=()=>page.locator('.intake-choices button');
 await expect(choices()).toHaveText(['고장','신설','지원','기타']);await expect(page.locator('.intake-progress li')).toHaveText(['1신청 목적','2신청 정보','3연락처','4최종 확인']);await expect(page.locator('.intake-targets,input[type="file"]')).toHaveCount(0);
 for(const control of await choices().all())expect(await control.evaluate(element=>element.getBoundingClientRect().height)).toBe(44);
 await page.screenshot({path:`${process.env.BNOC_TEST_EVIDENCE_DIR}/intent-${subject}-${info.project.name}.png`});
 for(const purpose of ['고장','신설','기타']){
  await button(page,purpose).click();await expect(page.locator('.intake-target')).toHaveCount(8);await expect(button(page,'회의 지원')).toHaveCount(0);
  await button(page,'컴퓨터 추가').click();await button(page,'선택한 대상 계속').click();await expect(page.getByRole('heading',{name:'어디에 있나요?',exact:true})).toBeFocused();
  await expect(button(page,'고장')).toHaveCount(0);await button(page,'이전').click();await button(page,'컴퓨터 빼기').click();await button(page,'이전').click();await expect(choices()).toHaveText(['고장','신설','지원','기타']);
 }
 await button(page,'지원').click();await expect(choices()).toHaveText(['회의 지원','장비 지원','대여','점검','장비 이전']);await expect(page.locator('.intake-targets')).toHaveCount(0);
 for(const support of ['장비 지원','대여','점검','장비 이전']){await choices().filter({hasText:new RegExp(`^${support}$`)}).click();await expect(page.locator('.intake-target')).toHaveCount(8);await expect(button(page,'회의 지원')).toHaveCount(0);await button(page,'이전').click();}
 await button(page,'회의 지원').click();await expect(choices()).toHaveText(['화상회의','일반회의','기타']);await expect(page.locator('.intake-targets')).toHaveCount(0);
 await button(page,'이전').click();await expect(choices()).toHaveText(['회의 지원','장비 지원','대여','점검','장비 이전']);
});
test('adaptive intent: purpose-only draft and meeting partial text restore their exact step',async({page})=>{
 const session=await login(page);await clearDraft(page,session);
 await page.goto('/new');await button(page,'지원').click();await button(page,'임시저장').click();await draftSaved(page);
 await page.reload();await button(page,'임시저장 불러오기').click();await at(page,'supportKind');await expect(page.locator('.intake-targets')).toHaveCount(0);
 await button(page,'회의 지원').click();await button(page,'화상회의').click();await button(page,'KJCCS').click();await page.getByLabel('어떤 지원이 필요한가요?',{exact:true}).fill('작성 중인 회의 지원');
 await button(page,'임시저장').click();await draftSaved(page);await page.reload();await button(page,'임시저장 불러오기').click();await expect(page.getByLabel('어떤 지원이 필요한가요?',{exact:true})).toHaveValue('작성 중인 회의 지원');
 await button(page,'이전').click();await button(page,'이전').click();await button(page,'이전').click();await at(page,'supportKind');
 await button(page,'회의 지원').click();await button(page,'화상회의').click();await button(page,'KJCCS').click();await expect(page.getByLabel('어떤 지원이 필요한가요?',{exact:true})).toHaveValue('작성 중인 회의 지원');
});
test('adaptive intent: both branches retain uploads and only the final meeting is submitted',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'지원').click();await button(page,'장비 지원').click();await button(page,'비상벨 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','장비 분기 위치');await textAnswer(page,'어떤 도움이 필요한가요?','장비 분기 내용');await contact(page);
 await openItem(page,'비상벨 장비 분기 위치');await (await filePicker(page)).setInputFiles({name:'device-branch.txt',mimeType:'text/plain',buffer:Buffer.from('device branch bytes')});await expect(button(page,'device-branch.txt 첨부 제외')).toBeVisible();await applyItem(page);
 await button(page,'1단계 신청 목적').click();await button(page,'지원').click();await button(page,'회의 지원').click();await button(page,'화상회의').click();await button(page,'KJCCS').click();await textAnswer(page,'어떤 지원이 필요한가요?','회의 분기 내용');await textAnswer(page,'회의 장소는 어디인가요?','회의 분기 위치');
 await expect(button(page,'다음')).toBeDisabled();await page.getByLabel('화상회의 지원 의뢰서',{exact:true}).setInputFiles({name:'meeting-branch.txt',mimeType:'text/plain',buffer:Buffer.from('meeting branch bytes')});await expect(button(page,'meeting-branch.txt 첨부 제외')).toBeVisible();await button(page,'다음').click();await contact(page);
 await button(page,'1단계 신청 목적').click();await button(page,'지원').click();await button(page,'장비 지원').click();await expect(page.getByLabel('비상벨 수량')).toHaveText('1');await button(page,'선택한 대상 계속').click();await at(page,'location');await button(page,'다음').click();await at(page,'detail');await button(page,'다음').click();await contact(page);await openItem(page,'비상벨 장비 분기 위치');await expect(page.locator('.intake-answer-list')).toContainText('장비 분기 내용');await filePicker(page);await expect(button(page,'device-branch.txt 첨부 제외')).toBeVisible();await applyItem(page);
 await button(page,'1단계 신청 목적').click();await button(page,'지원').click();await button(page,'회의 지원').click();await button(page,'화상회의').click();await button(page,'KJCCS').click();await expect(page.getByLabel('어떤 지원이 필요한가요?',{exact:true})).toHaveValue('회의 분기 내용');await button(page,'다음').click();await button(page,'다음').click();await expect(button(page,'meeting-branch.txt 첨부 제외')).toBeVisible();await button(page,'다음').click();await contact(page);
 await expect(page.locator('.intake-targets')).toHaveCount(0);const number=await save(page);const saved=(await (await page.request.get(`/api/requests/${number}`)).json()).data;
 expect(saved.category).toBe('회의 지원');expect(saved.requestItems??[]).toEqual([]);expect(saved.attachments.map((file:any)=>file.fileName)).toEqual(['meeting-branch.txt']);expect(saved.detail).toBe('회의 분기 내용');expect(saved.location).toBe('회의 분기 위치');
});
test('adaptive: two selected lines split networks and locations, persist, search and edit as one request',async({page})=>{
 await login(page);await lines(page);await expect(page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true})).toHaveCount(0);
 const number=await save(page);const original=(await (await page.request.get(`/api/requests/${number}`)).json()).data;
 expect(original.itemQuantities).toEqual({'회선':2});expect(original.requestItems.map((row:any)=>row.quantity)).toEqual([1,1]);expect(original.requestItems.map((row:any)=>row.systemType)).toEqual(['인트라넷','인터넷']);expect(original.workItems).toHaveLength(0);
 await page.reload();await expect(page.getByLabel('요청 대상 목록')).toContainText('두 번째 설치 위치');
 const search=(await (await page.request.get('/api/requests',{params:{q:'두 번째 설치 위치'}})).json()).data;expect(search.items.some((row:any)=>row.requestNumber===number)).toBeTruthy();
 await button(page,'내용 수정').click();await openItem(page,'회선 두 번째 설치 위치');await button(page,'위치 수정').click();await textAnswer(page,'어디에 있나요?','정정된 두 번째 위치');await at(page,'itemReview');await review(page);await expect(page.getByLabel('요청자 군내전화번호',{exact:true})).toHaveCount(0);
 const saving=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/commands'&&r.request().method()==='POST'&&r.request().postDataJSON().type==='updateRequest');await button(page,'수정 저장').click();expect((await saving).status()).toBe(200);await expect(button(page,'수정 저장')).toHaveCount(0);await expect(page.getByLabel('요청 대상 목록')).toContainText('정정된 두 번째 위치');
 const after=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(after.requestItems.map((row:any)=>row.id)).toEqual(original.requestItems.map((row:any)=>row.id));expect(after.itemQuantities).toEqual(original.itemQuantities);
});
test('adaptive: initial counters stay fixed, back retains partial text, unknown technology submits without skip or target-confirm steps',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'고장').click();await expect(page.locator('.intake-question input,.intake-question textarea,.intake-question select')).toHaveCount(0);
 const tiles=page.locator('.intake-target');const first=await tiles.nth(0).boundingBox(),second=await tiles.nth(1).boundingBox();expect(first).not.toBeNull();expect(second).not.toBeNull();expect(second!.x).toBeGreaterThan(first!.x+first!.width);expect(Math.abs(first!.y-second!.y)).toBeLessThan(2);const continueBox=await button(page,'선택한 대상 계속').boundingBox();expect(continueBox!.y+continueBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
 for(const control of await page.locator('.intake-target button').all())expect(await control.evaluate(element=>element.getBoundingClientRect().height)).toBe(44);
 const plus=button(page,'프린터 추가'),minus=button(page,'프린터 빼기');const before=await plus.boundingBox();await plus.click();await plus.click();await minus.click();expect((await plus.boundingBox())?.x).toBe(before?.x);await expect(page.getByLabel('프린터 수량')).toHaveText('1');
 await button(page,'선택한 대상 계속').click();await page.getByLabel('어디에 있나요?',{exact:true}).fill('아직 입력 중인 위치');await button(page,'이전').click();await button(page,'선택한 대상 계속').click();await expect(page.getByLabel('어디에 있나요?',{exact:true})).toHaveValue('아직 입력 중인 위치');await button(page,'다음').click();await at(page,'symptom');await expect(button(page,'모르겠어요 · 건너뛰기')).toHaveCount(0);await button(page,'증상을 잘 모르겠어요').click();await at(page,'contact');await expect(button(page,'이 대상 확인 완료')).toHaveCount(0);await contact(page);
 const number=await save(page);const value=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(value.requestItems[0].systemType).toBeNull();expect(value.requestItems[0].equipmentId).toBeNull();expect(value.requestItems[0].symptom).toBe('증상을 잘 모르겠어요');
});
test('adaptive: partial question and back history survive explicit server draft restore',async({page})=>{
 const session=await login(page);await clearDraft(page,session);
 await page.goto('/new');await button(page,'신설').click();await button(page,'CCTV 추가').click();await button(page,'선택한 대상 계속').click();await page.getByLabel('어디에 있나요?',{exact:true}).fill('작성 중인 CCTV 위치');await button(page,'임시저장').click();await draftSaved(page);
 const saved=(await (await page.request.get('/api/request-draft')).json()).data;expect(saved.draft.input.guidedDraft.step).toBe('location');expect(saved.draft.input.guidedDraft.items[0].location).toBe('작성 중인 CCTV 위치');
 await page.reload();await button(page,'임시저장 불러오기').click();await expect(page.getByLabel('어디에 있나요?',{exact:true})).toHaveValue('작성 중인 CCTV 위치');await button(page,'이전').click();await expect(page.getByRole('heading',{name:'대상과 수량을 선택해 주세요',exact:true})).toBeFocused();await button(page,'선택한 대상 계속').click();await button(page,'다음').click();await at(page,'detail');await textAnswer(page,'어떤 도움이 필요한가요?','새 CCTV 설치');await contact(page);
 await openItem(page,'CCTV 작성 중인 CCTV 위치');await expect(button(page,'모델명·장비 코드 수정')).toHaveCount(0);await applyItem(page);await save(page);expect((await (await page.request.get('/api/request-draft')).json()).data.draft).toBeNull();
});
test('adaptive: split cancellation and exclusion preserve selected totals without resurrecting targets',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'신설').click();for(let i=0;i<3;i++)await button(page,'회선 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','분리 위치');await textAnswer(page,'어떤 도움이 필요한가요?','회선 신설');await contact(page);await openItem(page,'회선 분리 위치');await extra(page,'망·체계');await button(page,'인트라넷').click();await openItem(page,'회선 분리 위치');
 await button(page,'일부는 정보가 달라요').click();await button(page,'이 수량 나누기').click();await button(page,'나누기 취소').click();await expect(page.getByRole('heading',{name:'회선 3개 내용 확인',exact:true})).toBeVisible();
 await button(page,'일부는 정보가 달라요').click();await button(page,'이 수량 나누기').click();await button(page,'현재 정보로 계속').click();page.once('dialog',d=>d.accept());await button(page,'이 대상 제외').click();await button(page,'이전').click();await expect(page.locator('.intake-context')).toContainText('회선 2개');await expect(page.getByRole('heading',{name:'몇 개의 정보가 다른가요?',exact:true})).toBeVisible();await button(page,'이전').click();await expect(page.getByRole('heading',{name:'회선 2개 내용 확인',exact:true})).toBeVisible();await applyItem(page);await contact(page);
 const number=await save(page);const value=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(value.itemQuantities).toEqual({'회선':2});expect(value.requestItems).toHaveLength(1);expect(value.requestItems[0].quantity).toBe(2);
});
test('adaptive: unfinished split count survives back, draft restore and subsequent split',async({page})=>{
 const session=await login(page);await clearDraft(page,session);
 await page.goto('/new');await button(page,'신설').click();for(let i=0;i<8;i++)await button(page,'회선 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','분리 수량 위치');await textAnswer(page,'어떤 도움이 필요한가요?','여덟 회선 신설');await contact(page);await openItem(page,'회선 분리 수량 위치');await extra(page,'망·체계');await button(page,'인터넷').click();await openItem(page,'회선 분리 수량 위치');await button(page,'일부는 정보가 달라요').click();await page.getByLabel('정보가 다른 수량',{exact:true}).fill('3');await button(page,'이전').click();await button(page,'일부는 정보가 달라요').click();await expect(page.getByLabel('정보가 다른 수량',{exact:true})).toHaveValue('3');
 await button(page,'임시저장').click();await draftSaved(page);await page.reload();await button(page,'임시저장 불러오기').click();await expect(page.getByLabel('정보가 다른 수량',{exact:true})).toHaveValue('3');await button(page,'이 수량 나누기').click();await expect(page.locator('.intake-context')).toContainText('회선 3개');await button(page,'현재 정보로 계속').click();await applyItem(page);await contact(page);
 const number=await save(page);const saved=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(saved.itemQuantities).toEqual({'회선':8});expect(saved.requestItems.map((row:any)=>row.quantity)).toEqual([5,3]);
});
test('adaptive: IP and analog phones share one selection and drop inactive network values',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'지원').click();await button(page,'장비 지원').click();await button(page,'전화기 추가').click();await button(page,'전화기 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','전화 위치');await textAnswer(page,'어떤 도움이 필요한가요?','전화 연결 지원');await contact(page);
 await openItem(page,'전화기 전화 위치');await extra(page,'전화기 종류');await button(page,'IP').click();await at(page,'itemReview');await review(page);await openItem(page,'전화기 전화 위치');await extra(page,'망·체계');await button(page,'인트라넷').click();await openItem(page,'전화기 전화 위치');await button(page,'일부는 정보가 달라요').click();await button(page,'이 수량 나누기').click();await button(page,'전화기 종류').click();await button(page,'아날로그').click();await at(page,'itemReview');await expect(button(page,'망·체계 수정')).toHaveCount(0);await applyItem(page);await contact(page);
 const number=await save(page);const saved=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(saved.itemQuantities).toEqual({'전화':2});expect(saved.requestItems.map((row:any)=>row.phoneType)).toEqual(['IP','아날로그']);expect(saved.requestItems[0].systemType).toBe('인트라넷');expect(saved.requestItems[1].systemType).toBeNull();
});
test('adaptive: removing a target removes only its own uploaded attachment from formal submission',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'신설').click();await button(page,'컴퓨터 추가').click();await button(page,'프린터 추가').click();await button(page,'선택한 대상 계속').click();
 for(const location of ['컴퓨터 위치','프린터 위치']){await textAnswer(page,'어디에 있나요?',location);await textAnswer(page,'어떤 도움이 필요한가요?','신설 지원');}
 await contact(page);
 for(const [label,fileName] of [['컴퓨터 컴퓨터 위치','computer.txt'],['프린터 프린터 위치','printer.txt']]){await openItem(page,label);await (await filePicker(page)).setInputFiles({name:fileName,mimeType:'text/plain',buffer:Buffer.from(fileName+' bytes')});await expect(button(page,fileName+' 첨부 제외')).toBeVisible();await expect(button(page,'이 대상 확인 완료')).toBeEnabled();await applyItem(page);}
 await openItem(page,'컴퓨터 컴퓨터 위치');page.once('dialog',d=>d.accept());await button(page,'이 대상 제외').click();await applyItem(page);await contact(page);
 const number=await save(page);const saved=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(saved.itemQuantities).toEqual({'프린터':1});expect(saved.attachments.map((file:any)=>file.fileName)).toEqual(['printer.txt']);expect(saved.requestItems[0].attachmentIds).toEqual([saved.attachments[0].id]);const bytes=await (await page.request.get(`/api/attachments/${saved.attachments[0].id}`)).body();expect(bytes.equals(Buffer.from('printer.txt bytes'))).toBeTruthy();
});
test('adaptive: reducing the active target to zero still permits an empty draft and a new selection',async({page})=>{
 const session=await login(page);await clearDraft(page,session);await lines(page);await button(page,'2단계 대상 선택').click();await button(page,'회선 빼기').click();await button(page,'회선 빼기').click();await expect(page.getByLabel('회선 수량')).toHaveText('0');
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/request-draft'&&r.request().method()==='PUT');await button(page,'임시저장').click();expect((await response).status()).toBe(200);await draftSaved(page);const saved=(await (await page.request.get('/api/request-draft')).json()).data;expect(saved.draft.input.guidedDraft.activeId).toBeNull();expect(saved.draft.input.guidedDraft.items).toEqual([]);expect(saved.draft.input.guidedDraft.quantities).toEqual({});
 await page.reload();await button(page,'임시저장 불러오기').click();await expect(page.getByLabel('회선 수량')).toHaveText('0');await button(page,'프린터 추가').click();const next=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/request-draft'&&r.request().method()==='PUT');await button(page,'임시저장').click();expect((await next).status()).toBe(200);const after=(await (await page.request.get('/api/request-draft')).json()).data;expect(after.draft.input.guidedDraft.items).toHaveLength(1);expect(after.draft.input.guidedDraft.items[0].kind).toBe('프린터');expect(after.draft.input.guidedDraft.quantities).toEqual({'프린터':1});
});
test('adaptive friction: previous location is an explicit choice and different locations remain independent',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'신설').click();for(const kind of ['컴퓨터','프린터','전화기'])await button(page,kind+' 추가').click();await button(page,'선택한 대상 계속').click();
 await textAnswer(page,'어디에 있나요?','공통 위치');await textAnswer(page,'어떤 도움이 필요한가요?','컴퓨터 설치');await at(page,'location');await expect(page.getByLabel('어디에 있나요?',{exact:true})).toHaveValue('');await expect(page.locator('.intake-location-reuse')).toContainText('공통 위치');await button(page,'이전 대상과 같은 위치 사용').click();await at(page,'detail');await textAnswer(page,'어떤 도움이 필요한가요?','프린터 설치');
 await at(page,'location');await expect(page.getByLabel('어디에 있나요?',{exact:true})).toHaveValue('');await expect(button(page,'이전 대상과 같은 위치 사용')).toBeVisible();await textAnswer(page,'어디에 있나요?','다른 위치');await textAnswer(page,'어떤 도움이 필요한가요?','전화 설치');await contact(page);
 const number=await save(page);const saved=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(saved.requestItems.map((item:any)=>item.location)).toEqual(['공통 위치','공통 위치','다른 위치']);expect(saved.itemQuantities).toEqual({PC:1,'프린터':1,'전화':1});
});
test('adaptive friction: one optional edit and Back stay in target information without other optional tours',async({page})=>{
 await login(page);await page.goto('/new');await button(page,'고장').click();await button(page,'컴퓨터 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','선택정보 위치');await button(page,'증상을 잘 모르겠어요').click();await contact(page);
 await openItem(page,'컴퓨터 선택정보 위치');await extra(page,'모델명·장비 코드');await page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true}).fill('KNOWN-MODEL');await button(page,'입력하고 다음').click();await at(page,'itemReview');await expect(question(page)).toContainText('KNOWN-MODEL');await expect(page.getByLabel('요청자 군내전화번호',{exact:true})).toHaveCount(0);
 await button(page,'이전').click();await at(page,'equipmentId');await expect(page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true})).toHaveValue('KNOWN-MODEL');await page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true}).fill('CORRECTED-MODEL');await button(page,'입력하고 다음').click();await at(page,'itemReview');
 await openItem(page,'컴퓨터 선택정보 위치');await button(page,'증상 수정').click();await button(page,'직접 설명할게요').click();await at(page,'detail');await textAnswer(page,'어떤 도움이 필요한가요?','필수 직접 설명');await at(page,'itemReview');await review(page);
 const number=await save(page);const item=(await (await page.request.get(`/api/requests/${number}`)).json()).data.requestItems[0];expect(item.equipmentId).toBe('CORRECTED-MODEL');expect(item.detail).toBe('필수 직접 설명');expect(item.symptom).toBe('직접 설명할게요');expect(item.systemType).toBeNull();
});
test('adaptive friction: optional edit drafts retain review destination and legacy optional steps resume only required questions',async({page})=>{
 const session=await login(page);await clearDraft(page,session);await page.goto('/new');await button(page,'고장').click();await button(page,'컴퓨터 추가').click();await button(page,'선택한 대상 계속').click();await textAnswer(page,'어디에 있나요?','선택정보 초안 위치');await button(page,'증상을 잘 모르겠어요').click();await contact(page);
 await openItem(page,'컴퓨터 선택정보 초안 위치');await extra(page,'모델명·장비 코드');await page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true}).fill('작성 중 모델');await button(page,'임시저장').click();await draftSaved(page);
 const saved=(await (await page.request.get('/api/request-draft')).json()).data;expect(saved.draft.input.guidedDraft.step).toBe('equipmentId');expect(saved.draft.input.guidedDraft.returnTo).toBe('itemReview');
 await page.reload();await button(page,'임시저장 불러오기').click();await at(page,'equipmentId');await expect(page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true})).toHaveValue('작성 중 모델');await button(page,'입력하고 다음').click();await at(page,'itemReview');await expect(page.getByLabel('요청자 군내전화번호',{exact:true})).toHaveCount(0);
 const legacy=structuredClone(saved.draft.input);delete legacy.guidedDraft.intent;delete legacy.guidedDraft.defaultWorkType;legacy.guidedDraft.step='systemType';legacy.guidedDraft.returnTo=null;for(const item of legacy.guidedDraft.items){delete item.inheritedWorkType;item.symptom='';item.answered=item.answered.filter((field:string)=>field!=='symptom');}
 const seeded=await page.request.put('/api/request-draft',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{role:'requester',expectedRevision:saved.revision,operationId:randomUUID(),input:legacy}});expect(seeded.status()).toBe(200);
 await page.reload();await button(page,'임시저장 불러오기').click();await at(page,'systemType');await button(page,'모르겠어요 · 건너뛰기').click();await at(page,'symptom');await button(page,'증상을 잘 모르겠어요').click();await at(page,'contact');await contact(page);await expect(question(page)).toContainText('작성 중 모델');await review(page);
 const number=await save(page);const result=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(result.requestItems[0].location).toBe('선택정보 초안 위치');expect(result.requestItems[0].equipmentId).toBe('작성 중 모델');expect(result.requestItems[0].symptom).toBe('증상을 잘 모르겠어요');expect((await (await page.request.get('/api/request-draft')).json()).data.draft).toBeNull();
});
test('adaptive friction: expert opt-in survives optional draft and Back, saves exact known fields and stops before the next target',async({page})=>{
 const session=await login(page);await clearDraft(page,session);await page.goto('/new');await button(page,'고장').click();await button(page,'컴퓨터 추가').click();await button(page,'전화기 추가').click();await button(page,'선택한 대상 계속').click();
 await textAnswer(page,'어디에 있나요?','전문가 장비 위치');await showExtras(page);const optin=page.getByRole('checkbox',{name:'장비 정보도 함께 입력',exact:true});await expect(optin).not.toBeChecked();await optin.check();
 await button(page,'이전').click();await at(page,'location');await expect(page.getByLabel('어디에 있나요?',{exact:true})).toHaveValue('전문가 장비 위치');await button(page,'다음').click();await at(page,'symptom');await showExtras(page);await expect(optin).toBeChecked();
 await button(page,'이전').click();await at(page,'location');await button(page,'이전').click();await at(page,'pick');await button(page,'선택한 대상 계속').click();await at(page,'location');await button(page,'다음').click();await at(page,'symptom');await showExtras(page);await expect(optin).toBeChecked();await optin.uncheck();await button(page,'이전').click();await at(page,'location');await button(page,'이전').click();await at(page,'pick');await button(page,'선택한 대상 계속').click();await at(page,'location');await button(page,'다음').click();await at(page,'symptom');await showExtras(page);await expect(optin).not.toBeChecked();await optin.check();
 await button(page,'오류가 표시돼요').click();await at(page,'systemType');await button(page,'인트라넷').click();await at(page,'errorCode');
 await page.getByLabel('화면의 오류 문구가 있나요?',{exact:true}).fill('ERR-');await button(page,'임시저장').click();await draftSaved(page);
 const saved=(await (await page.request.get('/api/request-draft')).json()).data;expect(saved.draft.input.guidedDraft.step).toBe('errorCode');expect(saved.draft.input.guidedDraft.returnTo).toBe('optional');expect(saved.draft.input.guidedDraft.items[0].extraInformation).toBe(true);expect(saved.draft.input.guidedDraft.items[1].extraInformation).not.toBe(true);expect(saved.draft.input.guidedDraft.items[0].systemType).toBe('인트라넷');expect(saved.draft.input.guidedDraft.items[0].errorCode).toBe('ERR-');
 await page.reload();await button(page,'임시저장 불러오기').click();await at(page,'errorCode');await expect(page.getByLabel('화면의 오류 문구가 있나요?',{exact:true})).toHaveValue('ERR-');await button(page,'이전').click();await at(page,'systemType');await expect(button(page,'인트라넷')).toHaveAttribute('aria-pressed','true');await button(page,'인트라넷').click();await at(page,'errorCode');await expect(page.getByLabel('화면의 오류 문구가 있나요?',{exact:true})).toHaveValue('ERR-');
 await page.getByLabel('화면의 오류 문구가 있나요?',{exact:true}).fill('ERR-KNOWN');await button(page,'입력하고 다음').click();await at(page,'equipmentId');await page.getByLabel('모델명·장비 코드를 알고 있나요?',{exact:true}).fill('MODEL-KNOWN');await button(page,'입력하고 다음').click();await at(page,'location');await expect(page.locator('.intake-context')).toContainText('전화기 1대');await expect(button(page,'이 대상 확인 완료')).toHaveCount(0);
 await textAnswer(page,'어디에 있나요?','다른 전화 위치');await at(page,'symptom');await showExtras(page);await expect(page.getByRole('checkbox',{name:'장비 정보도 함께 입력',exact:true})).not.toBeChecked();await button(page,'증상을 잘 모르겠어요').click();await at(page,'contact');await expect(button(page,'모르겠어요 · 건너뛰기')).toHaveCount(0);await contact(page);
 const number=await save(page);const result=(await (await page.request.get(`/api/requests/${number}`)).json()).data;expect(result.itemQuantities).toEqual({PC:1,'전화':1});expect(result.requestItems.map((item:any)=>item.location)).toEqual(['전문가 장비 위치','다른 전화 위치']);expect(result.requestItems[0].systemType).toBe('인트라넷');expect(result.requestItems[0].errorCode).toBe('ERR-KNOWN');expect(result.requestItems[0].equipmentId).toBe('MODEL-KNOWN');expect(result.requestItems[0].symptom).toBe('오류가 표시돼요');expect(result.requestItems[1].phoneType).toBeNull();expect(result.requestItems[1].systemType).toBeNull();expect(result.requestItems[1].equipmentId).toBeNull();expect(result.requestItems[1].errorCode).toBeNull();expect(result.requestItems[1].symptom).toBe('증상을 잘 모르겠어요');expect((await (await page.request.get('/api/request-draft')).json()).data.draft).toBeNull();
});
test.afterEach(async({page})=>{expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'1280/1440 desktop overflow').toBeTruthy();});
