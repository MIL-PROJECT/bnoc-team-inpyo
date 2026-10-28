import { request as apiRequest, test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { docxFixture, previewPng, previewPdf } from './document-preview-fixture.mjs';

const base = process.env.BNOC_TEST_URL ?? 'http://127.0.0.1:8083';
const provider = process.env.BNOC_TEST_PROVIDER_URL ?? 'http://127.0.0.1:8082';
const evidence = process.env.BNOC_TEST_EVIDENCE_DIR ?? 'runtime/evidence/backend-implementation-20261013';
const wire = '무선반';
const scriptErrors = new WeakMap<Page, string[]>();
type ApiSurface = Pick<Page, 'request'>;

async function apiRead(page: ApiSurface, resource: string) {
  const response = await page.request.get(resource);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toHaveProperty('data');
  expect(Number.isFinite(Date.parse(body.queriedAt))).toBeTruthy();
  return body;
}
async function apiLogin(page: ApiSurface, subject: string) {
  const start = await page.request.get('/api/auth/start');
  expect(start.status()).toBe(200);
  const started = await start.json();
  expect(Number.isFinite(Date.parse(started.queriedAt))).toBeTruthy();
  const challenge = started.data;
  const navigation = new URL(challenge.providerUrl);
  const ticket = await page.request.post(new URL('/identity/issue', provider).toString(), { data: { subject, loginAttempt: challenge.loginAttempt, browserBinding: navigation.searchParams.get('browserBinding') } });
  expect(ticket.status()).toBe(200);
  const complete = await page.request.post('/api/auth/complete', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': challenge.csrfToken }, data: { ticket: (await ticket.json()).ticket, loginAttempt: challenge.loginAttempt } });
  expect(complete.status()).toBe(200);
  return (await apiRead(page, '/api/session')).data;
}
async function command(page: ApiSurface, type: string, payload: Record<string, unknown>, target: Record<string, unknown> = {}) {
  const session = (await apiRead(page, '/api/session')).data;
  const response = await page.request.post('/api/commands', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, data: { type, payload, ...target, operationId: randomUUID() } });
  expect(response.status(), `${type} must commit`).toBe(200);
  const result = await response.json();
  expect(result.ok).toBeTruthy();
  return result;
}
async function providerControl(page:ApiSurface,payload:Record<string,unknown>) {
  const secret=process.env.BNOC_MOCK_SECRET;
  expect(secret,'isolated provider control key is available').toBeTruthy();
  const response=await page.request.post(new URL('/control',provider).toString(),{headers:{'X-Mock-Key':secret!},data:payload});
  expect(response.status(),'provider scenario control is separate from BNOC business APIs').toBe(200);
}
async function departmentManagerLogin(page:ApiSurface,department=wire) {
  const manager=await apiLogin(page,'requester-secondary');
  await apiLogin(page,'access-admin');
  const account=(await apiRead(page,'/api/access-assignments')).data.items.find((item:{subjectRef:string})=>item.subjectRef===manager.actor.id);
  expect(account,'a real service identity is selected for department scope').toBeTruthy();
  await command(page,'changeAccess',{subjectRef:account.subjectRef,role:'requester',department,departmentManager:true,active:true},{expectedRevision:account.revision});
  return apiLogin(page,'requester-secondary');
}
function requestPayload(detail: string) {
  return { category: '장비/체계', subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '지원' }, detail, location: '요청 위치', contact: '000-0000', attachments: [] };
}
async function seed(page: Page, text: string, teamIds?: string[]) {
  await apiLogin(page, 'requester');
  const result = await command(page, 'createRequest', requestPayload(text));
  if (teamIds) {
    await apiLogin(page, 'bnoc');
    const detail = (await apiRead(page, `/api/requests/${result.requestNumber}`)).data;
    await command(page, 'assignTeams', { teamIds, priority: 'general' }, { requestNumber: detail.requestNumber, expectedRevision: detail.revision });
  }
  return result.requestNumber as string;
}
async function resetRequestDraft(page:ApiSurface,subject='requester') {
  const session=await apiLogin(page,subject);
  const state=(await apiRead(page,'/api/request-draft')).data;
  if(state.draft){const result=await page.request.delete('/api/request-draft',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{role:session.actor.role,expectedRevision:state.revision,operationId:randomUUID()}});expect(result.status()).toBe(200);}
  return (await apiRead(page,'/api/request-draft')).data;
}
async function saveDraftApi(page:ApiSurface,input:Record<string,unknown>,revision:number) {
  const session=(await apiRead(page,'/api/session')).data;
  const response=await page.request.put('/api/request-draft',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{role:session.actor.role,expectedRevision:revision,operationId:randomUUID(),input}});
  expect(response.status()).toBe(200);return (await response.json()).data;
}
const draftInput=(detail:string)=>({category:'장비/체계',systemType:'인터넷',resourceType:'PC',workType:'지원',detail,location:'업무 위치',contact:'000-0000',attachments:[]});
async function draftSaved(page:Page) {await expect(page.getByRole('status').filter({hasText:'신청서를 임시저장했습니다.'})).toBeVisible();}
async function revealNavItem(page:Page,name:string) {
  const nav=page.getByRole('navigation',{name:'주 메뉴'});
  const workItems=['내 신청','신청 관리','관련 신청','대리 등록','작업 신청','요청 현황(BNOC)','선조치 후보고','계획 정비'];
  const groupName=workItems.includes(name)?'업무':['공지게시판','알림함'].includes(name)?'소통':['권한 관리'].includes(name)?'관리':'부대 현황';
  const groups=nav.locator('.nav-group');
  let group=groups.nth(0);
  for(let index=0;index<await groups.count();index++){const candidate=groups.nth(index);if((await candidate.locator('summary').innerText()).includes(groupName)){group=candidate;break;}}
  if(await group.getAttribute('open')===null) await group.locator('summary').click();
  return group.locator('.nav-group__panel').getByRole('button',{name,exact:true});
}
async function navItem(page:Page,name:string) { await (await revealNavItem(page,name)).click(); }
async function draftKeyboard(page:Page,name:string) {
  const button=page.getByRole('button',{name,exact:true});await expect(button).toBeEnabled();
  await (await revealNavItem(page,'작업 신청')).focus();
  for(let step=0;step<30;step++){await page.keyboard.press('Tab');if(await button.evaluate(element=>element===document.activeElement))break;}
  await expect(button).toBeFocused();await page.keyboard.press('Enter');
}
async function departmentRecord(page: Page, kind: 'personnel' | 'night-duty', department: string, date: string) {
  return (await apiRead(page, `/api/${kind}?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find((item: { department: string }) => item.department === department);
}
async function unenteredPastDates(page: Page, department: string) {
  const selected: string[] = [];
  const start = Date.now() - (30 + parseInt(randomUUID().slice(0, 8), 16) % 3650) * 86400000;
  for (let offset = 0; offset < 64 && selected.length < 2; offset++) {
    const date = new Date(start - offset * 86400000).toISOString().slice(0, 10);
    const records = await Promise.all(['personnel', 'night-duty'].map(kind => departmentRecord(page, kind as 'personnel' | 'night-duty', department, date)));
    if (records.every(record => record?.submitted === false)) selected.push(date);
  }
  expect(selected, 'choose isolated past records without removing existing data').toHaveLength(2);
  return selected;
}
type PublicPerson = { personRef: string; displayName: string; active?: boolean };
async function dailyPersonControl(page: Page, department: string, entries: PublicPerson[], personRef: string) {
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: department, exact: true }) });
  const controls = section.getByRole('combobox');
  await expect(controls).toHaveCount(entries.length);
  const index = entries.findIndex(person => person.personRef === personRef);
  expect(index, 'the selected department date contains the exact public person reference').toBeGreaterThanOrEqual(0);
  const control = controls.nth(index);
  await expect(control).toHaveAccessibleName(`${entries[index].displayName} 현황`);
  return control;
}
async function nightPersonControl(page: Page, department: string, roster: PublicPerson[], retained: PublicPerson[], personRef: string) {
  const active = roster.filter(person => person.active !== false);
  const people = [...active, ...retained.filter(person => !active.some(entry => entry.personRef === person.personRef))];
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: department, exact: true }) });
  const controls = section.getByRole('group', { name: '근무자', exact: true }).getByRole('checkbox');
  await expect(controls).toHaveCount(people.length);
  const index = people.findIndex(person => person.personRef === personRef);
  expect(index, 'active roster and retained historical choices contain the exact public person reference').toBeGreaterThanOrEqual(0);
  const control = controls.nth(index);
  await expect(control).toHaveAccessibleName(people[index].displayName + (people[index].active === false ? ' · 비활성' : ''));
  return control;
}
async function loginWithPopup(page: Page, subject: string) {
  await expect(page.getByRole('button', { name: /SSO.*로그인/ })).toBeVisible();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: /SSO.*로그인/ }).click();
  const popup = await opened;
  await expect(popup.getByRole('combobox')).toBeVisible();
  await popup.getByRole('combobox').selectOption(subject);
  await popup.getByRole('button', { name: /인증|로그인/ }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await expect(page.getByLabel('사용자 전환')).toHaveCount(0);
}
async function switchWithPopup(page: Page, subject: string) {
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await loginWithPopup(page, subject);
}
async function legacyFields(page: Page, text: string) {
  await page.getByRole('combobox', { name: '체계 종류', exact: true }).selectOption('인트라넷');
  await page.getByRole('combobox', { name: '자원 유형', exact: true }).selectOption('PC');
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('지원');
  const detail = page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ });
  const example = '예: 인트라넷 PC 지원 작업이라면 필요한 지원 내용과 희망 시점을 적어주세요.';
  await expect(detail).toHaveAttribute('placeholder', example);
  const location = page.getByLabel('작업 위치', { exact: true });
  await expect(location).toHaveAttribute('placeholder', '예: 건물 층 부서명 등 작업 위치를 적어주세요.');
  await expect(detail).toBeVisible();
  await detail.fill(text);
  expect(await detail.evaluate(element => element.matches(':placeholder-shown'))).toBe(false);
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('고장');
  await expect(detail).toHaveValue(text);
  await expect(detail).toHaveAttribute('placeholder', '예: 인트라넷 PC 고장 작업이라면 발생 증상과 처음 확인한 시점을 적어주세요.');
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('지원');
  await expect(detail).toHaveValue(text);
  await location.fill('요청 위치');
  expect(await location.evaluate(element => element.matches(':placeholder-shown'))).toBe(false);
  await page.getByLabel('요청자 군내전화번호', { exact: true }).fill('000-0000');
}
// FR-056 / UC-028: registration reveals one question; after-action keeps the legacy fields.
const question=(page:Page)=>page.getByRole('region',{name:'현재 질문',exact:true});
async function fields(page:Page,text:string,stop:'review'|'itemReview'|'detail'='review') {
  await question(page).getByRole('button',{name:'지원',exact:true}).click();
  await question(page).getByRole('button',{name:'장비 지원',exact:true}).click();
  await page.getByRole('button',{name:'컴퓨터 추가',exact:true}).click();
  await page.getByRole('button',{name:'선택한 대상 계속',exact:true}).click();
  await page.getByLabel('어디에 있나요?',{exact:true}).fill('요청 위치');
  await question(page).getByRole('button',{name:'다음',exact:true}).click();
  await page.getByLabel('어떤 도움이 필요한가요?',{exact:true}).fill(text);
  if(stop==='detail')return;
  await question(page).getByRole('button',{name:'다음',exact:true}).click();
  await guidedReady(page);
  if(await page.getByRole('heading',{name:'신청 내용을 확인해 주세요',exact:true}).isVisible()){
    await guidedExtra(page,'망·체계');await question(page).getByRole('button',{name:'인트라넷',exact:true}).click();
    if(stop==='itemReview')await guidedItemReview(page);else await guidedReady(page);
  }
}

async function guidedReady(page:Page) {
  if(await page.getByRole('button',{name:'이 대상 확인 완료',exact:true}).isVisible())await page.getByRole('button',{name:'이 대상 확인 완료',exact:true}).click();
  const contact=page.getByLabel('요청자 군내전화번호',{exact:true});
  if(await contact.isVisible()){
    if(!(await contact.inputValue()).trim())await contact.fill('000-0000');
    await question(page).getByRole('button',{name:'다음',exact:true}).click();
  }
}
async function guidedItemReview(page:Page) {
  if(!await page.getByRole('button',{name:'이 대상 확인 완료',exact:true}).isVisible())await page.getByRole('button',{name:/단계 대상 정보$/}).click();
  await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeVisible();
}
async function guidedExtra(page:Page,field:string) {
  await guidedItemReview(page);
  const extra=question(page).locator('details.intake-optional-information');
  if(await extra.getAttribute('open')===null)await extra.locator('summary').click();
  await question(page).getByRole('button',{name:field+' 수정',exact:true}).click();
}
async function guidedDetail(page:Page,text:string,ready=true) {
  if(!await page.getByLabel('어떤 도움이 필요한가요?',{exact:true}).isVisible()){
    await guidedItemReview(page);
    await question(page).getByRole('button',{name:'내용 수정',exact:true}).click();
  }
  await page.getByLabel('어떤 도움이 필요한가요?',{exact:true}).fill(text);
  if(ready){await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);}
}
async function expectGuidedDetail(page:Page,text:string,summary=`컴퓨터 지원 1대 / 요청 위치 / 인트라넷 / ${text}`){
  // Restoration can replace a current input with its answer list. Retry the view,
  // but keep exact value equality in every view, including a frozen final review.
  await expect(async()=>{
    const shown=await question(page).evaluateAll(sections=>{
      const section=sections[0];if(!section)return null;
      const input=section.querySelector<HTMLTextAreaElement>('textarea[aria-label="어떤 도움이 필요한가요?"]');
      if(input)return {view:'input',value:input.value};
      const row=[...section.querySelectorAll('.intake-answer-list > div')].find(row=>row.querySelector('dt')?.textContent==='내용');
      if(row)return {view:'answer',value:row.querySelector('dd')?.textContent};
      const summary=section.querySelector('.intake-summary-detail');
      return summary?{view:'summary',value:summary.textContent}:null;
    });
    expect(shown,'current detail value is present').not.toBeNull();
    expect(shown!.value).toBe(text);
    if(shown!.view==='summary')for(const value of summary.split(' / ').slice(1))await expect(question(page).locator('.intake-summary').first()).toContainText(value);
  }).toPass({timeout:12000});
}
async function expectGuidedEmpty(page:Page){
  await expect(page.getByRole('heading',{name:'무엇을 신청할까요?',exact:true})).toBeVisible();
  await expect(page.locator('.guided-intake').getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.intake-choices button')).toHaveText(['고장','신설','지원','기타']);
  await expect(page.locator('.intake-targets')).toHaveCount(0);
}
async function guidedAttachments(page:Page){
  await guidedItemReview(page);
  const section=question(page).locator('details').filter({has:page.locator('summary').filter({hasText:'사진·문서 첨부'})});
  if(await section.getAttribute('open')===null)await section.locator('summary').click();
  return page.getByLabel('이 대상의 첨부파일',{exact:true});
}
async function guidedOptional(page:Page){
  if(!await page.getByLabel('요청자 군내전화번호',{exact:true}).isVisible())await page.getByRole('button',{name:/단계 연락처$/}).click();
  const section=question(page).locator('details').filter({has:page.locator('summary').filter({hasText:'희망 일정·추가 연락처·정비대상자'})});
  if(await section.getAttribute('open')===null)await section.locator('summary').click();
}
async function guidedMeeting(page:Page,text:string,location='회의 위치'){
  await question(page).getByRole('button',{name:'지원',exact:true}).click();
  await question(page).getByRole('button',{name:'회의 지원',exact:true}).click();
  await question(page).getByRole('button',{name:'화상회의',exact:true}).click();
  await question(page).getByRole('button',{name:'KJCCS',exact:true}).click();
  await page.getByLabel('어떤 지원이 필요한가요?',{exact:true}).fill(text);
  await question(page).getByRole('button',{name:'다음',exact:true}).click();
  await page.getByLabel('회의 장소는 어디인가요?',{exact:true}).fill(location);
  await question(page).getByRole('button',{name:'다음',exact:true}).click();
}
const draftDetail=(value:any)=>value.draft.input.guidedDraft?.items[0]?.detail??value.draft.input.detail;
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'PC_DOCUMENT_MUST_NOT_OVERFLOW').toBeTruthy();
}
async function humanHistory(page: Page, prioritySummary: string, assignedAt: string) {
  const history = page.locator('section.history');
  await expect(history.getByRole('heading', { name: '처리 이력', exact: true })).toBeVisible();
  const priority = history.getByRole('listitem').filter({ hasText: /일반·긴급:/ }).first().locator('strong');
  await expect(priority).toHaveText(prioritySummary);
  const assignment = history.getByRole('listitem').filter({ hasText: /배정 시각\(접수 시간\):/ }).first().locator('strong');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(assignedAt));
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  const month = Number(part('month')), day = Number(part('day'));
  const hour = part('hour') === '00' ? '(?:00|24)' : part('hour');
  const localTime = new RegExp(`^배정 시각\\(접수 시간\\):\\s*${part('year')}\\D+${month < 10 ? '0?' : ''}${month}\\D+${day < 10 ? '0?' : ''}${day}\\D+${hour}:${part('minute')}\\s*$`);
  await expect(assignment).toHaveText(localTime);
  await expect(history).not.toContainText(/\b(?:urgent|general)\b|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  const file = path.resolve(evidence, `server-${info.project.name}-${label}.png`);
  const height=await page.evaluate(()=>document.documentElement.scrollHeight);
  if(info.project.name.startsWith('firefox-')&&height>32000) {
    const width=page.viewportSize()!.width,parts=[];
    for(let y=0;y<height;y+=16000) {
      const part=file.replace(/\.png$/,`-part-${parts.length+1}.png`),clip={x:0,y,width,height:Math.min(16000,height-y)};
      await page.screenshot({path:part,fullPage:true,clip});parts.push({path:part,clip});
      await info.attach(`${label}-part-${parts.length}`,{path:part,contentType:'image/png'});
    }
    const manifest=file.replace(/\.png$/,'.json');await writeFile(manifest,JSON.stringify({reason:'Firefox screenshot height limit32767',height,width,parts},null,2));
    await info.attach(label,{path:manifest,contentType:'application/json'});return;
  }
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(label, { path: file, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  scriptErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
});

test.afterEach(async ({ page }, info) => {
  const errors = scriptErrors.get(page) ?? [];
  await info.attach('browser-script-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
  expect(errors, 'browser scripts must not throw unhandled errors').toEqual([]);
});

test('draft: incomplete input and completed uploads survive closing and logging in, with explicit keyboard restore',async({page,context},info)=>{
  await resetRequestDraft(page);const count=(await apiRead(page,'/api/requests?size=100')).total;
  const text=`미완성 초안 ${info.project.name} ${randomUUID()}`;
  await page.goto('/new');await fields(page,text);await guidedOptional(page);
  await page.getByRole('checkbox',{name:'정비대상자가 요청자와 다름',exact:true}).check();
  await page.getByLabel('정비대상자 이름',{exact:true}).fill('작성 중 대상');
  await page.getByRole('checkbox',{name:'정비대상자가 요청자와 다름',exact:true}).uncheck();
  await page.getByLabel('2지망 날짜',{exact:true}).fill('2026-10-30');
  const fileName=`draft-${info.project.name}.txt`;
  await (await guidedAttachments(page)).setInputFiles({name:fileName,mimeType:'text/plain',buffer:Buffer.from('persistent draft bytes')});
  await expect(page.getByRole('button',{name:fileName+' 첨부 제외',exact:true})).toBeVisible();
  await draftKeyboard(page,'임시저장');await draftSaved(page);
  expect((await apiRead(page,'/api/requests?size=100')).total).toBe(count,'DRAFT_SAVE_MUST_NOT_REGISTER_A_REQUEST');
  const saved=(await apiRead(page,'/api/request-draft')).data;
  expect(saved.draft.input.preference2Date).toBe('2026-10-30');expect(saved.draft.input.preference2Period).toBe('');
  expect(saved.draft.input.guidedDraft.step).toBe('itemReview');expect(draftDetail(saved)).toBe(text);
  const session=(await apiRead(page,'/api/session')).data;
  expect((await page.request.post('/api/auth/logout',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{}})).status()).toBe(200);
  await page.close();const restored=await context.newPage();const errors:string[]=[];restored.on('pageerror',error=>errors.push(error.message));
  try{
    await apiLogin(restored,'requester');await restored.goto('/new');await expectGuidedEmpty(restored);
    await draftKeyboard(restored,'임시저장 불러오기');await expectGuidedDetail(restored,text);
    await guidedAttachments(restored);await expect(restored.getByRole('button',{name:fileName+' 첨부 제외',exact:true})).toBeVisible();
    await guidedReady(restored);await guidedOptional(restored);
    await expect(restored.getByLabel('1지망 날짜',{exact:true})).toHaveValue('');await expect(restored.getByLabel('2지망 날짜',{exact:true})).toHaveValue('2026-10-30');
    await expect(restored.getByLabel('2지망 오전·오후',{exact:true})).toHaveValue('');
    await restored.getByRole('checkbox',{name:'정비대상자가 요청자와 다름',exact:true}).check();await expect(restored.getByLabel('정비대상자 이름',{exact:true})).toHaveValue('작성 중 대상');
    await restored.getByRole('checkbox',{name:'정비대상자가 요청자와 다름',exact:true}).uncheck();
    expect(await restored.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await restored.evaluate(value=>Object.values(localStorage).join('').includes(value)||Object.values(sessionStorage).join('').includes(value),text)).toBe(false);
    await screenshot(restored,info,'persistent-request-draft');
    await guidedDetail(restored,text+' 미저장 변경',false);
    expect(draftDetail((await apiRead(restored,'/api/request-draft')).data)).toBe(text,'UNSAVED_EDITS_MUST_NOT_CHANGE_SERVER_DRAFT');
    expect(errors).toEqual([]);
  }finally{await resetRequestDraft(restored);await restored.close();}
});

test('draft: current writer owns a BNOC draft and restoration or deletion requires explicit confirmation',async({page})=>{
  const inspector={request:await apiRequest.newContext({baseURL:base})};
  try{
    await resetRequestDraft(inspector,'bnoc');const empty=await resetRequestDraft(page);
    await saveDraftApi(page,draftInput('요청자의 마지막 저장본'),empty.revision);
    await apiLogin(inspector,'requester-secondary');expect((await apiRead(inspector,'/api/request-draft')).data.draft).toBeNull();
    await apiLogin(page,'bnoc');await page.goto('/new');await fields(page,'BNOC가 작성 중인 대리 신청','detail');
    await expect(page.getByRole('button',{name:'임시저장',exact:true})).toBeEnabled();await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);
    expect(draftDetail((await apiRead(page,'/api/request-draft')).data)).toBe('BNOC가 작성 중인 대리 신청');
    await apiLogin(page,'requester');await page.goto('/new');
    await expect(page.getByRole('button',{name:'임시저장 불러오기',exact:true})).toBeEnabled();await expectGuidedEmpty(page);
    await fields(page,'현재 작성 중인 내용','detail');
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(page,'현재 작성 중인 내용');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(page,'요청자의 마지막 저장본');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'임시저장 삭제',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'임시저장한 신청서를 삭제했습니다.'})).toBeVisible();await expectGuidedDetail(page,'요청자의 마지막 저장본');
    expect((await apiRead(page,'/api/request-draft')).data.draft).toBeNull();
    await apiLogin(inspector,'bnoc');expect(draftDetail((await apiRead(inspector,'/api/request-draft')).data)).toBe('BNOC가 작성 중인 대리 신청');
    await apiLogin(inspector,'team-wireless');expect((await inspector.request.get('/api/request-draft')).status()).toBe(403);
  }finally{await resetRequestDraft(inspector);await resetRequestDraft(inspector,'bnoc');await inspector.request.dispose();}
});

test('main functions: operations status, central personnel, absences and duty views use live APIs',async({page},info)=>{
  const localDate=(offset=0)=>{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
    const date=new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);
  };
  const today=localDate(),tomorrow=localDate(1),month=today.slice(0,7),suffix=randomUUID().slice(0,8);
  const soldierName=`검수병${suffix}`,officerName=`검수간부${suffix}`,inactiveName=`비활성간부${suffix}`;
  await providerControl(page,{reset:true});await apiLogin(page,'bnoc');
  const createPerson=async(displayName:string,category:'병'|'간부',rank:string,active=true,department=wire)=>{
    const directory=(await apiRead(page,'/api/personnel-roster')).data;
    const saved=await command(page,'saveCentralPerson',{department,category,rank,displayName,serviceNumber:`QA-${randomUUID()}`,internalPhone:'7654',active},{expectedRevision:directory.revision});
    return saved.publicRef as string;
  };
  const soldierRef=await createPerson(soldierName,'병','상병');
  const officerRef=await createPerson(officerName,'간부','대위');
  await createPerson(inactiveName,'간부','소위',false);
  const otherTeamName=`다른부서 인원 ${suffix}`;
  const otherTeamRef=await createPerson(otherTeamName,'병','상병',true,'유선반');
  await command(page,'saveAbsence',{personRef:soldierRef,absenceType:'휴가',startDate:today,endDate:today},{expectedRevision:0});

  await page.goto('/operations-status');
  await expect(page.getByRole('heading',{name:'정보통신 운용현황'})).toBeVisible();
  await expect(page.getByText('전송망 운용태세')).toBeVisible();
  await expect(page.getByRole('heading',{name:'통신시설'})).toBeVisible();
  await expect(page.getByText('주 통신실')).toBeVisible();
  await screenshot(page,info,'main-operations-status');

  await page.goto('/personnel');
  const summary=page.getByRole('region',{name:'일일 병력 현황'});
  await expect(summary).toContainText('총원');await expect(summary).toContainText('현재원');await expect(summary).toContainText('결원');
  await expect(page.getByRole('row').filter({hasText:soldierName})).toContainText('휴가');
  await page.goto('/roster');
  await page.getByRole('row').filter({hasText:soldierName}).getByRole('button',{name:`휴가 ${today} 부재 수정`}).click();
  await expect(page.getByRole('heading',{name:'부재 기간 수정'})).toBeVisible();
  await page.getByLabel('시작일').fill(tomorrow);
  await page.getByLabel('종료일').fill(tomorrow);
  await page.locator('form.personnel-editor').getByRole('button',{name:'수정',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'부재 기간을 수정했습니다.'})).toBeVisible();
  const roster=(await apiRead(page,`/api/personnel-roster?department=${encodeURIComponent(wire)}`)).data.entries.find((item:{personRef:string})=>item.personRef===soldierRef);
  expect(roster.absences[0].startDate).toBe(tomorrow);
  expect(roster.absences[0].endDate).toBe(tomorrow);
  // Keep the evidence focused as the isolated test directory accumulates records.
  await page.getByRole('searchbox',{name:'인원 검색',exact:true}).fill(soldierName);
  await screenshot(page,info,'main-personnel-roster');
  await page.getByRole('searchbox',{name:'인원 검색',exact:true}).fill('');

  await page.route('**/api/personnel-roster*',async route=>{
    const response=await route.fetch();const body=await response.json();
    const existing=body.data.entries.find((item:{personRef:string})=>item.personRef===officerRef);
    existing.category=null;existing.rank=null;existing.complete=false;existing.serviceNumber=null;
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.getByRole('row').filter({hasText:officerName}).getByRole('button',{name:'정보 입력'}).click();
  const personEditor=page.locator('form.personnel-editor');
  await expect(personEditor.locator('select').nth(0)).toHaveValue('');await expect(personEditor.locator('select').nth(1)).toHaveValue('');
  expect(await page.locator('form.personnel-editor').evaluate((form:HTMLFormElement)=>form.checkValidity())).toBe(false);
  await page.locator('form.personnel-editor').getByRole('button',{name:'취소'}).click();
  await page.unroute('**/api/personnel-roster*');

  await page.goto('/night-duty');
  await expect(page.getByRole('heading',{name:'당직 야간근무 현황'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'금일 근무 편성'})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:new RegExp(soldierName)})).toHaveCount(0);
  await expect(page.getByRole('checkbox',{name:new RegExp(inactiveName)})).toBeDisabled();
  await page.locator('details.duty-text-import summary').click();
  await page.getByLabel('근무자 목록').fill(`${today.replaceAll('-','')} 대위 ${officerName}`);
  await page.getByRole('button',{name:'입력한 근무자 추가'}).click();
  await expect(page.getByRole('form',{name:'근무 편성'}).getByText(`대위 ${officerName}`,{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('form',{name:'근무 편성'}).getByText(`대위 ${officerName}`,{exact:true})).toBeVisible();

  await apiLogin(page,'team-wireless');await page.goto('/night-duty');
  await expect(page.getByLabel('근무 자리')).toHaveCount(0);
  await expect(page.getByRole('checkbox',{name:new RegExp(soldierName)})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:new RegExp(inactiveName)})).toBeDisabled();
  await page.locator('details.duty-text-import summary').click();
  await page.getByLabel('근무자 목록').fill(`${today.replaceAll('-','')} 상병 ${otherTeamName}`);
  await page.getByRole('button',{name:'입력한 근무자 추가'}).click();
  const dutyError=page.getByRole('alert').filter({hasText:'입력값을 확인하세요.'});
  await expect(dutyError).toBeVisible();
  const errorBox=await dutyError.boundingBox();
  expect(errorBox&&errorBox.y+errorBox.height<=900,'monthly duty validation must stay in the viewport').toBeTruthy();
  const dutyViewport=await page.evaluate(()=>({height:window.innerHeight,scrollHeight:document.scrollingElement?.scrollHeight,calendarBottom:document.querySelector('.duty-calendar-panel')?.getBoundingClientRect().bottom,editorBottom:document.querySelector('.duty-editor')?.getBoundingClientRect().bottom}));
  expect(dutyViewport.scrollHeight).toBeLessThanOrEqual(dutyViewport.height);
  expect(dutyViewport.calendarBottom).toBeLessThanOrEqual(dutyViewport.height);
  expect(dutyViewport.editorBottom).toBeLessThanOrEqual(dutyViewport.height);
  await screenshot(page,info,'monthly-duty-cross-team-error');
  const rejectedSchedules=(await apiRead(page,`/api/duty-schedules?month=${month}`)).data.entries as {people:{personRef:string}[]}[];
  expect(rejectedSchedules.some(entry=>entry.people.some(person=>person.personRef===otherTeamRef))).toBe(false,'invalid cross-team input must not partially save');
  await page.getByLabel('근무자 목록').fill(`${today.replaceAll('-','')} 상병 ${soldierName}`);
  await page.getByRole('button',{name:'입력한 근무자 추가'}).click();
  await expect(page.getByRole('form',{name:'근무 편성'}).getByText(`상병 ${soldierName}`,{exact:true})).toBeVisible();

  // Unmount the previous team's editor before changing identity. The requester
  // has no mounted app until observation begins, so its first render is covered.
  await page.goto('about:blank');
  await apiLogin(page,'requester');
  let rosterReads=0;const viewerWrites:string[]=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/personnel-roster'&&request.method()==='GET')rosterReads++;if(url.pathname.startsWith('/api/')&&request.method()!=='GET')viewerWrites.push(`${request.method()} ${url.pathname}`);});
  await page.goto('/night-duty');
  await expect(page.getByRole('heading',{name:'금일 근무 편성'})).toBeVisible();
  await expect(page.getByText(`대위 ${officerName}`,{exact:true})).toBeVisible();
  await expect(page.getByText(`상병 ${soldierName}`,{exact:true})).toBeVisible();
  await expect(page.getByRole('form',{name:'근무 편성'})).toHaveCount(0);
  expect(rosterReads,'requester schedule view must not fetch the central roster').toBe(0);
  expect(viewerWrites,'requester schedule view must not write data').toEqual([]);
  await page.goto('/roster');
  await expect(page.getByRole('heading',{name:'접근 권한이 없습니다'})).toBeVisible();
});

test('monthly duty screen adds selected members across dates, replaces one date, and replays a lost save',async({page})=>{
  await apiLogin(page,'bnoc');
  const suffix=randomUUID().slice(0,8);let month='';
  for(let attempt=0;attempt<10;attempt++) {
    const token=randomUUID().slice(0,8),year=2000+parseInt(token.slice(0,4),16)%7000,candidate=`${year}-${String(1+parseInt(token.slice(4),16)%12).padStart(2,'0')}`;
    const entries=(await apiRead(page,`/api/duty-schedules?month=${candidate}&seat=duty_officer`)).data.entries;
    if(!entries.some((entry:{date:string})=>entry.date===`${candidate}-10`||entry.date===`${candidate}-11`)){month=candidate;break;}
  }
  expect(month,'the fixture must use two empty officer dates without overwriting an existing schedule').not.toBe('');
  const firstDate=`${month}-10`,secondDate=`${month}-11`;
  const createOfficer=async(name:string)=>{
    const directory=(await apiRead(page,'/api/personnel-roster')).data;
    const saved=await command(page,'saveCentralPerson',{department:wire,category:'간부',rank:'대위',displayName:name,serviceNumber:`QA-${randomUUID()}`,internalPhone:'7654',active:true},{expectedRevision:directory.revision});
    return saved.publicRef as string;
  };
  const firstName=`합성 A ${suffix}`,secondName=`합성 B ${suffix}`,addedName=`합성 C ${suffix}`;
  const first=await createOfficer(firstName),second=await createOfficer(secondName),added=await createOfficer(addedName);
  await command(page,'saveDutySchedule',{month,date:firstDate,seat:'duty_officer',personRefs:[first]},{expectedRevision:0});
  await command(page,'saveDutySchedule',{month,date:secondDate,seat:'duty_officer',personRefs:[second]},{expectedRevision:0});

  let firstAttempt:Record<string,unknown>|undefined;let retryAttempt:Record<string,unknown>|undefined;let dropped=false;
  await page.route('**/api/commands',async route=>{
    const body=JSON.parse(route.request().postData()||'{}') as Record<string,unknown>;
    if(body.type==='saveDutyScheduleBatch'&&!dropped){const response=await route.fetch();expect(response.status(),'first batch must commit before its response is dropped').toBe(200);firstAttempt=body;dropped=true;await route.abort('failed');return;}
    if(body.type==='saveDutyScheduleBatch'&&dropped&&!retryAttempt)retryAttempt=body;
    await route.continue();
  });
  await page.goto('/night-duty');
  await expect(page.getByRole('heading',{name:'당직 야간근무 현황'})).toBeVisible();
  await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'월',exact:true}).click();
  const waitForDutyRefresh=()=>page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/duty-schedules'&&url.searchParams.get('month')===month&&response.ok();});
  const monthRefresh=waitForDutyRefresh();
  await page.getByLabel('대상 월').fill(month);
  await monthRefresh;
  await expect(page.getByText('불러오는 중…')).toHaveCount(0);
  await expect(page.getByRole('region',{name:`${month} 월간 근무자`})).toBeVisible();
  await page.getByRole('button',{name:`${firstDate} 근무자 보기`}).click();
  await expect(page.getByText('불러오는 중…')).toHaveCount(0);
  await expect(page.getByRole('checkbox',{name:new RegExp(firstName)})).toBeChecked();
  await page.getByRole('button',{name:'여러 날짜 편성'}).click();
  await page.getByRole('checkbox',{name:new RegExp(firstName)}).check();
  await expect(page.getByText('불러오는 중…')).toHaveCount(0);
  await page.getByRole('button',{name:`${secondDate} 근무자 보기`}).click();
  await expect(page.getByText('불러오는 중…')).toHaveCount(0);
  await expect(page.getByRole('checkbox',{name:new RegExp(firstName)})).toBeChecked();
  const addedCheckbox=page.getByRole('checkbox',{name:new RegExp(addedName)});
  await expect(addedCheckbox).toBeVisible();await addedCheckbox.check();
  const editor=page.getByRole('form',{name:'근무 편성'});
  const batchSave=editor.getByRole('button',{name:'2일 야간근무표 저장'});
  await batchSave.click();
  await expect(page.locator('.duty-status-area').getByRole('alert')).toContainText('저장 결과를 확인하지 못했습니다');
  const expiredSession=(await apiRead(page,'/api/session')).data;
  expect((await page.request.post('/api/auth/logout',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':expiredSession.csrfToken},data:{}})).status()).toBe(200);
  await batchSave.click();await expect(page.getByRole('dialog',{name:'로그인 만료',exact:true})).toBeVisible();
  const reloadedDuty=waitForDutyRefresh();await loginWithPopup(page,'bnoc');await reloadedDuty;await expect(page.getByRole('dialog',{name:'로그인 만료',exact:true})).toHaveCount(0);
  await batchSave.click();
  await expect(page.locator('.duty-status-area .duty-feedback')).toContainText('2일 저장');
  expect(retryAttempt?.operationId).toBe(firstAttempt?.operationId,'LOST_DUTY_RESPONSE_MUST_REUSE_OPERATION_ID');
  expect(retryAttempt?.payload).toEqual(firstAttempt?.payload,'LOST_DUTY_RESPONSE_MUST_REUSE_INPUT_AND_VERSIONS');
  const sentEntries=(firstAttempt?.payload as {entries?:{date:string;personRefs:string[]}[]}|undefined)?.entries;
  expect(sentEntries?.map(entry=>[entry.date,[...entry.personRefs].sort()])).toEqual([[firstDate,[first,added].sort()],[secondDate,[first,added].sort()]],'MULTI_DATE_SCREEN_MUST_SEND_THE_INTENDED_SHARED_SELECTION');
  let schedules=(await apiRead(page,`/api/duty-schedules?month=${month}&seat=duty_officer`)).data.entries;
  const refs=(date:string)=>schedules.find((item:{date:string})=>item.date===date).people.map((person:{personRef:string})=>person.personRef);
  expect(new Set(refs(firstDate))).toEqual(new Set([first,added]));
  expect(new Set(refs(secondDate))).toEqual(new Set([second,first,added]));
  expect(refs(secondDate)).toHaveLength(3);
});

test('personnel summary ignores late date responses and binds count to its requested date',async({page})=>{
  const dates=(()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));const today=`${parts.year}-${parts.month}-${parts.day}`;const next=new Date(`${today}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);return [today,next.toISOString().slice(0,10)] as const;})();
  const [today,tomorrow]=dates;let releaseOld!:()=>void;let startedOld!:()=>void;
  const oldGate=new Promise<void>(resolve=>{releaseOld=resolve;});const oldStarted=new Promise<void>(resolve=>{startedOld=resolve;});
  await apiLogin(page,'bnoc');
  await page.route('**/api/personnel?*',async route=>{
    const date=new URL(route.request().url()).searchParams.get('date')||'';
    if(date===today){startedOld();await oldGate;}
    const marker=date===today?101:202;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,queriedAt:new Date().toISOString(),data:{date,total:marker,current:marker,absent:0,departments:[{department:wire,total:marker,current:marker,absent:0,byAbsenceType:{}}]}})});
  });
  try{
    await page.goto('/personnel');await oldStarted;
    await page.getByLabel('기준일').fill(tomorrow);
    const latest=page.getByRole('region',{name:`${tomorrow} 일일 병력 현황`});
    await expect(latest).toContainText('202');
    releaseOld();
    await expect(latest).toContainText('202');
    await expect(page.getByRole('region',{name:`${today} 일일 병력 현황`})).toHaveCount(0);
  }finally{releaseOld();}
});

test('roster and absence forms replay committed saves with the same operation and input',async({page})=>{
  await apiLogin(page,'bnoc');
  const captured=new Map<string,Record<string,unknown>>(),retried=new Map<string,Record<string,unknown>>(),dropped=new Set<string>();
  await page.route('**/api/commands',async route=>{
    const body=JSON.parse(route.request().postData()||'{}') as Record<string,unknown>;const type=String(body.type);
    if(['saveCentralPerson','saveAbsence'].includes(type)&&!dropped.has(type)){
      const response=await route.fetch();expect(response.status(),`${type} must commit before response loss`).toBe(200);captured.set(type,body);dropped.add(type);await route.abort('failed');return;
    }
    if(dropped.has(type)&&!retried.has(type))retried.set(type,body);
    await route.continue();
  });
  await page.goto('/roster');await page.getByRole('button',{name:'인원 등록'}).click();
  const editor=page.locator('form.personnel-editor').first();const name=`재시도 합성 인원 ${randomUUID().slice(0,8)}`;
  await editor.getByLabel('구분').selectOption('병');await editor.getByLabel('계급·직급').selectOption('상병');await editor.getByLabel('이름').fill(name);
  await editor.getByLabel('소속 부서').selectOption(wire);await editor.getByLabel('군번').fill(`QA-${randomUUID()}`);
  await editor.getByRole('button',{name:'저장',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('저장 결과를 확인하지 못했습니다');
  await editor.getByRole('button',{name:'저장 결과 다시 확인',exact:true}).click();await expect(page.getByRole('status')).toContainText(`${name} 등록됨`);
  const roster=(await apiRead(page,`/api/personnel-roster?department=${encodeURIComponent(wire)}`)).data.entries.filter((person:{displayName:string})=>person.displayName===name);
  expect(roster).toHaveLength(1);expect(retried.get('saveCentralPerson')?.operationId).toBe(captured.get('saveCentralPerson')?.operationId);
  expect(retried.get('saveCentralPerson')?.payload).toEqual(captured.get('saveCentralPerson')?.payload);
  expect(retried.get('saveCentralPerson')?.expectedRevision).toBe(captured.get('saveCentralPerson')?.expectedRevision);

  await page.getByRole('button',{name:'부재 등록'}).click();const absenceEditor=page.locator('form.personnel-editor').last();await absenceEditor.getByLabel('대상 부서').selectOption(wire);
  await absenceEditor.getByLabel('인원').selectOption(roster[0].personRef);await absenceEditor.getByLabel('시작일').fill('2026-10-10');await absenceEditor.getByLabel('종료일').fill('2026-10-10');
  await absenceEditor.getByRole('button',{name:'등록',exact:true}).click();await expect(absenceEditor.getByRole('alert')).toContainText('저장 결과를 확인하지 못했습니다');
  await absenceEditor.getByRole('button',{name:'저장 결과 다시 확인',exact:true}).click();await expect(page.getByRole('status')).toContainText('부재 기간을 등록했습니다.');
  expect(retried.get('saveAbsence')?.operationId).toBe(captured.get('saveAbsence')?.operationId);
  expect(retried.get('saveAbsence')?.payload).toEqual(captured.get('saveAbsence')?.payload);
  expect(retried.get('saveAbsence')?.expectedRevision).toBe(captured.get('saveAbsence')?.expectedRevision);
  const finalRoster=(await apiRead(page,`/api/personnel-roster?department=${encodeURIComponent(wire)}`)).data.entries.find((person:{personRef:string})=>person.personRef===roster[0].personRef);
  expect(finalRoster.absences).toHaveLength(1);
});

test('a team can remove an existing assignee who later becomes inactive',async({page})=>{
  const name=`기존 배정 ${randomUUID().slice(0,8)}`,serviceNumber=`QA-${randomUUID()}`;
  await apiLogin(page,'bnoc');
  let directory=(await apiRead(page,'/api/personnel-roster')).data;
  const created=await command(page,'saveCentralPerson',{department:wire,category:'병',rank:'상병',displayName:name,serviceNumber,internalPhone:'7654',active:true},{expectedRevision:directory.revision});
  const personRef=created.publicRef as string;
  const requestNumber=await seed(page,'비활성 담당자 해제 확인',[wire]);
  await apiLogin(page,'team-wireless');
  let detail=(await apiRead(page,`/api/requests/${requestNumber}`)).data;
  let work=detail.workItems.find((item:{teamId:string})=>item.teamId===wire);
  await command(page,'updateWork',{nextStatus:work.status,assignedPersonRefs:[personRef]},{requestNumber,workNumber:work.workNumber,expectedRevision:work.revision});
  await apiLogin(page,'bnoc');directory=(await apiRead(page,'/api/personnel-roster')).data;
  await command(page,'saveCentralPerson',{personRef,department:wire,category:'병',rank:'상병',displayName:name,serviceNumber,internalPhone:'7654',active:false},{expectedRevision:directory.revision});
  await apiLogin(page,'team-wireless');await page.goto(`/requests/${requestNumber}`);
  await expect(page.getByRole('heading',{name:'현재 배정 · 명부 확인 필요'})).toBeVisible();
  await expect(page.locator('.work-execution').getByText('불러오는 중…',{exact:true})).toHaveCount(0);
  const assigned=page.getByRole('checkbox',{name:new RegExp(name)});
  await expect(assigned).toBeChecked();await expect(assigned).toBeEnabled();await assigned.click();
  await expect(page.getByRole('heading',{name:'현재 배정 · 명부 확인 필요'})).toHaveCount(0);
  await page.getByRole('button',{name:'상태 저장',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'상태·일정·담당 인원을 저장했습니다.'})).toBeVisible();
  detail=(await apiRead(page,`/api/requests/${requestNumber}`)).data;
  work=detail.workItems.find((item:{teamId:string})=>item.teamId===wire);
  expect(work.assignedPersonRefs).toEqual([]);
});

test('administrator calendar displays planned work without assigned work details',async({page})=>{
  const dateParts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  const date=`${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const title=`관리자 계획 달력 ${randomUUID().slice(0,8)}`;
  await apiLogin(page,'team-wireless');
  const session=(await apiRead(page,'/api/session')).data;
  const created=await page.request.post('/api/planned-works',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{operationId:randomUUID(),title,firstWorkDate:date}});
  expect(created.status()).toBe(200);
  await apiLogin(page,'access-admin');await page.goto('/schedule');
  await expect(page.getByRole('heading',{name:'정비 달력'})).toBeVisible();
  await expect(page.locator('.calendar-planned-list').getByText(title,{exact:true}).first()).toBeVisible();
  await expect(page.getByText(/기간 내 예정 작업 0건/)).toBeVisible();
  await expect(page.locator('.calendar-item').filter({hasText:title}).first()).toBeVisible();
});

test('draft: two tabs reject stale writes and recover after deletion without losing the current input',async({page,context})=>{
  const empty=await resetRequestDraft(page);const first=await saveDraftApi(page,draftInput('공통 시작 초안'),empty.revision);
  const before=(await apiRead(page,'/api/requests?size=100')).total;
  await page.goto('/new');await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(page,'공통 시작 초안');
  const other=await context.newPage();
  try{
    await other.goto('/new');await other.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(other,'공통 시작 초안');
    await guidedDetail(page,'먼저 저장한 탭');await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);
    await guidedDetail(other,'충돌 뒤에도 유지할 입력');await other.getByRole('button',{name:'임시저장',exact:true}).click();
    await expect(other.getByRole('alert')).toContainText('다른 화면에서 임시저장이 변경');await expectGuidedDetail(other,'충돌 뒤에도 유지할 입력','컴퓨터 지원 1대 / 업무 위치 / 인터넷 / 충돌 뒤에도 유지할 입력');
    other.once('dialog',dialog=>dialog.accept());await other.getByRole('button',{name:'임시저장 삭제',exact:true}).click();await expect(other.getByRole('alert')).toContainText('다른 화면에서');
    const denied=other.waitForResponse(response=>new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST');
    await other.getByRole('button',{name:'신청 등록',exact:true}).click();expect((await denied).status()).toBe(409);
    expect((await apiRead(page,'/api/requests?size=100')).total).toBe(before);expect(draftDetail((await apiRead(page,'/api/request-draft')).data)).toBe('먼저 저장한 탭');
    const current=(await apiRead(page,'/api/request-draft')).data;const session=(await apiRead(page,'/api/session')).data;
    expect((await page.request.delete('/api/request-draft',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{role:'requester',expectedRevision:current.revision,operationId:randomUUID()}})).status()).toBe(200);
    other.once('dialog',dialog=>dialog.accept());await other.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();
    await expect(other.getByRole('status').filter({hasText:'임시저장한 신청서가 없습니다.'})).toBeVisible();await expectGuidedDetail(other,'충돌 뒤에도 유지할 입력','컴퓨터 지원 1대 / 업무 위치 / 인터넷 / 충돌 뒤에도 유지할 입력');
    await expect(other.getByRole('button',{name:'임시저장',exact:true})).toBeEnabled();await other.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(other);
    const recreated=(await apiRead(other,'/api/request-draft')).data;expect(recreated.draft.id).not.toBe(first.draft.id);expect(draftDetail(recreated)).toBe('충돌 뒤에도 유지할 입력');
    const posted=other.waitForResponse(response=>new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST');await other.getByRole('button',{name:'신청 등록',exact:true}).click();expect((await posted).status()).toBe(200);
    expect((await apiRead(other,'/api/request-draft')).data.draft).toBeNull();
  }finally{await resetRequestDraft(other);await other.close();}
});

test('draft: a lost save and same-account reauthentication keep the same draft operation and input',async({page})=>{
  await resetRequestDraft(page);await page.goto('/new');await fields(page,'응답 유실 임시저장');
  const sent:Record<string,unknown>[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/request-draft'&&request.method()==='PUT')sent.push(request.postDataJSON());});
  let lost=false;await page.route('**/api/request-draft',async route=>{if(route.request().method()!=='PUT'||lost)return route.continue();lost=true;expect((await route.fetch()).status()).toBe(200);await route.abort('failed');});
  await page.getByRole('button',{name:'임시저장',exact:true}).click();await expect(page.getByRole('alert')).toContainText('같은 제출');
  await expect(page.getByRole('button',{name:'2단계 대상 선택',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'4단계 연락처',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'이전',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toBeDisabled();
  const committed=(await apiRead(page,'/api/request-draft')).data;
  await page.unroute('**/api/request-draft');await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);
  expect((await apiRead(page,'/api/request-draft')).data.revision).toBe(committed.revision);expect(sent[0]).toEqual(sent[1]);
  await guidedDetail(page,'같은 계정 재인증 뒤 임시저장');
  const session=(await apiRead(page,'/api/session')).data;expect((await page.request.post('/api/auth/logout',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{}})).status()).toBe(200);
  await page.getByRole('button',{name:'임시저장',exact:true}).click();await expect(page.getByRole('dialog',{name:'로그인 만료',exact:true})).toBeVisible();
  await loginWithPopup(page,'requester');await expect(page.getByRole('dialog',{name:'로그인 만료',exact:true})).toHaveCount(0);
  await expectGuidedDetail(page,'같은 계정 재인증 뒤 임시저장');
  await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);
  expect(sent.at(-1)).toEqual(sent.at(-2));expect(draftDetail((await apiRead(page,'/api/request-draft')).data)).toBe('같은 계정 재인증 뒤 임시저장');
  await resetRequestDraft(page);
});

test('draft: a meeting may be saved incomplete but restored files are required and consumed with formal registration',async({page},info)=>{
  await resetRequestDraft(page);await page.goto('/new');await guidedMeeting(page,'임시저장 회의');
  await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);
  await expect(question(page).getByRole('button',{name:'다음',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);
  const incomplete=(await apiRead(page,'/api/request-draft')).data;expect(incomplete.draft.input.guidedDraft.meeting.meetingType).toBe('화상회의');expect(incomplete.draft.input.attachments).toEqual([]);
  const bytes=await readFile('frontend/src/preview/fixtures/support.hwp'),name=`draft-meeting-${info.project.name}.hwp`;
  await page.getByLabel('화상회의 지원 의뢰서',{exact:true}).setInputFiles({name,mimeType:'application/octet-stream',buffer:bytes});await expect(page.getByRole('button',{name:name+' 첨부 제외',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'임시저장',exact:true}).click();await draftSaved(page);const saved=(await apiRead(page,'/api/request-draft')).data;
  await page.reload();await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expect(page.getByRole('heading',{name:'회의 지원 의뢰서를 첨부해 주세요',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:name+' 첨부 제외',exact:true})).toBeVisible();
  await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);
  const response=page.waitForResponse(result=>new URL(result.url()).pathname==='/api/commands'&&result.request().method()==='POST');await page.getByRole('button',{name:'신청 등록',exact:true}).click();
  const received=await response;expect(received.status()).toBe(200);const result=await received.json();expect(received.request().postDataJSON().payload.draftRef.id).toBe(saved.draft.id);
  const detail=(await apiRead(page,`/api/requests/${result.requestNumber}`)).data;expect(detail.attachments[0].id).toBe(saved.draft.input.attachments[0].id);expect(detail.status).toBe('대기');expect(detail.workItems).toEqual([]);expect(detail.subcategories).toEqual({meetingType:'화상회의',videoPlatform:'KJCCS'});
  expect((await apiRead(page,'/api/request-draft')).data.draft).toBeNull();const downloaded=await page.request.get(`/api/attachments/${detail.attachments[0].id}`);expect(downloaded.status()).toBe(200);expect(await downloaded.body()).toEqual(bytes);
});

test('draft: saved drafts never overwrite request reuse automatically and late saves cannot transfer across accounts',async({page})=>{
  const inspector={request:await apiRequest.newContext({baseURL:base})};await resetRequestDraft(inspector,'bnoc');const empty=await resetRequestDraft(page);await saveDraftApi(page,draftInput('명시적으로 불러올 저장본'),empty.revision);
  const number=await seed(page,'과거 요청에서 불러온 내용');await page.goto(`/requests/${number}`);await page.getByRole('button',{name:'새 요청으로 불러오기',exact:true}).click();
  await expectGuidedDetail(page,'과거 요청에서 불러온 내용');await expect(page.getByRole('button',{name:'임시저장 불러오기',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(page,'과거 요청에서 불러온 내용');
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'임시저장 불러오기',exact:true}).click();await expectGuidedDetail(page,'명시적으로 불러올 저장본');
  let release:()=>void=()=>{},started:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),captured=new Promise<void>(resolve=>{started=resolve;});let heldRequest:import('@playwright/test').Request|undefined;
  await page.route('**/api/request-draft',async route=>{if(route.request().method()!=='PUT')return route.continue();heldRequest=route.request();const response=await route.fetch();expect(response.status()).toBe(200);started();await held;await route.fulfill({response});});
  try{
    await guidedDetail(page,'이전 계정의 늦은 임시저장',false);await page.getByRole('button',{name:'임시저장',exact:true}).click();await captured;
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'로그아웃',exact:true}).click();await loginWithPopup(page,'bnoc');await navItem(page,'대리 등록');await expect(page.getByRole('button',{name:'임시저장',exact:true})).toBeEnabled();
    const arrived=page.waitForResponse(response=>response.request()===heldRequest);release();await(await arrived).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expectGuidedEmpty(page);expect((await apiRead(page,'/api/request-draft')).data.draft).toBeNull();
    await apiLogin(inspector,'requester');expect(draftDetail((await apiRead(inspector,'/api/request-draft')).data)).toBe('이전 계정의 늦은 임시저장');
  }finally{release();await page.unroute('**/api/request-draft');await resetRequestDraft(inspector);await resetRequestDraft(inspector,'bnoc');await inspector.request.dispose();}
});

test('draft: an unknown formal submission freezes draft actions until the original receipt is recovered even after SAVE_FAILED',async({page})=>{
  await resetRequestDraft(page);const before=(await apiRead(page,'/api/requests?size=100')).total;await page.goto('/new');await fields(page,'접수 응답 유실 후 초안 조작 방지');await expect(page.getByRole('button',{name:'임시저장',exact:true})).toBeEnabled();
  const submissions:Record<string,unknown>[]=[];let number='';
  await page.route('**/api/commands',async route=>{submissions.push(route.request().postDataJSON());if(submissions.length===1){const response=await route.fetch();expect(response.status()).toBe(200);number=(await response.json()).requestNumber;await route.abort('failed');}else if(submissions.length===2)await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'SAVE_FAILED',message:'처리를 확인하지 못했습니다. 같은 제출 번호로 다시 확인하세요.'})});else await route.continue();});
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  for(const label of ['임시저장','임시저장 불러오기','임시저장 삭제'])await expect(page.getByRole('button',{name:label,exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'2단계 대상 선택',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'4단계 연락처',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'이전',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('alert')).toContainText('같은 제출 번호');await expect(page.getByRole('button',{name:'임시저장',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/requests/${number}`);expect(submissions).toHaveLength(3);expect(submissions[1]).toEqual(submissions[0]);expect(submissions[2]).toEqual(submissions[0]);
  expect((await apiRead(page,'/api/requests?size=100')).total).toBe(before+1);expect((await apiRead(page,'/api/request-draft')).data.draft).toBeNull();
});

test('an ordinary HWP attachment opens as original pages and keeps extraction as a secondary view', async ({ page }, info) => {
  await apiLogin(page, 'requester');
  const bytes = await readFile('frontend/src/preview/fixtures/support.hwp');
  const name = `원본 페이지-${randomUUID().slice(0, 8)}.hwp`;
  const uploaded = await page.request.post('/api/attachments?resourceKind=request', {
    headers: { Origin: new URL(base).origin, 'X-CSRF-Token': (await apiRead(page, '/api/session')).data.csrfToken },
    multipart: { file: { name, mimeType: 'application/octet-stream', buffer: bytes } },
  });
  expect(uploaded.status()).toBe(200);
  const attachment = (await uploaded.json()).data;
  const unlinkedSource = await page.request.get(`/api/attachments/${attachment.id}/render-source`);
  expect(unlinkedSource.status()).toBe(200, 'OWNER_UNLINKED_HWP_PREVIEW_ALLOWED');
  expect((await unlinkedSource.body()).equals(bytes)).toBeTruthy();
  const created = await command(page, 'createRequest', { ...requestPayload('HWP 원본 페이지 보기'), attachments: [{ id: attachment.id }] });
  await expect.poll(async () => (await (await page.request.get(`/api/attachments/${attachment.id}/document`)).json()).data.status, { timeout: 30000 }).toBe('ready');
  const source = await page.request.get(`/api/attachments/${attachment.id}/render-source`);
  expect(source.status()).toBe(200, 'AUTHORIZED_HWP_RENDER_SOURCE_REQUIRED');
  expect((await source.body()).equals(bytes), 'RENDER_SOURCE_MUST_PRESERVE_HWP_BYTES').toBeTruthy();

  let shownPending = false;
  await page.route(`**/api/attachments/${attachment.id}/document?**`, async route => {
    const response = await route.fetch(), body = await response.json();
    if (!shownPending) { body.data.status = 'pending'; shownPending = true; }
    return route.fulfill({ response, json: body });
  });

  await page.goto(`/requests/${created.requestNumber}`);
  await page.getByRole('link', { name, exact: true }).locator('xpath=..').getByRole('button', { name: '문서 보기', exact: true }).click();
  const viewer = page.getByRole('dialog');
  const pageImage = viewer.locator('.hwp-page-view__image');
  await expect(pageImage).toHaveAttribute('alt', `${name} 1쪽`);
  await expect.poll(() => pageImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBeTruthy();
  await expect(viewer.getByRole('status').first()).toContainText('분석 완료');
  await expect(pageImage).toBeVisible();
  await expect(viewer.getByRole('button', { name: '원본 보기', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, info, 'hwp-original-page-view');
  await viewer.getByRole('button', { name: '추출 본문', exact: true }).click();
  await expect(viewer.locator('.document-dialog__body')).toContainText('마이크 점검');
  await viewer.getByRole('button', { name: '원본 보기', exact: true }).click();
  await expect(pageImage).toBeVisible();
});

test('reuse a closed own request as an unsaved new application without copying its work schedule or files', async ({ page }, info) => {
  const session=await apiLogin(page,'requester');
  const uploaded=await page.request.post('/api/attachments?resourceKind=request',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},multipart:{file:{name:'과거-첨부.txt',mimeType:'text/plain',buffer:Buffer.from('기존 첨부')}}});
  expect(uploaded.status()).toBe(200);const attachment=(await uploaded.json()).data;
  const originalText=`반복 지원 ${info.project.name} ${randomUUID()}`;
  const created=await command(page,'createRequest',{...requestPayload(originalText),location:'반복 업무 위치',equipmentId:'공통 장비',documentRef:'기존 참조',personalContact:'000-0000-0000',schedulePreferences:[{rank:1,date:'2026-10-26',period:'AM'}],attachments:[{id:attachment.id}]});
  await apiLogin(page,'bnoc');
  let source=(await apiRead(page,`/api/requests/${created.requestNumber}`)).data;
  await command(page,'assignTeams',{teamIds:[wire],priority:'urgent'},{requestNumber:source.requestNumber,expectedRevision:source.revision});
  await apiLogin(page,'requester');
  source=(await apiRead(page,`/api/requests/${created.requestNumber}`)).data;
  await command(page,'cancelRequest',{},{requestNumber:source.requestNumber,expectedRevision:source.revision});
  const before=(await apiRead(page,`/api/requests/${created.requestNumber}`)).data;
  const count=(await apiRead(page,'/api/requests?size=100')).total;
  await page.goto(`/requests/${created.requestNumber}`);
  const reuseButton=page.getByRole('button',{name:'새 요청으로 불러오기',exact:true});
  await expect(reuseButton).toBeVisible();
  await page.getByRole('button',{name:'신청 목록',exact:true}).focus();
  for(let step=0;step<16;step++){
    await page.keyboard.press('Tab');
    if(await reuseButton.evaluate(element=>element===document.activeElement))break;
  }
  await expect(reuseButton,'reuse action is reachable by Tab').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('status').filter({hasText:'새 신청 초안'})).toContainText(String(created.requestNumber));
  await expectGuidedDetail(page,originalText);
  await expect(question(page).locator('.intake-answer-list').first()).toContainText('반복 업무 위치');
  await question(page).locator('details.intake-optional-information summary').click();
  await expect(question(page).locator('details.intake-optional-information')).toContainText('인트라넷');
  await guidedReady(page);await guidedOptional(page);
  await expect(page.getByLabel('요청자 개인전화번호',{exact:true})).toHaveValue('000-0000-0000');
  await expect(page.getByLabel('1지망 날짜',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('2지망 날짜',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'과거-첨부.txt 첨부 제외',exact:true})).toHaveCount(0);
  expect((await apiRead(page,'/api/requests?size=100')).total).toBe(count,'LOADING_DRAFT_MUST_NOT_CREATE_REQUEST');
  await guidedReady(page);
  await expectGuidedDetail(page,originalText,`컴퓨터 지원 1대 / 반복 업무 위치 / 인트라넷 / ${originalText} / 공통 장비`);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await screenshot(page,info,'reuse-closed-request-draft');
  await guidedDetail(page,originalText+' 새 신청');
  const submitted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST');
  const submitButton=page.getByRole('button',{name:'신청 등록',exact:true});
  for(let step=0;step<30;step++){
    await page.keyboard.press('Tab');
    if(await submitButton.evaluate(element=>element===document.activeElement))break;
  }
  await expect(submitButton,'new request submit is reachable by Tab').toBeFocused();
  await page.keyboard.press('Enter');
  const response=await submitted;expect(response.status()).toBe(200);const saved=await response.json();
  expect(saved.requestNumber).not.toBe(created.requestNumber);
  const payload=response.request().postDataJSON().payload;
  expect(payload.attachments).toEqual([]);expect(payload).not.toHaveProperty('status');expect(payload).not.toHaveProperty('requestNumber');expect(payload).not.toHaveProperty('workItems');
  const next=(await apiRead(page,`/api/requests/${saved.requestNumber}`)).data;
  expect(next.status).toBe('대기');expect(next.workItems).toEqual([]);expect(next.attachments).toEqual([]);expect(next.schedulePreferences).toEqual([]);expect(next.priority??null).toBeNull();
  expect((await apiRead(page,`/api/requests/${created.requestNumber}`)).data).toEqual(before,'REUSING_MUST_NOT_MUTATE_SOURCE');
});

test('reuse respects unsaved navigation cancellation and clears its draft after leaving', async ({ page }) => {
  const respondToNextDialog=async(action:()=>Promise<unknown>,accept:boolean)=>{
    const dialogEvent=page.waitForEvent('dialog');
    const actionPromise=action();
    const dialog=await dialogEvent;
    if(accept) await dialog.accept(); else await dialog.dismiss();
    await actionPromise;
  };
  const number=await seed(page,'저장된 원본 내용');
  await apiLogin(page,'requester');await page.goto(`/requests/${number}`);
  await page.getByRole('button',{name:'내용 수정',exact:true}).click();
  await page.getByLabel('내용',{exact:true}).fill('아직 저장하지 않은 상세 편집');
  await respondToNextDialog(()=>page.getByRole('button',{name:'새 요청으로 불러오기',exact:true}).click(),false);
  await expect(page).toHaveURL(new RegExp('/requests/'+number+'$'));
  await expect(page.getByLabel('내용',{exact:true})).toHaveValue('아직 저장하지 않은 상세 편집');
  await respondToNextDialog(()=>page.getByRole('button',{name:'새 요청으로 불러오기',exact:true}).click(),true);
  await expect(page).toHaveURL(/\/new$/);
  await expectGuidedDetail(page,'저장된 원본 내용');
  await respondToNextDialog(()=>navItem(page,'내 신청'),false);
  await expect(page).toHaveURL(/\/new$/);
  await respondToNextDialog(()=>navItem(page,'내 신청'),true);
  await navItem(page,'작업 신청');
  await expectGuidedEmpty(page);
  await expect(page.getByRole('status').filter({hasText:'새 신청 초안'})).toHaveCount(0);
});

test('reuse does not transfer a stale response or an owned proxy request into a new draft', async ({ page }) => {
  const number=await seed(page,'늦게 도착하는 원본');
  const owner=await apiLogin(page,'requester');await page.goto(`/requests/${number}`);
  await expect(page.getByRole('button',{name:'새 요청으로 불러오기',exact:true})).toBeVisible();
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  let started:()=>void=()=>{};const requested=new Promise<void>(resolve=>{started=resolve;});
  let holding=false;
  let heldRequest: import('@playwright/test').Request|undefined;
  await page.route(`**/api/requests/${number}`,async route=>{if(holding)return route.continue();holding=true;heldRequest=route.request();const response=await route.fetch();started();await held;return route.fulfill({response});});
  await page.getByRole('button',{name:'새 요청으로 불러오기',exact:true}).click();
  await requested;
  await navItem(page,'내 신청');
  await page.goBack();
  await expect(page.getByRole('button',{name:'새 요청으로 불러오기',exact:true})).toBeVisible();
  const arrived=page.waitForResponse(response=>response.request()===heldRequest);
  release();await (await arrived).finished();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page,'RETURNING_TO_SAME_ROUTE_MUST_NOT_ACCEPT_OLD_REUSE_RESPONSE').toHaveURL(new RegExp('/requests/'+number+'$'));
  await navItem(page,'작업 신청');
  await expectGuidedEmpty(page);
  await page.unroute(`**/api/requests/${number}`);
  await apiLogin(page,'bnoc');
  const requester=(await apiRead(page,'/api/requesters')).data.find((item:{requesterRef:string})=>item.requesterRef===owner.actor.id);
  expect(requester,'the proxy request belongs to the same requester').toBeTruthy();
  const proxy=await command(page,'createRequest',{...requestPayload('대리 작성 요청'),requesterRef:requester.requesterRef});
  await apiLogin(page,'requester');
  await page.goto(`/requests/${proxy.requestNumber}`);
  await expect(page.getByRole('button',{name:'내용 수정',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'새 요청으로 불러오기',exact:true})).toHaveCount(0);
});

test('reuse of a video meeting still requires a new attachment before submitting', async ({ page }) => {
  const session=await apiLogin(page,'requester'),bytes=await readFile('frontend/src/preview/fixtures/support.hwp');
  const uploaded=await page.request.post('/api/attachments?resourceKind=request',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},multipart:{file:{name:'이전회의.hwp',mimeType:'application/octet-stream',buffer:bytes}}});
  expect(uploaded.status()).toBe(200);const file=(await uploaded.json()).data;
  const created=await command(page,'createRequest',{category:'회의 지원',subcategories:{meetingType:'화상회의',videoPlatform:'KJCCS'},detail:'반복 회의 지원',location:'회의실',contact:'000-0000',attachments:[{id:file.id}]});
  await page.goto(`/requests/${created.requestNumber}`);await page.getByRole('button',{name:'새 요청으로 불러오기',exact:true}).click();
  await expect(page.getByRole('heading',{name:'어떤 회의인가요?',exact:true})).toBeVisible();
  await question(page).getByRole('button',{name:'화상회의',exact:true}).click();await question(page).getByRole('button',{name:'KJCCS',exact:true}).click();
  await expect(page.getByLabel('어떤 지원이 필요한가요?',{exact:true})).toHaveValue('반복 회의 지원');await question(page).getByRole('button',{name:'다음',exact:true}).click();
  await expect(page.getByLabel('회의 장소는 어디인가요?',{exact:true})).toHaveValue('회의실');await question(page).getByRole('button',{name:'다음',exact:true}).click();
  let posted=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/commands'&&request.method()==='POST')posted++;});
  await expect(question(page).getByRole('button',{name:'다음',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);
  expect(posted).toBe(0,'COPIED_MEETING_MUST_REQUIRE_A_NEW_ATTACHMENT');
  const input=page.getByLabel('화상회의 지원 의뢰서',{exact:true});await input.setInputFiles({name:'새회의.hwp',mimeType:'application/octet-stream',buffer:bytes});
  await expect(page.getByRole('button',{name:'새회의.hwp 첨부 제외',exact:true})).toBeVisible();await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/commands'&&r.request().method()==='POST');await page.getByRole('button',{name:'신청 등록',exact:true}).click();
  const result=await response;expect(result.status()).toBe(200);expect(result.request().postDataJSON().payload.attachments[0].id).not.toBe(file.id);expect(result.request().postDataJSON().payload.subcategories).toEqual({meetingType:'화상회의',videoPlatform:'KJCCS'});
});

test('an HWP search result opens the matching document directly', async ({ page }, info) => {
  const session = await apiLogin(page, 'requester');
  const bytes = await readFile('frontend/src/preview/fixtures/support.hwp');
  const name = `검색 문서-${randomUUID().slice(0, 8)}.hwp`;
  const uploaded = await page.request.post('/api/attachments?resourceKind=request', {
    headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken },
    multipart: { file: { name, mimeType: 'application/octet-stream', buffer: bytes } },
  });
  expect(uploaded.status()).toBe(200);
  const attachment = (await uploaded.json()).data;
  const created = await command(page, 'createRequest', { ...requestPayload('HWP 문서 검색 흐름 확인'), attachments: [{ id: attachment.id }] });
  const number = created.requestNumber as string;
  await expect.poll(async () => (await (await page.request.get(`/api/attachments/${attachment.id}/document`)).json()).data.status, { timeout: 30000 }).toBe('ready');

  await page.goto('/requests');
  await page.getByRole('textbox', { name: '내용·문서 검색' }).fill('마이크');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: number });
  const openDocument = row.getByRole('button', { name: /문서 보기/ });
  await expect(openDocument).toBeVisible();
  await openDocument.click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(viewer.locator('.document-dialog__body')).toContainText('마이크 점검');
  const matchHighlight=viewer.locator('.document-dialog__body .document-search-hit');
  await expect(matchHighlight).toContainText('마이크');
  await expect(matchHighlight.locator('xpath=..')).toHaveAttribute('data-document-search-target','true');
  await expect(viewer.getByText('분석 완료')).toBeVisible();
  await screenshot(page, info, 'hwp-search-viewer');

  await viewer.getByRole('button', { name: '닫기', exact: true }).click();
  await page.route(url => new URL(url).pathname === '/api/requests', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    if (new URL(route.request().url()).searchParams.get('q') === '메타검색') {
      payload.data.items = [{ requestNumber: number, requesterDisplayText: '요청자', category: '장비/체계', status: '대기', teamIds: [], updatedAt: new Date().toISOString(), priority: 'general', matches: [{ source: 'document', attachmentRef: attachment.id, text: '회의 정보: 메타검색 확인', metadataIndex: 15 }] }];
      payload.data.total = 1;
      payload.total = 1;
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route(url => new URL(url).pathname === `/api/attachments/${attachment.id}/document`, async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.metadata = Array.from({ length: 16 }, (_, index) => ({ label: `문서 정보 ${index + 1}`, rawValue: index === 15 ? '메타검색 확인' : '다른 값', blockId: `b${index}`, source: 'test', evidence: `문서 정보 ${index + 1}: ${index === 15 ? '메타검색 확인' : '다른 값'}` }));
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.goto('/requests');
  await page.getByRole('textbox', { name: '내용·문서 검색' }).fill('메타검색');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const metadataRow = page.getByRole('row').filter({ hasText: number });
  await metadataRow.getByRole('button', { name: /문서 보기/ }).click();
  const metadataViewer = page.getByRole('dialog');
  const metadataTarget = metadataViewer.locator('[data-document-metadata-target="true"]');
  await expect(metadataTarget).toContainText('메타검색 확인');
  await expect(metadataTarget.locator('p').first().locator('.document-search-hit')).toContainText('메타검색');
  await expect.poll(() => metadataViewer.locator('.document-dialog__metadata').evaluate(element => {
    const panel = element.getBoundingClientRect();
    const target = element.querySelector('[data-document-metadata-target="true"]')?.getBoundingClientRect();
    return Boolean(target && target.top >= panel.top && target.bottom <= panel.bottom);
  })).toBe(true);
  await metadataViewer.getByRole('button', { name: '닫기', exact: true }).click();
  await page.unrouteAll();
  await page.route(url => new URL(url).pathname === '/api/requests', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.documentSearchIncomplete = true;
    payload.data.documentSearchStatuses = { items: [{ requestNumber: number, attachmentRef: attachment.id, fileName: name, status: 'partial' }], total: 1, truncated: false };
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.goto('/requests');
  await expect(page.getByText('문서 1개는 검색에서 빠지거나 추출된 일부만 검색됐을 수 있습니다.')).toBeVisible();
  await page.getByText('문서 1개는 검색에서 빠지거나 추출된 일부만 검색됐을 수 있습니다.').click();
  await expect(page.getByText('일부 추출 문서는 추출된 본문만 검색합니다. 원문 전체의 일치 여부는 확인할 수 없습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: `${name} · 일부 추출 · 추출 본문만 검색` })).toBeVisible();
  await page.unrouteAll();
  const current = (await apiRead(page, `/api/requests/${number}`)).data;
  const replacement = await page.request.post('/api/attachments?resourceKind=request', {
    headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken },
    multipart: { file: { name: `교체-${randomUUID().slice(0, 8)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('교체 첨부') } },
  });
  expect(replacement.status()).toBe(200);
  const replacementId = (await replacement.json()).data.id as string;
  await command(page, 'updateRequest', { attachments: [{ id: replacementId }] }, { requestNumber: number, expectedRevision: current.revision });
  await page.goto(`/requests/${number}`);
  const oldFile = page.getByRole('link', { name, exact: true });
  await expect(oldFile).toBeVisible();
  await oldFile.locator('xpath=..').getByRole('button', { name: '문서 보기', exact: true }).click();
  const historyViewer = page.getByRole('dialog');
  await expect(historyViewer.getByRole('heading', { name, exact: true })).toBeVisible();
  await historyViewer.getByRole('button', { name: '추출 본문', exact: true }).click();
  await expect(historyViewer.locator('.document-dialog__body')).toContainText('마이크 점검');
});

test('meeting support forms stay downloadable without exposing extracted content', async ({ page }) => {
  const session = await apiLogin(page, 'requester');
  const bytes = await readFile('frontend/src/preview/fixtures/support.hwp');
  const name = `회의 의뢰서-${randomUUID().slice(0, 8)}.hwp`;
  const uploaded = await page.request.post('/api/attachments?resourceKind=request', {
    headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken },
    multipart: { file: { name, mimeType: 'application/octet-stream', buffer: bytes } },
  });
  expect(uploaded.status()).toBe(200);
  const attachment = (await uploaded.json()).data;
  const created = await command(page, 'createRequest', {
    category: '회의 지원', subcategories: { meetingType: '일반회의' }, detail: '회의 지원 요청',
    location: '회의실', contact: '000-0000', attachments: [{ id: attachment.id }],
  });
  const number = created.requestNumber as string;
  const document = (await apiRead(page, `/api/attachments/${attachment.id}/document`)).data;
  expect(document.status).toBe('excluded');
  expect(document.blocks).toEqual([]);
  expect(document.metadata).toEqual([]);
  const renderSource = await page.request.get(`/api/attachments/${attachment.id}/render-source`);
  expect(renderSource.status()).toBe(200, 'AUTHORIZED_MEETING_ORIGINAL_PREVIEW_REQUIRED');
  expect((await renderSource.body()).equals(bytes)).toBeTruthy();

  await page.goto(`/requests/${number}`);
  const file = page.getByRole('link', { name, exact: true });
  await expect(file).toBeVisible();
  await file.locator('xpath=..').getByRole('button', { name: '문서 보기', exact: true }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByText(/본문 분석 제외.*서버 본문 분석·검색은 제외됩니다/)).toBeVisible();
  await expect(viewer.locator('.hwp-page-view__image')).toBeVisible();
  await expect.poll(() => viewer.locator('.hwp-page-view__image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBeTruthy();
  await expect(viewer.getByRole('button', { name: '원본 보기', exact: true })).toHaveCount(0);
  await expect(viewer.getByRole('link', { name: '원본 다운로드', exact: true })).toBeVisible();
  await expect(viewer.locator('.document-dialog__body')).not.toContainText('마이크 점검');
  const downloadReady = page.waitForEvent('download');
  await viewer.getByRole('link', { name: '원본 다운로드', exact: true }).click();
  const download = await downloadReady;
  expect((await readFile(await download.path())).equals(bytes)).toBeTruthy();
});

test('original DOCX preview renders paragraphs and tables with no external document access', async ({ page }, info) => {
  const session = await apiLogin(page, 'requester');
  const externalRequests: string[] = [];
  await page.route('https://preview-external.invalid/**', route => { externalRequests.push(route.request().url()); return route.abort(); });
  for (const meeting of [true, false]) {
    const bytes = docxFixture(), name = `문서보기-${randomUUID().slice(0,8)}.docx`;
    const uploaded = await page.request.post('/api/attachments?resourceKind=request', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, multipart: { file: { name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes } } });
    expect(uploaded.status()).toBe(200);
    const file = (await uploaded.json()).data;
    expect((await page.request.get(`/api/attachments/${file.id}/render-source`)).status()).toBe(200);
    const created = await command(page,'createRequest',{...requestPayload('원본 DOCX 미리보기'),...(meeting?{category:'회의 지원',subcategories:{meetingType:'일반회의'}}:{}),attachments:[{id:file.id}]});
    expect((await (await page.request.get(`/api/attachments/${file.id}/render-source`)).body()).equals(bytes)).toBeTruthy();
    await page.goto(`/requests/${created.requestNumber}`);
    const opener = page.getByRole('link',{name,exact:true}).locator('xpath=..').getByRole('button',{name:'문서 보기',exact:true});
    await opener.click();
    const viewer = page.getByRole('dialog'), frame = viewer.frameLocator('iframe');
    await expect(frame.getByText('회의 지원 원본 7319',{exact:true})).toBeVisible();
    await expect(frame.getByRole('cell',{name:'회의실',exact:true})).toBeVisible();
    await expect(frame.getByText('UNSAFE_CHUNK')).toHaveCount(0);
    await expect(frame.locator('a[href]')).toHaveCount(0);
    await expect(viewer.locator('iframe')).toHaveAttribute('sandbox','allow-scripts');
    expect(await frame.locator('body').evaluate(() => { try { void window.parent.document.body; return false; } catch { return true; } })).toBe(true);
    await expect(viewer.getByRole('button',{name:'추출 본문',exact:true})).toHaveCount(0);
    await expect(viewer.getByText('표시할 항목이 없습니다.')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page,info,meeting?'meeting-docx-original-preview':'ordinary-docx-original-preview');
    const analysis = (await apiRead(page,`/api/attachments/${file.id}/document`)).data;
    expect(analysis.status).toBe(meeting?'excluded':'unsupported'); expect(analysis.blocks).toEqual([]); expect(analysis.metadata).toEqual([]);
    const downloadReady = page.waitForEvent('download');
    await viewer.getByRole('link',{name:'원본 다운로드',exact:true}).click();
    expect((await readFile(await (await downloadReady).path())).equals(bytes)).toBeTruthy();
    await viewer.getByRole('button',{name:'닫기',exact:true}).click();
    await expect(viewer).toHaveCount(0); await expect(opener).toBeFocused();
  }
  expect(externalRequests).toEqual([]);
});

test('meeting PDF and image originals open while a broken DOCX gives a download fallback', async ({ page }, info) => {
  const session = await apiLogin(page,'requester');
  for (const [extension, mimeType, bytes] of [['pdf','application/pdf',previewPdf()],['png','image/png',previewPng],['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',docxFixture({broken:true})]] as const) {
    const name = `원본-${randomUUID().slice(0,8)}.${extension}`;
    const uploaded = await page.request.post('/api/attachments?resourceKind=request',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},multipart:{file:{name,mimeType,buffer:bytes}}});
    expect(uploaded.status()).toBe(200);const file=(await uploaded.json()).data;
    const created=await command(page,'createRequest',{category:'회의 지원',subcategories:{meetingType:'일반회의'},detail:'원본 미리보기 형식 검사',location:'회의실',contact:'000-0000',attachments:[{id:file.id}]});
    await page.goto(`/requests/${created.requestNumber}`);
    await page.getByRole('link',{name,exact:true}).locator('xpath=..').getByRole('button',{name:'문서 보기',exact:true}).click();
    const viewer=page.getByRole('dialog');
    if(extension==='pdf') {
      const response=await page.request.get(`/api/attachments/${file.id}/inline`);expect(response.status()).toBe(200);expect((await response.body()).equals(bytes)).toBeTruthy();
      await expect(viewer.getByTitle('원본 PDF')).toBeVisible();
      await screenshot(page,info,'meeting-pdf-original-preview');
    } else if(extension==='png') {
      await expect.poll(()=>viewer.getByRole('img',{name,exact:true}).evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBeTruthy();
    } else await expect(viewer.getByRole('alert')).toContainText('이 Word 문서를 미리 볼 수 없습니다.');
    await expect(viewer.getByRole('link',{name:'원본 다운로드',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(viewer).toHaveCount(0);
  }
});

test('PC completeness: progressive questions preserve input and unknown technical choices reach saved items', async ({ page }, info) => {
  await apiLogin(page,'requester');await page.goto('/new');await expectGuidedEmpty(page);
  await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);
  const malformed=await page.request.post('/api/commands',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':(await apiRead(page,'/api/session')).data.csrfToken},data:{type:'createRequest',operationId:randomUUID(),payload:{...requestPayload('구형 누락 분류 검증'),subcategories:{systemType:'',resourceType:'',workType:''}}}});
  expect(malformed.status()).toBe(400);expect((await malformed.json()).fieldErrors.subcategories).toBeTruthy();
  await question(page).getByRole('button',{name:'지원',exact:true}).click();await question(page).getByRole('button',{name:'장비 지원',exact:true}).click();
  await page.getByRole('button',{name:'컴퓨터 추가',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'선택한 대상 계속',exact:true}).click();
  await expect(page.getByRole('heading',{name:'어디에 있나요?',exact:true})).toBeFocused();
  await page.getByLabel('어디에 있나요?',{exact:true}).fill('요청 위치');await question(page).getByRole('button',{name:'다음',exact:true}).click();
  const detail=page.getByLabel('어떤 도움이 필요한가요?',{exact:true});await detail.fill('유형 선택 오류 안내 확인');
  await page.getByRole('button',{name:'이전',exact:true}).click();await question(page).getByRole('button',{name:'다음',exact:true}).click();await expect(detail).toHaveValue('유형 선택 오류 안내 확인');
  await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);
  await screenshot(page,info,'progressive-technical-unknown');
  const submit=page.getByRole('button',{name:'신청 등록',exact:true});await submit.focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  const number=new URL(page.url()).pathname.split('/').at(-1)!;const saved=(await apiRead(page,`/api/requests/${number}`)).data;
  expect(saved.requestItems[0].detail).toBe('유형 선택 오류 안내 확인');expect(saved.requestItems[0].systemType??null).toBeNull();expect(saved.requestItems[0].equipmentId??null).toBeNull();
  await expect(page.getByRole('status').filter({hasText:`요청 ${number}을 등록했습니다.`})).toBeVisible();
  await page.getByRole('button',{name:'내용 수정',exact:true}).click();await guidedDetail(page,'유형 선택 후 수정 중');
  await guidedItemReview(page);await question(page).getByRole('button',{name:'위치 수정',exact:true}).click();await page.getByLabel('어디에 있나요?',{exact:true}).fill('수정 위치');await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);
  await expectGuidedDetail(page,'유형 선택 후 수정 중','컴퓨터 지원 1대 / 수정 위치 / 유형 선택 후 수정 중');await expect(question(page)).toContainText('수정 위치');
  await expect(page.getByRole('status').filter({hasText:`요청 ${number}을 등록했습니다.`})).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'저장하지 않은 변경'})).toBeVisible();
});

test('request form reveals meeting questions and requires its support form before registration', async ({ page }) => {
  await apiLogin(page,'requester');await page.goto('/new');await question(page).getByRole('button',{name:'지원',exact:true}).click();await question(page).getByRole('button',{name:'회의 지원',exact:true}).click();await question(page).getByRole('button',{name:'화상회의',exact:true}).click();
  await expect(question(page).getByRole('button')).toHaveText(['KJCCS','AFCCS','웹미팅']);await question(page).getByRole('button',{name:'KJCCS',exact:true}).click();
  const detail=page.getByLabel('어떤 지원이 필요한가요?',{exact:true});await detail.fill('화상회의 접속 지원 요청');await question(page).getByRole('button',{name:'다음',exact:true}).click();
  const location=page.getByLabel('회의 장소는 어디인가요?',{exact:true});await location.fill('본관 회의실');await page.getByRole('button',{name:'이전',exact:true}).click();await expect(detail).toHaveValue('화상회의 접속 지원 요청');await question(page).getByRole('button',{name:'다음',exact:true}).click();await expect(location).toHaveValue('본관 회의실');await question(page).getByRole('button',{name:'다음',exact:true}).click();
  const meetingForm=page.getByLabel('화상회의 지원 의뢰서',{exact:true});await expect(meetingForm).toHaveAttribute('aria-required','true');await expect(question(page).getByRole('button',{name:'다음',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);
  await meetingForm.setInputFiles({name:'support-form.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic meeting support form')});await expect(page.getByRole('button',{name:'support-form.txt 첨부 제외',exact:true})).toBeVisible();
  await question(page).getByRole('button',{name:'다음',exact:true}).click();await page.getByLabel('요청자 군내전화번호',{exact:true}).fill('1234');await guidedReady(page);
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'내용 수정',exact:true}).click();await expect(page.getByRole('button',{name:'support-form.txt 첨부 제외',exact:true})).toBeDisabled();
});

test('BNOC unassigned requests distinguish query errors and paginate', async ({ page }) => {
  await apiLogin(page, 'bnoc');
  let failFirstQuery = true;
  await page.route('**/api/work-overview?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('bucket') !== 'unassigned') return route.continue();
    if (failFirstQuery) {
      failFirstQuery = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '미배정 요청 조회에 실패했습니다.' }) });
    }
    const pageNumber = Number(url.searchParams.get('page') ?? 0);
    const items = pageNumber === 0
      ? Array.from({ length: 20 }, (_, index) => ({ requestNumber: `8800000${String(index + 1).padStart(2, '0')}`, category: '장비/체계', status: '대기' }))
      : [{ requestNumber: '880000021', category: '회의 지원', status: '대기' }];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queriedAt: new Date().toISOString(), data: { items, total: 21, page: pageNumber, size: 20, counts: {}, byDepartment: [] } }) });
  });
  await page.goto('/overview');
  const section = page.getByRole('region', { name: '미배정 요청', exact: true });
  await expect(section.getByRole('alert')).toContainText('미배정 요청 조회에 실패했습니다.');
  await expect(section.getByText('조건에 맞는 미배정 요청이 없습니다.', { exact: true })).toHaveCount(0);
  await section.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(section.getByRole('button', { name: /^880000001 ·/ })).toBeVisible();
  await expect(section.getByRole('button', { name: '다음 페이지', exact: true })).toBeEnabled();
  await section.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(section.getByRole('button', { name: /^880000021 ·/ })).toBeVisible();
  await expect(section.getByText('2페이지', { exact: true })).toBeVisible();
});

test('PC completeness: edited and failed searches preserve the actual successful conditions and result', async ({ page }, info) => {
  const number = await seed(page, `조회 맥락 ${info.project.name}`);
  await apiLogin(page, 'requester');
  await page.goto('/requests');
  await page.getByLabel('요청 번호', { exact: true }).fill(number);
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByLabel('위치', { exact: true }).fill('요청 위치');
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const context = page.locator('.query-context');
  await expect(context).toHaveCount(0);
  await expect(page.getByLabel('요청 번호', { exact: true })).toHaveValue(number);
  await expect(page.getByLabel('위치', { exact: true })).toHaveValue('요청 위치');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/requests') requests.push(request.url()); });
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await expect(page.getByLabel('위치', { exact: true })).toHaveValue('요청 위치');
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByLabel('요청 번호', { exact: true }).fill('999999999');
  await expect(context).toContainText('조건 편집 중');
  expect(requests).toHaveLength(0);
  await page.route('**/api/requests?**', route => new URL(route.request().url()).searchParams.get('requestNumber') === '999999999'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '새 조건 조회에 실패했습니다.' }) }) : route.continue());
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('새 조건 조회에 실패했습니다.');
  await expect(context).toContainText('마지막 성공 결과');
  await expect(context).toContainText(`요청 번호: ${number}`);
  await expect(context).toContainText('위치: 요청 위치');
  await expect(context).not.toContainText('999999999');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  await expect(page.getByText('요청 1건', { exact: true })).toBeVisible();
  await screenshot(page, info, 'preserved-query-context');
  await page.unroute('**/api/requests?**');
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(context).toHaveCount(0);
  await expect(page.getByLabel('요청 번호', { exact: true })).toHaveValue('999999999');
  await expect(page.getByText('요청 0건', { exact: true })).toBeVisible();
  await page.getByText('상세 조회 조건', { exact: true }).click();
  const longLocation = 'W'.repeat(200);
  await page.getByLabel('위치', { exact: true }).fill(longLocation);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(context).toHaveCount(0);
  await page.getByLabel('요청 번호', { exact: true }).fill('999999998');
  await expect(context).toContainText(`위치: ${longLocation}`);
  await noOverflow(page);
  await apiLogin(page, 'bnoc');
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: '요청 현황(BNOC)', exact: true })).toBeVisible();
  const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/overview' && new URL(response.url()).searchParams.get('teamId') === wire);
  await page.getByRole('combobox', { name: '작업반', exact: true }).selectOption(wire);
  expect((await applied).status()).toBe(200);
  await expect(context).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '작업반', exact: true })).toHaveValue(wire);
  await expect(page.getByRole('button', { name: '검색', exact: true })).toHaveCount(0);
});

test('SR-BE-001,004,005,006,010,011,012,013,015,019,028,031,033,034: real login, registration, classification, work save, refresh and file download', async ({ page }, info) => {
  const isolatedApi = await apiRequest.newContext({ baseURL: base });
  await apiLogin({ request: isolatedApi }, 'requester');
  const pending = await command({ request: isolatedApi }, 'createRequest', requestPayload(`다음 미배정 요청 ${info.project.name}`));
  await isolatedApi.dispose();
  await page.goto('/requests');
  await expect(page.getByText(/모의 인증|모의 정보|대회용/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /회원가입|계정 생성/ })).toHaveCount(0);
  await loginWithPopup(page, 'requester');
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '작업 신청', exact: true })).toBeVisible();
  await expectGuidedEmpty(page);
  await fields(page, `브라우저 지원 ${info.project.name}`);await guidedOptional(page);
  await page.getByLabel('1지망 날짜', { exact: true }).fill('2026-10-20');
  await page.getByLabel('1지망 오전·오후', { exact: true }).selectOption('AM');
  await (await guidedAttachments(page)).setInputFiles({ name: '저장자료.txt', mimeType: 'text/plain', buffer: Buffer.from('브라우저 파일 저장 확인') });
  await expect(page.getByRole('button',{name:'저장자료.txt 첨부 제외',exact:true})).toBeVisible();await guidedReady(page);
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(number).toMatch(/^\d{3,}$/);
  await page.goto('/requests');
  const requestTable=page.getByRole('table');
  await expect(requestTable.getByRole('columnheader', { name: '요청자', exact: true })).toHaveCount(0);
  await expect(requestTable.getByRole('button', { name: number, exact: true })).toBeVisible();
  await switchWithPopup(page, 'bnoc');
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await expect(page.getByLabel(/반장|작업 예정일/)).toHaveCount(0);
  const initialAssignmentCard = page.locator('form.card.section-gap').filter({ has: page.getByRole('heading', { name: '작업반 배정', exact: true }) });
  await expect(initialAssignmentCard).toBeVisible();
  await expect(page.locator('.department-management')).toHaveCount(0);
  await page.getByLabel(wire, { exact: true }).check();
  const classification=page.getByRole('combobox',{name:'일반·긴급',exact:true});
  await expect(classification).toHaveValue('general');
  await classification.selectOption('urgent');
  await page.getByRole('button', { name: '선택 작업반 배정', exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: '요청 현황(BNOC)', exact: true })).toBeVisible();
  await expect(page.locator('p.notice[role="status"]')).toContainText(`요청 ${number}을 ${wire}에 배정했습니다.`);
  const unassignedSection = page.getByRole('region', { name: '미배정 요청', exact: true });
  await expect(unassignedSection.getByRole('button', { name: new RegExp(`^${pending.requestNumber} ·`) })).toBeVisible();
  await expect(unassignedSection.getByRole('button', { name: new RegExp(`^${number} ·`) })).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(`^${number} ·`) }).click();
  const addTeamsCard = page.locator('form.card.section-gap').filter({ has: page.getByRole('heading', { name: '작업 부서 추가', exact: true }) });
  const reassignmentCard = page.locator('form.card.section-gap').filter({ has: page.getByRole('heading', { name: `${wire} 배정 변경`, exact: true }) });
  await expect(addTeamsCard).toBeVisible();
  await expect(reassignmentCard).toBeVisible();
  await expect(page.locator('.department-management')).toHaveCount(0);
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems.length).toBe(1);
  const assigned = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(assigned.priority).toBe('urgent');
  expect(assigned.workItems[0].schedule ?? null).toBeNull();
  await expect(page.getByText('현재 분류: 긴급', { exact:true })).toBeVisible();
  await page.getByRole('button',{name:'분류 변경',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'일반·긴급',exact:true})).toHaveValue('urgent');
  await expect(page.getByText(/배정 시각|접수 시간/).first()).toBeVisible();
  const publicHistory = (await apiRead(page, `/api/requests/${number}/history`)).data.items;
  const priorityHistory = publicHistory.find((entry: { field: string }) => entry.field === '일반·긴급');
  const assignmentHistory = publicHistory.find((entry: { field: string }) => entry.field === '배정 시각(접수 시간)');
  expect(priorityHistory.field).toBe('일반·긴급'); expect(assignmentHistory.field).toBe('배정 시각(접수 시간)');
  for (const entry of [priorityHistory, assignmentHistory]) {
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(Number.isFinite(Date.parse(entry.at))).toBe(true);
  }
  await humanHistory(page, '일반·긴급: 긴급', assigned.assignedAt);
  await screenshot(page, info, 'assignment');
  await switchWithPopup(page, 'team-wireless');
  await page.goto(`/requests/${number}`);
  const workStatus = page.getByRole('combobox', { name: '작업 상태', exact: true });
  await expect(workStatus.locator('option[value="작업 중"]')).toHaveText('작업 준비');
  await workStatus.selectOption('작업 중');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('작업 중');
  await expect(page.locator('.work-card .badge')).toHaveText('작업 준비');
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('완료');
  expect((await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('작업 중');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.status).toBe('완료');
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('배정');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('배정');
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('완료');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.status).toBe('완료');
  await switchWithPopup(page, 'requester');
  await page.goto(`/requests/${number}`);
  await page.reload();
  await expect(page.getByText('완료', { exact: true }).first()).toBeVisible();
  await page.goto('/operations');
  const sharedRow = page.getByRole('row').filter({ hasText: number });
  await expect(sharedRow).toContainText('000-0000');
  await page.goto(`/requests/${number}`);
  await page.reload();
  const savedDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: /저장자료\.txt/ }).click();
  const download = await savedDownload;
  const destination = info.outputPath('stored-attachment.txt');
  await download.saveAs(destination);
  expect(await readFile(destination, 'utf8')).toBe('브라우저 파일 저장 확인');
  await noOverflow(page);
  await screenshot(page, info, 'completed-request');
});

test('SR-BE-017,018,022,023,031,032,033: explicit search, safe shared list and direct-route privacy', async ({ page }, info) => {
  const number = await seed(page, `검색 입력 ${info.project.name}`);
  await apiLogin(page, 'requester');
  await page.goto('/requests');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  const lookups: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/requests') lookups.push(request.url()); });
  await page.getByLabel('요청 번호', { exact: true }).fill('999999999');
  await page.waitForTimeout(350);
  expect(lookups).toHaveLength(0);
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText(/조건에 맞는 신청.*없|조회된 항목 없음/).first()).toBeVisible();
  expect(lookups).toHaveLength(1);
  await page.getByLabel('요청 번호', { exact: true }).fill(number);
  await page.getByLabel('요청 번호', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  expect(lookups).toHaveLength(2);
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await expect.poll(() => lookups.length).toBe(3);
  await page.waitForTimeout(300);
  expect(lookups).toHaveLength(3);
  await apiLogin(page, 'bnoc');
  const request = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'assignTeams', { teamIds: [wire], priority: 'general' }, { requestNumber: number, expectedRevision: request.revision });
  await apiLogin(page, 'team-wireless');
  const assigned = (await apiRead(page, `/api/requests/${number}`)).data.workItems[0];
  await command(page, 'updateWork', { nextStatus: '작업 중', scheduleIntervals: [
    { startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T03:00:00Z' },
    { startsAt: '2026-10-20T04:00:00Z', endsAt: '2026-10-20T05:00:00Z' }
  ] }, { requestNumber: number, workNumber: assigned.workNumber, expectedRevision: assigned.revision });
  await apiLogin(page, 'requester-secondary');
  await page.goto('/operations');
  await expect(page.getByRole('heading', { name: '부서별 작업 현황', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '부서', exact: true }).selectOption(wire);
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('지원');
  const filteredResponse = (index: number) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/work-overview' && response.request().method() === 'GET' && response.status() === 200 && url.searchParams.get('teamId') === wire && url.searchParams.get('workType') === '지원' && url.searchParams.get('page') === String(index);
  });
  const row = (publicNumber: string) => page.getByRole('row', { name: new RegExp(`(?:^|\\s)${publicNumber}(?:\\s|$)`) });
  const renderedPage = async (result: { page: number; data: { items: { workNumber?: string; requestNumber: string }[] } }) => {
    await expect(page.getByText(`${result.page + 1}페이지`, { exact: true })).toBeVisible();
    expect(result.data.items.length).toBeGreaterThan(0);
    await expect(row(result.data.items[0].workNumber ?? result.data.items[0].requestNumber)).toBeVisible();
  };
  const searched = filteredResponse(0);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const firstPage = await (await searched).json();
  expect(firstPage.total).toBeGreaterThan(0);
  await renderedPage(firstPage);
  const targetRow = row(`${number}-1`);
  for (let index = 1; index < Math.ceil(firstPage.total / firstPage.size) && await targetRow.count() === 0; index++) {
    await expect(page.getByRole('button', { name: '다음 페이지', exact: true })).toBeEnabled();
    const nextPage = filteredResponse(index);
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
    const next = await (await nextPage).json();
    expect(next.page).toBe(index);
    await renderedPage(next);
  }
  await expect(targetRow).toBeVisible();
  await expect(targetRow).toContainText('BNOC 배정');
  await expect(targetRow).toContainText('작업 준비');
  await expect(targetRow).toContainText('2026-10-20 10:00–12:00 · 2026-10-20 13:00–14:00');
  await expect(page.getByText(`검색 입력 ${info.project.name}`, { exact: true })).toHaveCount(0);
  await expect(targetRow).toContainText('000-0000', 'the approved shared projection includes the requester phone without exposing request text');
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toHaveCount(0);
  await expect(page.getByText(/접근.*없|찾을 수 없/).first()).toBeVisible();
  await page.goto('/operations');
  await noOverflow(page);
  await screenshot(page, info, 'shared-work');
});

test('SR-BE-020: unseen count sits on the notifications tab and identical account labels show once', async ({ page }) => {
  const session = await apiLogin(page, 'team-wireless');
  expect(session.actor.displayName).toBe(session.actor.department);
  await page.route('**/api/notifications/unseen', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queriedAt: new Date().toISOString(), data: { unseen: 4 } }) }));
  await page.goto('/requests');
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  const communicationGroup=nav.locator('.nav-group').filter({hasText:'알림함'});
  await expect(communicationGroup.locator('summary .nav-badge')).toHaveText('4');
  await expect(page.getByRole('button', { name: /새 알림/ })).toHaveCount(0);
  await expect(page.locator('header .identity strong')).toHaveText(session.actor.displayName);
  await expect(page.locator('header .identity small')).toHaveCount(0);
});

test('SR-BE-023,036: shared work report shows aggregate and per-department completion bars without query times', async ({ page }, info) => {
  await apiLogin(page, 'requester-secondary');
  const counts = { assigned: 10, completed: 6, remaining: 4, returned: 1, afterAction: 2, planned: 3, plannedInProgress: 1, plannedCompleted: 2, all: 13, allCompleted: 8, allRemaining: 5 };
  const assignedItems = Array.from({ length: 10 }, (_, index) => ({
    source: index < 2 ? 'after-action' as const : 'assigned' as const,
    origin: index < 2 ? 'after-action' : undefined,
    requestNumber: `TEST-${String(index + 1).padStart(3, '0')}`,
    workNumber: `TEST-${String(index + 1).padStart(3, '0')}-1`,
    teamId: wire,
    category: '장비/체계',
    workType: '점검',
    status: index < 6 ? '완료' as const : index === 6 ? '반환' as const : '배정' as const,
    priority: 'general' as const,
    canOpenDetail: false
  }));
  const plannedItems = Array.from({ length: 3 }, (_, index) => ({
    source: 'planned' as const,
    plannedWorkId: `planned-test-${index + 1}`,
    title: `계획 정비 ${index + 1}`,
    teamId: wire,
    firstWorkDate: '2026-10-24',
    completedDate: index < 2 ? '2026-10-24' : undefined,
    status: index < 2 ? '완료' as const : '진행 중' as const
  }));
  const overview = {
    counts, byDepartment: [{ department: wire, ...counts }], items: assignedItems, total: assignedItems.length, page: 0, size: 20,
    unassignedRequests: 3, afterActionCompleted: 2
  };
  await page.route('**/api/work-overview?**', async route => {
    const url = new URL(route.request().url());
    const bucket = url.searchParams.get('bucket');
    const data = bucket === 'returned'
      ? { counts: { returned: 1 }, byDepartment: [], items: [assignedItems[6]], total: 1, page: 0, size: 1 }
      : bucket === 'remaining'
        ? { ...overview, items: assignedItems.filter(item => item.status !== '완료'), total: counts.remaining }
        : bucket === 'planned'
          ? { ...overview, items: plannedItems, total: counts.planned }
          : bucket === 'all'
            ? { ...overview, items: [...assignedItems, ...plannedItems], total: counts.all }
            : overview;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queriedAt: new Date().toISOString(), data }) });
  });
  await page.goto('/operations');
  const summary = page.getByRole('region', { name: '전체 작업 현황' });
  await expect(summary).toContainText('13건');
  await expect(summary).toContainText('완료');
  await expect(summary).toContainText('남음');
  const totalBar = page.getByRole('progressbar', { name: '전체 작업 완료율' });
  await expect(totalBar).toHaveAttribute('aria-valuenow', '8');
  await expect(totalBar).toHaveAttribute('aria-valuemax', '13');
  const department = page.locator('.department-overview').filter({ hasText: wire });
  const assignedBar = department.getByRole('progressbar', { name: `${wire} 배정 작업 완료율` });
  await expect(assignedBar).toHaveAttribute('aria-valuenow', '6');
  await expect(assignedBar).toHaveAttribute('aria-valuemax', '10');
  const plannedBar = department.getByRole('progressbar', { name: `${wire} 계획 정비 완료율` });
  await expect(plannedBar).toHaveAttribute('aria-valuenow', '2');
  await expect(plannedBar).toHaveAttribute('aria-valuemax', '3');
  await expect(department).toContainText('후보고 2건 포함');
  await expect(department).toContainText('반환 1건 포함');
  await expect(page.getByText(/확인 시각|집계 기준 시각/)).toHaveCount(0);
  await expect(page.getByText('작업 10건', { exact: true })).toBeVisible();
  await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(10);
  await noOverflow(page);
  await screenshot(page, info, 'shared-work-overview');
  const remainingResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/work-overview' && url.searchParams.get('bucket') === 'remaining' && response.status() === 200;
  });
  await page.getByRole('combobox', { name: '목록 종류' }).selectOption('remaining');
  await remainingResponse;
  await expect(page.getByRole('heading', { name: '남은 작업 목록' })).toBeVisible();
  await expect(page.getByText('작업 4건', { exact: true })).toBeVisible();
  await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(4);
});

test('SR-BE-026,035: standalone situation pages still require the existing login session', async ({ page }) => {
  await page.goto('/external-systems/gps/index.html');
  await expect(page.getByRole('heading', { name: 'GPS 정보', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('로그인 세션');
  await expect(page.locator('.situation-card')).toBeHidden();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('FR-038: status hover shows responsible departments and official contact availability; detail keeps the process', async ({ page }, info) => {
  const number = await seed(page, `상태 안내 ${info.project.name}`, [wire, '유선반']);
  await apiLogin(page, 'team-wireless');
  await page.goto('/requests');
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: number, exact: true }) });
  const requestStatus = row.getByRole('button', { name: '요청 전체 상태: 배정', exact: true });
  const teamStatus = row.getByRole('button', { name: '우리 반 작업 상태: 배정', exact: true });
  await requestStatus.hover();
  const requestTooltip = page.getByRole('tooltip');
  await expect(requestTooltip).toContainText('담당 부서');
  await expect(requestTooltip).toContainText('무선반');
  await expect(requestTooltip).toContainText('유선반');
  await expect(requestTooltip.getByText('대표번호 미등록', { exact: true })).toHaveCount(2);
  await expect(requestTooltip.locator('.workflow-status-steps')).toHaveCount(0);
  const requestHint = await requestTooltip.innerText();
  await requestTooltip.hover();
  await expect(requestTooltip).toBeVisible();
  await requestStatus.focus();
  expect(await requestTooltip.innerText()).toBe(requestHint);
  await page.keyboard.press('Escape');
  await expect(requestTooltip).toHaveCount(0);
  await expect(requestStatus).toBeFocused();

  await teamStatus.hover();
  const teamTooltip = page.getByRole('tooltip');
  await expect(teamTooltip).toContainText('무선반');
  await expect(teamTooltip).not.toContainText('유선반');
  await expect(teamTooltip.getByText('대표번호 미등록', { exact: true })).toHaveCount(1);
  await expect(teamTooltip.locator('.workflow-status-steps')).toHaveCount(0);
  await teamTooltip.hover();
  await expect(teamTooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: number, exact: true }).click();
  const requestProcess = page.getByRole('region', { name: '전체 처리 흐름' });
  const teamProcess = page.getByRole('region', { name: '우리 반 작업 흐름' });
  await expect(requestProcess.locator('.workflow-status-step')).toHaveCount(4);
  await expect(teamProcess.locator('.workflow-status-step')).toHaveCount(3);
  await expect(requestProcess.locator('[aria-current="step"]')).toContainText('배정');
  await expect(teamProcess.locator('[aria-current="step"]')).toContainText('배정');

  await apiLogin(page, 'bnoc');
  await page.goto('/overview');
  const bnocRow = page.locator('.queue-row').filter({ hasText: number });
  const bnocStatus = bnocRow.getByRole('button', { name: '요청 전체 상태: 배정', exact: true });
  await expect(bnocStatus).toBeVisible();
  expect(await bnocStatus.evaluate(element => element.parentElement?.closest('button') === null)).toBeTruthy();
  await bnocStatus.click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('tooltip')).toContainText('유선반');
  await expect(page.getByRole('tooltip').getByText('대표번호 미등록', { exact: true })).toHaveCount(2);
  await noOverflow(page);
  await screenshot(page, info, 'status-guide-detail');
});

test('FR-046: optional personal phone is editable and visible only to the owner, BNOC, and current assigned team', async ({ page }, info) => {
  await page.goto('/requests');
  await loginWithPopup(page, 'requester');
  await page.goto('/new');
  await fields(page, `개인전화 권한 확인 ${info.project.name}`);await guidedOptional(page);
  await page.getByLabel('요청자 개인전화번호', { exact: true }).fill('010-0000-0000');
  await guidedReady(page);
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.getByText('010-0000-0000', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '내용 수정', exact: true }).click();
  await page.getByText('선택 정보', { exact: true }).click();
  await page.getByLabel('개인전화번호', { exact: true }).fill('010-0000-0001');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByText('010-0000-0001', { exact: true })).toBeVisible();
  await page.goto('/requests');
  await expect(page.getByRole('table')).not.toContainText('010-0000-0001');

  await switchWithPopup(page, 'bnoc');
  await page.goto(`/requests/${number}`);
  await expect(page.getByText('010-0000-0001', { exact: true })).toBeVisible();
  let detail = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'assignTeams', { teamIds: [wire], priority: 'general' }, { requestNumber: number, expectedRevision: detail.revision });
  await switchWithPopup(page, 'team-wireless');
  await page.goto(`/requests/${number}`);
  await expect(page.getByText('010-0000-0001', { exact: true })).toBeVisible();

  await switchWithPopup(page, 'bnoc');
  detail = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'reassignAssignedWork', { teamIds: ['유선반'] }, { requestNumber: number, workNumber: detail.workItems[0].workNumber, expectedRevision: detail.workItems[0].revision });
  await switchWithPopup(page, 'team-wireless');
  const previousTeam = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(previousTeam).not.toHaveProperty('personalContact');
  await switchWithPopup(page, 'team-wired');
  const currentTeam = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(currentTeam.personalContact).toBe('010-0000-0001');
});

test('FR-047: BNOC selects the real requester and that requester can edit the proxy request', async ({ page }, info) => {
  await page.goto('/requests');const ownerSession=await apiLogin(page,'requester');await apiLogin(page,'bnoc');
  const choices=(await apiRead(page,'/api/requesters')).data as {requesterRef:string;displayName:string;department:string}[];expect(choices.some(item=>item.requesterRef===ownerSession.actor.id)).toBeTruthy();
  await page.goto('/new');await fields(page,`대리 신청 수정 ${info.project.name}`);
  const picker=page.getByRole('combobox',{name:'요청자 계정',exact:true});await expect(picker).toBeEnabled();
  await expect(page.getByRole('button',{name:'최종 확인',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);
  await picker.selectOption(ownerSession.actor.id);await page.getByRole('button',{name:'최종 확인',exact:true}).click();await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  const number=new URL(page.url()).pathname.split('/').at(-1)!;expect((await apiRead(page,`/api/requests/${number}`)).data.requesterDisplayText).toBe([ownerSession.actor.displayName,ownerSession.actor.department].filter(Boolean).join(' · '));
  await apiLogin(page,'requester');await page.goto(`/requests/${number}`);await expect(page.getByRole('button',{name:'내용 수정',exact:true})).toBeVisible();await page.getByRole('button',{name:'내용 수정',exact:true}).click();
  await guidedDetail(page,`요청자 직접 수정 ${info.project.name}`);
  const saving=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST'&&response.request().postDataJSON().type==='updateRequest');
  await page.getByRole('button',{name:'수정 저장',exact:true}).click();const saved=await saving;expect(saved.status()).toBe(200);expect((await saved.json()).ok).toBe(true);
  await expect(page.getByRole('button',{name:'수정 저장',exact:true})).toHaveCount(0);
  await expect(page.locator('.request-content')).toContainText(`요청자 직접 수정 ${info.project.name}`);expect((await apiRead(page,`/api/requests/${number}`)).data.requestItems[0].detail).toBe(`요청자 직접 수정 ${info.project.name}`);
});

test('FR-048: BNOC records a reason to reject an unassigned request and requester sees the closure', async ({ page }, info) => {
  const number=await seed(page,`담당 범위 밖 요청 ${info.project.name}`);
  await apiLogin(page,'bnoc');
  await page.goto(`/requests/${number}`);
  const reason=page.getByRole('textbox',{name:'기각 사유',exact:true});
  const reject=page.getByRole('button',{name:'요청 기각',exact:true});
  await expect(reason).toBeVisible();
  await expect(reject).toBeDisabled();
  await reason.fill('우리 부대 담당 범위 밖입니다.');
  await expect(reject).toBeEnabled();
  const response=page.waitForResponse(item=>new URL(item.url()).pathname==='/api/commands'&&item.request().method()==='POST');
  await reject.click();
  expect((await response).status()).toBe(200);
  const bnocDetail=(await apiRead(page,`/api/requests/${number}`)).data as {status:string;rejectionReason:string;rejectedAt:string;canReject:boolean};
  expect(bnocDetail.status).toBe('기각');
  expect(bnocDetail.rejectionReason).toBe('우리 부대 담당 범위 밖입니다.');
  expect(Number.isFinite(Date.parse(bnocDetail.rejectedAt))).toBeTruthy();
  expect(bnocDetail.canReject).toBe(false);
  await expect(page.getByRole('button',{name:'요청 전체 상태: 기각',exact:true})).toBeVisible();
  await expect(page.getByText('우리 부대 담당 범위 밖입니다.',{exact:true})).toBeVisible();
  await expect(reject).toHaveCount(0);
  await apiLogin(page,'requester');
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('button',{name:'요청 전체 상태: 기각',exact:true})).toBeVisible();
  await expect(page.getByText('우리 부대 담당 범위 밖입니다.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'내용 수정',exact:true})).toHaveCount(0);
  await screenshot(page,info,'rejected-request');
});

test('SR-BE-015: request list shows per-department progress when one department finishes first', async ({ page }, info) => {
  const number=await seed(page,`부서별 진행 ${info.project.name}`,[wire,'유선반']);
  await apiLogin(page,'requester');
  await page.goto('/requests');
  const row=page.getByRole('row').filter({has:page.getByRole('button',{name:number,exact:true})});
  await expect(row).toContainText('0/2개 부서 완료');
  await apiLogin(page,'team-wireless');
  const current=(await apiRead(page,`/api/requests/${number}`)).data;
  const wireless=current.workItems.find((work:{teamId:string})=>work.teamId===wire);
  await command(page,'updateWork',{nextStatus:'완료'},{requestNumber:number,workNumber:wireless.workNumber,expectedRevision:wireless.revision});
  await apiLogin(page,'requester');
  await page.goto('/requests');
  const updatedRow=page.getByRole('row').filter({has:page.getByRole('button',{name:number,exact:true})});
  await expect(updatedRow).toContainText('1/2개 부서 완료');
  await expect(updatedRow).toContainText('무선반 완료');
  await expect(updatedRow).toContainText('유선반 배정');
  await expect(updatedRow).not.toContainText(/^완료$/);
  await apiLogin(page,'team-wireless');
  await page.goto('/requests');
  const teamRow=page.getByRole('row').filter({has:page.getByRole('button',{name:number,exact:true})});
  await expect(teamRow).toContainText('우리 반: 완료');
  await expect(teamRow).toContainText('1/2개 부서 완료');
  await noOverflow(page);
  await screenshot(page,info,'partial-request-progress');
});

test('SR-BE-012,014,015,021,030: real day/week/month calendar and returned-work reassignment', async ({ page }, info) => {
  const longDetail = `일정 확인 ${info.project.name} ${'확인할 작업 항목 '.repeat(20)}`;
  const number = await seed(page, longDetail, [wire,'유선반']);
  await apiLogin(page, 'team-wireless');
  let current = (await apiRead(page, `/api/requests/${number}`)).data;
  await page.goto(`/requests/${number}`);
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('작업 중');
  await page.getByLabel('작업 일정 날짜').fill('2026-10-20');
  await expect(page.locator('.hour-grid')).toHaveCount(0, 'the editor should use ranges instead of a wall of hour checkboxes');
  await expect(page.getByRole('button', { name: '시간대 추가', exact: true })).toBeDisabled();
  await page.getByLabel('시간대 종료 시각').selectOption('12');
  await expect(page.getByRole('button', { name: '시간대 추가', exact: true })).toBeDisabled();
  await expect(page.locator('.schedule-range-chip')).toHaveCount(0);
  await page.getByLabel('시간대 종료 시각').selectOption('');
  await page.getByLabel('시간대 시작 시각').selectOption('23');
  await expect(page.getByRole('button', { name: '시간대 추가', exact: true })).toBeDisabled();
  await page.getByLabel('시간대 종료 시각').selectOption('24');
  await page.getByRole('button', { name: '시간대 추가', exact: true }).click();
  await expect(page.getByText('2026-10-20 · 23:00–24:00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '2026-10-20 · 23:00–24:00 구간 삭제', exact: true }).click();
  await page.getByLabel('시간대 시작 시각').selectOption('10');
  await page.getByLabel('시간대 종료 시각').selectOption('12');
  await page.getByRole('button', { name: '시간대 추가', exact: true }).click();
  await page.getByLabel('시간대 시작 시각').selectOption('11');
  await page.getByLabel('시간대 종료 시각').selectOption('13');
  await expect(page.getByRole('button', { name: '시간대 추가', exact: true })).toBeDisabled();
  await expect(page.getByText(/이미 선택한 구간과 겹칩니다/)).toBeVisible();
  await page.getByLabel('시간대 시작 시각').selectOption('14');
  await page.getByLabel('시간대 종료 시각').selectOption('15');
  await page.getByRole('button', { name: '시간대 추가', exact: true }).click();
  await page.getByRole('button', { name: '2026-10-20 · 14:00–15:00 구간 삭제', exact: true }).click();
  await expect(page.getByText('2026-10-20 · 10:00–12:00', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-20 · 14:00–15:00', { exact: true })).toHaveCount(0);
  await page.getByLabel('시간대 시작 시각').selectOption('14');
  await page.getByLabel('시간대 종료 시각').selectOption('15');
  await page.getByRole('button', { name: '시간대 추가', exact: true }).click();
  await page.getByLabel('작업 일정 날짜').fill('2026-10-21');
  await page.getByLabel('시간대 시작 시각').selectOption('0');
  await page.getByLabel('시간대 종료 시각').selectOption('1');
  await page.getByRole('button', { name: '시간대 추가', exact: true }).click();
  await expect(page.getByText('2026-10-21 · 00:00–01:00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '2026-10-21 · 00:00–01:00 구간 삭제', exact: true }).click();
  await page.getByLabel('작업 일정 날짜').fill('2026-10-20');
  await noOverflow(page);
  await screenshot(page, info, 'schedule-range-editor');
  await page.getByRole('textbox', { name: '작업 메모', exact: true }).fill('일정 준비물 확인');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('작업 중');
  current = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(current.workItems[0].scheduleIntervals.map(({ startsAt, endsAt }) => ({
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString()
  }))).toEqual([
    { startsAt: '2026-10-20T01:00:00.000Z', endsAt: '2026-10-20T03:00:00.000Z' },
    { startsAt: '2026-10-20T05:00:00.000Z', endsAt: '2026-10-20T06:00:00.000Z' }
  ]);
  await page.goto('/schedule');
  await expect(page.getByRole('heading', { name: '우리 반 일정', exact: true })).toBeVisible();
  for (const view of ['일', '주', '월']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await noOverflow(page);
  }
  await page.getByRole('button', { name: '주', exact: true }).click();
  await page.getByLabel(/기준 날짜|조회 날짜/).fill('2026-10-20');
  const scheduledCards = page.locator('.calendar-item').filter({ hasText: `작업번호: ${number}-1` });
  await expect(scheduledCards).toHaveCount(1, 'all of the work intervals share one calendar card');
  const scheduledCard = scheduledCards.first();
  await expect(scheduledCard).toBeVisible();
  await expect(scheduledCard).toHaveClass(/calendar-item--scheduled/);
  const scheduledColors = await scheduledCard.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderLeftColor };
  });
  await expect(scheduledCard.locator('.calendar-time')).toHaveText('10:00–12:00 · 14:00–15:00');
  const hourWithCard = (label: string) => page.locator('.calendar-hour').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
  await expect(hourWithCard('10:00–11:00').locator('.calendar-item').filter({ hasText: `작업번호: ${number}-1` })).toHaveCount(1);
  await expect(hourWithCard('11:00–12:00').locator('.calendar-item').filter({ hasText: `작업번호: ${number}-1` })).toHaveCount(0);
  await expect(hourWithCard('14:00–15:00').locator('.calendar-item').filter({ hasText: `작업번호: ${number}-1` })).toHaveCount(0);
  await expect(scheduledCard).toContainText('작업 준비');
  await expect(scheduledCard).not.toContainText(longDetail);
  await expect(scheduledCard.locator('.calendar-detail')).toHaveCount(0);
  await expect(scheduledCard.getByText('작업 메모: 일정 준비물 확인', { exact: true })).toBeVisible();
  await expect(scheduledCard).not.toContainText('전화번호');
  const cardTypography = await scheduledCard.locator(':scope > *').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { className: element.className, fontSize: style.fontSize, fontWeight: style.fontWeight, fontFamily: style.fontFamily, color: style.color };
  }));
  expect(new Set(cardTypography.map(style => style.fontSize)).size).toBe(1);
  expect(new Set(cardTypography.map(style => style.fontFamily)).size).toBe(1);
  const timeTypography = cardTypography.find(style => style.className === 'calendar-time');
  expect(timeTypography?.fontWeight).toBe('700');
  expect(cardTypography.filter(style => style.className !== 'calendar-time').every(style => style.fontWeight === '400')).toBe(true);
  expect(new Set(cardTypography.filter(style => style.className !== 'calendar-time').map(style => style.color)).size).toBe(1);
  expect(timeTypography?.color).not.toBe(cardTypography.find(style => style.className !== 'calendar-time')?.color);
  await screenshot(page, info, 'calendar');
  await scheduledCard.click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('완료');
  await page.getByRole('textbox', { name: '완료 메모', exact: true }).fill('실제 완료 기록');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('완료');
  await page.goto('/schedule');
  await page.getByLabel(/기준 날짜|조회 날짜/).fill('2026-10-20');
  const completedScheduleCards = page.locator('.calendar-item').filter({ hasText: `작업번호: ${number}-1` });
  await expect(completedScheduleCards).toHaveCount(1, 'the planned intervals and actual completion share one card');
  await expect(completedScheduleCards.first()).toHaveClass(/calendar-item--completed/);
  await expect(completedScheduleCards.first()).toContainText(`작업번호: ${number}-1 (완료)`);
  await expect(completedScheduleCards.locator('.calendar-time')).toHaveText('10:00–12:00 · 14:00–15:00');
  const completedColors = await completedScheduleCards.first().evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderLeftColor };
  });
  expect(completedColors.background).not.toBe(scheduledColors.background);
  expect(completedColors.border).not.toBe(scheduledColors.border);
  await expect(completedScheduleCards.first()).not.toContainText(/완료\s+\d{4}\.\s*\d{1,2}\./);
  await expect(completedScheduleCards.first()).toContainText('작업 메모: 일정 준비물 확인');

  const unscheduledNumber = await seed(page, `일정 미정 완료 ${info.project.name}`, [wire]);
  await apiLogin(page, 'team-wireless');
  const unscheduledRequest = (await apiRead(page, `/api/requests/${unscheduledNumber}`)).data;
  const unscheduledWork = unscheduledRequest.workItems.find((work: { teamId: string }) => work.teamId === wire);
  await command(page, 'updateWork', { nextStatus: '완료' }, { requestNumber: unscheduledNumber, workNumber: unscheduledWork.workNumber, expectedRevision: unscheduledWork.revision });
  const completedWithoutPlan = (await apiRead(page, `/api/requests/${unscheduledNumber}`)).data.workItems.find((work: { teamId: string }) => work.teamId === wire);
  const completionParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(completedWithoutPlan.completion.completedAt));
  const completionPart = (type: string) => completionParts.find(part => part.type === type)?.value;
  const completionDate = `${completionPart('year')}-${completionPart('month')}-${completionPart('day')}`;
  const completionHour = Number(completionPart('hour'));
  await page.goto('/schedule');
  await page.getByLabel(/기준 날짜|조회 날짜/).fill(completionDate);
  const noPlanCompletedCard = page.locator('.calendar-item').filter({ hasText: `작업번호: ${unscheduledWork.workNumber}` });
  await expect(noPlanCompletedCard).toHaveCount(1, 'a completed work without planned intervals is placed at its completion hour');
  await expect(noPlanCompletedCard).toHaveClass(/calendar-item--completed/);
  await expect(noPlanCompletedCard).toContainText(`작업번호: ${unscheduledWork.workNumber} (완료)`);
  await expect(noPlanCompletedCard.locator('.calendar-time')).toHaveCount(0, 'the time slot heading already supplies the completion time');
  await expect(noPlanCompletedCard).not.toContainText(/완료\s+\d{4}\.\s*\d{1,2}\./);
  const nextHour = String((completionHour + 1) % 24).padStart(2, '0');
  const completionHourLabel = `${String(completionHour).padStart(2, '0')}:00–${nextHour}:00`;
  const completionHourSection = page.locator('.calendar-hour').filter({ has: page.getByRole('heading', { name: completionHourLabel, exact: true }) });
  await expect(completionHourSection.locator('.calendar-item').filter({ hasText: `작업번호: ${unscheduledWork.workNumber}` })).toHaveCount(1);
  const noPlanColors = await noPlanCompletedCard.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderLeftColor };
  });
  expect(noPlanColors.background).not.toBe(scheduledColors.background);
  expect(noPlanColors.border).not.toBe(scheduledColors.border);

  await page.goto(`/requests/${number}`);
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('반환');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect(page.getByText(/반환 사유.*입력/).first()).toBeVisible();
  await page.getByRole('textbox', { name: /^반환 사유(?:\s|$)/ }).fill('다른 작업반 담당');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('반환');
  const returnedRequest=(await apiRead(page,`/api/requests/${number}`)).data;
  expect(returnedRequest.workItems[0].scheduleIntervals).toEqual([]);
  expect(returnedRequest.workItems[0].previousScheduleIntervals).toEqual([
    { startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T03:00:00Z' },
    { startsAt: '2026-10-20T05:00:00Z', endsAt: '2026-10-20T06:00:00Z' }
  ]);
  await expect(page.getByText(/반환 전 일정/).first()).toBeVisible();
  await apiLogin(page, 'bnoc');
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('button',{name:/반환 처리 대기 [1-9]\d*/})).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button', { name: '이 부서 배정 해제', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].resolutionKind).toBe('withdrawn');
  await apiLogin(page,'team-wireless');
  await page.goto(`/requests/${number}`);
  await expect(page.getByText('반환된 부서 배정이 해제된 과거 작업입니다.',{exact:true})).toBeVisible();
  await apiLogin(page,'bnoc');
  await page.goto(`/requests/${number}`);
  await page.locator('form').filter({has:page.getByRole('heading',{name:'작업 부서 추가',exact:true})}).getByLabel('전장반(전산장비)', { exact: true }).check();
  await page.getByRole('button',{name:'선택 부서 추가',exact:true}).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems.length).toBe(3);
  current = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(current.priority).toBe('general');
  expect(current.workItems.find((item: { teamId: string }) => item.teamId === wire).editable).toBe(false);
  expect(current.workItems.find((item: { teamId: string;resolutionKind:string }) => item.teamId === wire && item.resolutionKind==='open')).toBeUndefined();
  expect(current.workItems.find((item: { teamId: string;scheduleIntervals:unknown[] }) => item.teamId === '전장반(전산장비)')?.scheduleIntervals).toEqual([]);

  const reassignmentNumber=await seed(page,`반환 재배정 화면 ${info.project.name}`,[wire,'유선반']);
  await apiLogin(page,'team-wireless');
  const reassignmentRequest=(await apiRead(page,`/api/requests/${reassignmentNumber}`)).data;
  const returnedWork=reassignmentRequest.workItems.find((item:{teamId:string})=>item.teamId===wire);
  await command(page,'updateWork',{nextStatus:'반환',returnReason:'담당 범위 확인'},{requestNumber:reassignmentNumber,workNumber:returnedWork.workNumber,expectedRevision:returnedWork.revision});
  await apiLogin(page,'bnoc');
  await page.goto(`/requests/${reassignmentNumber}`);
  const returnedCard=page.locator('form.card.section-gap').filter({has:page.getByRole('heading',{name:`${wire} 반환 작업`,exact:true})});
  await returnedCard.getByLabel('전장반(전산장비)',{exact:true}).check();
  await returnedCard.getByRole('button',{name:'재배정',exact:true}).click();
  await expect.poll(async()=> (await apiRead(page,`/api/requests/${reassignmentNumber}`)).data.workItems.find((item:{teamId:string;resolutionKind:string})=>item.teamId===wire&&item.resolutionKind==='reassigned')?.resolutionKind).toBe('reassigned');
  const reassigned=(await apiRead(page,`/api/requests/${reassignmentNumber}`)).data;
  expect(reassigned.workItems.some((item:{teamId:string;resolutionKind:string})=>item.teamId==='전장반(전산장비)'&&item.resolutionKind==='open')).toBeTruthy();
  await apiLogin(page,'team-wireless');
  await page.goto(`/requests/${reassignmentNumber}`);
  await expect(page.getByText('재배정된 이전 작업입니다.',{exact:true})).toBeVisible();
  await page.goto('/requests');
  const pastTeamRow=page.getByRole('row').filter({has:page.getByRole('button',{name:reassignmentNumber,exact:true})});
  await expect(pastTeamRow).toContainText('우리 반: 현재 담당 아님 · 과거 참여');
});

test('FR-049, SR-BE-016,024,025,027,033: completed after-action report, department records and BNOC notice attachment', async ({ page }, info) => {
  await apiLogin(page, 'team-wireless');
  await page.goto('/after-action');
  await page.getByRole('combobox', { name: '요청 유형', exact: true }).selectOption('회의 지원');
  await page.getByRole('combobox', { name: '회의 유형', exact: true }).selectOption('화상회의');
  await expect(page.getByRole('combobox', { name: '화상회의 방식', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('첨부파일', { exact: true })).toHaveAttribute('aria-required', 'false');
  await page.getByRole('combobox', { name: '요청 유형', exact: true }).selectOption('장비/체계');
  const requesterOptions=(await apiRead(page,'/api/requesters')).data as {requesterRef:string}[];
  expect(requesterOptions.length).toBeGreaterThan(0);
  await page.getByRole('combobox',{name:'실제 요청자 계정',exact:true}).selectOption(requesterOptions[0].requesterRef);
  await legacyFields(page, `완료 후보고 ${info.project.name}`);
  await page.getByRole('button', { name: '후보고 등록', exact: true }).click();
  await expect(page.getByText(/작업을 완료한 뒤 보고/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue(`완료 후보고 ${info.project.name}`);
  await page.getByLabel('실제 시작 날짜', { exact: true }).fill('2026-10-12');
  await page.getByLabel('실제 시작 시각', { exact: true }).fill('24:00');
  await page.getByLabel('실제 완료 날짜', { exact: true }).fill('2026-10-13');
  await page.getByLabel('실제 완료 시각', { exact: true }).fill('00:00');
  await page.getByRole('textbox', { name: '선조치 사유', exact: true }).fill('직접 요청 완료');
  await page.getByLabel('작업 완료 확인', { exact: true }).check();
  await page.getByRole('button', { name: '후보고 등록', exact: true }).click();
  await expect(page.locator('#actual-start-error')).toContainText('00:00~23:59');
  await expect(page).toHaveURL(/\/after-action$/);
  await page.getByLabel('실제 시작 시각', { exact: true }).fill('23:59');
  await page.getByRole('button', { name: '후보고 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await expect(page.getByText('미분류', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('완료', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '상태 저장' })).toHaveCount(0);
  const reportedNumber = new URL(page.url()).pathname.split('/').at(-1);
  expect(reportedNumber).toBeTruthy();
  const reportedWork = (await apiRead(page, `/api/requests/${reportedNumber}`)).data.workItems[0];
  expect(reportedWork.actualStartedAt).toBe('2026-10-12T14:59:00Z');
  expect(reportedWork.completion.completedAt).toBe('2026-10-12T15:00:00Z');
  await page.goto('/requests');
  const afterActionListRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: reportedNumber, exact: true }) });
  const afterActionStatus = afterActionListRow.getByRole('button', { name: '요청 전체 상태: 완료', exact: true });
  await afterActionStatus.hover();
  await expect(afterActionStatus).toHaveAttribute('aria-describedby', /.+/);
  const afterActionTooltip = page.locator(`#${await afterActionStatus.getAttribute('aria-describedby')}`);
  await expect(afterActionTooltip).toContainText('수행 부서');
  await expect(afterActionTooltip).toContainText('무선반');
  await expect(afterActionTooltip).toContainText('대표번호 미등록');
  await expect(afterActionTooltip).not.toContainText('000-0000');
  await expect(afterActionTooltip.locator('.workflow-status-step')).toHaveCount(0);
  const afterActionTeamStatus = afterActionListRow.getByRole('button', { name: '우리 반 작업 상태: 완료', exact: true });
  await afterActionTeamStatus.hover();
  await expect(afterActionTeamStatus).toHaveAttribute('aria-describedby', /.+/);
  const afterActionTeamTooltip = page.locator(`#${await afterActionTeamStatus.getAttribute('aria-describedby')}`);
  await expect(afterActionTeamTooltip).toContainText('수행 부서');
  await expect(afterActionTeamTooltip).toContainText('무선반');
  await expect(afterActionTeamTooltip).toContainText('대표번호 미등록');
  await page.goto('/schedule');
  await page.getByLabel(/기준 날짜|조회 날짜/).fill('2026-10-12');
  const completedCard = page.locator('.calendar-item').filter({ hasText: `작업번호: ${reportedWork.workNumber}` });
  await expect(completedCard).toHaveCount(1, 'an after-action completion is shown once at its actual start');
  await expect(completedCard).toBeVisible();
  await expect(completedCard).toHaveClass(/calendar-item--completed/);
  await expect(completedCard.locator('.calendar-time')).toHaveText('23:59');
  await expect(completedCard).toContainText(`작업번호: ${reportedWork.workNumber} (완료)`);
  await expect(completedCard).not.toContainText('전화번호');
  await completedCard.click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await page.goto('/operations');
  const afterActionRow = page.getByRole('row').filter({ hasText: reportedWork.workNumber });
  await expect(afterActionRow).toBeVisible();
  await expect(afterActionRow).toContainText('선조치 후보고');
  await expect(afterActionRow).toContainText('완료');
  await apiLogin(page, 'bnoc');
  await page.goto('/notices/new');
  await page.getByLabel('제목', { exact: true }).fill(`업무 안내 ${info.project.name}`);
  const noticeEditor=page.getByRole('textbox', { name: '내용', exact: true });
  await noticeEditor.fill('공지게시판 업무 전달');
  await noticeEditor.selectText();
  await page.getByRole('button', { name: '굵게', exact: true }).click();
  await noticeEditor.selectText();
  await page.getByRole('button', { name: '밑줄', exact: true }).click();
  for(const size of [16,20,24,20]) {
    await noticeEditor.selectText();
    await page.getByRole('button', { name: `글자 크기 ${size}`, exact: true }).click();
  }
  for(const color of ['#b91c1c','#166534','default','#1d4ed8']) {
    await noticeEditor.selectText();
    await page.getByRole('combobox', { name: '글자색', exact: true }).selectOption(color);
  }
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '공지문서.txt', mimeType: 'text/plain', buffer: Buffer.from('공지 첨부') });
  await page.getByRole('button', { name: '공지 게시', exact: true }).click();
  await expect(page.getByRole('heading', { name: `업무 안내 ${info.project.name}` })).toBeVisible();
  const noticeRoute = new URL(page.url()).pathname;
  const createdNotice=(await apiRead(page,noticeRoute.replace('/notices/','/api/notices/'))).data;
  expect(createdNotice.body).toBe('공지게시판 업무 전달');
  expect(createdNotice.bodyDocument.blocks[0].runs).toEqual([{text:'공지게시판 업무 전달',bold:true,underline:true,size:20,color:'#1d4ed8'}]);
  await apiLogin(page, 'bnoc-secondary');
  await page.goto(noticeRoute);
  await page.getByRole('button', { name: '공지 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('다른 BNOC 수정 내용');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByText('다른 BNOC 수정 내용', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /공지문서\.txt/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /게시 종료|읽음 확인|숨기기/ })).toHaveCount(0);
  await screenshot(page, info, 'notice');
});

test('SR-BE-006,027,032: delayed uploads preserve current fields and mixed upload failures require retry or explicit exclusion', async ({ page }) => {
  await apiLogin(page,'requester');await page.goto('/new');await fields(page,'첨부 전 요청 내용');
  const attachmentInput=await guidedAttachments(page);
  let releaseUpload!:()=>void,uploadStarted!:()=>void;const waiting=new Promise<void>(resolve=>{releaseUpload=resolve;}),started=new Promise<void>(resolve=>{uploadStarted=resolve;});
  await page.route('**/api/attachments?**',async route=>{uploadStarted();await waiting;await route.continue();});
  await attachmentInput.setInputFiles({name:'지연문서.txt',mimeType:'text/plain',buffer:Buffer.from('지연 업로드 내용')});await started;
  await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'이전',exact:true})).toBeDisabled();await expect(question(page).getByRole('button',{name:'내용 수정',exact:true})).toBeDisabled();await expectGuidedDetail(page,'첨부 전 요청 내용');
  releaseUpload();await expect(page.getByRole('button',{name:'지연문서.txt 첨부 제외',exact:true})).toBeVisible();await page.unroute('**/api/attachments?**');
  await guidedDetail(page,'첨부 중 바꾼 요청 내용');await guidedItemReview(page);await question(page).getByRole('button',{name:'위치 수정',exact:true}).click();await page.getByLabel('어디에 있나요?',{exact:true}).fill('첨부 중 바꾼 위치');await question(page).getByRole('button',{name:'다음',exact:true}).click();await guidedReady(page);
  await page.getByRole('button',{name:'4단계 연락처',exact:true}).click();await page.getByLabel('요청자 군내전화번호',{exact:true}).fill('000-1111');await guidedReady(page);
  await expectGuidedDetail(page,'첨부 중 바꾼 요청 내용','컴퓨터 지원 1대 / 첨부 중 바꾼 위치 / 인트라넷 / 첨부 중 바꾼 요청 내용');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  const savedNumber=new URL(page.url()).pathname.split('/').at(-1)!;const saved=(await apiRead(page,`/api/requests/${savedNumber}`)).data;
  expect(saved.requestItems[0].detail).toBe('첨부 중 바꾼 요청 내용');expect(saved.requestItems[0].location).toBe('첨부 중 바꾼 위치');expect(saved.contact).toBe('000-1111');expect(saved.attachments.map((file:{fileName:string})=>file.fileName)).toEqual(['지연문서.txt']);expect(saved.requestItems[0].attachmentIds).toEqual(saved.attachments.map((file:{id:string})=>file.id));
  await page.goto('/new');await fields(page,'실패 첨부 처리 후 제출');const nextAttachment=await guidedAttachments(page);
  let retryAllowed=false;await page.route('**/api/attachments?**',route=>{
    const body=route.request().postDataBuffer()?.toString()??'';
    if(body.includes('제외문서.txt')||(body.includes('재시도문서.txt')&&!retryAllowed))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'SAVE_FAILED',message:'첨부 저장에 실패했습니다.'})});return route.continue();
  });
  await nextAttachment.setInputFiles([{name:'재시도문서.txt',mimeType:'text/plain',buffer:Buffer.from('재시도 보존 내용')},{name:'완료문서.txt',mimeType:'text/plain',buffer:Buffer.from('다른 파일은 성공')}]);
  await expect(page.getByRole('button',{name:'재시도문서.txt 업로드 다시 시도',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'완료문서.txt 첨부 제외',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeDisabled();await expectGuidedDetail(page,'실패 첨부 처리 후 제출');
  await page.getByRole('button',{name:'재시도문서.txt 업로드 다시 시도',exact:true}).click();await expect(page.getByText(/파일을 올리는 중/)).toHaveCount(0);await expect(page.getByRole('button',{name:'재시도문서.txt 업로드 다시 시도',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeDisabled();
  retryAllowed=true;await page.getByRole('button',{name:'재시도문서.txt 업로드 다시 시도',exact:true}).click();await expect(page.getByRole('button',{name:'재시도문서.txt 첨부 제외',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeEnabled();
  await nextAttachment.setInputFiles({name:'제외문서.txt',mimeType:'text/plain',buffer:Buffer.from('사용자가 제외')});await expect(page.getByRole('button',{name:'제외문서.txt 실패 첨부 제외',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'제외문서.txt 실패 첨부 제외',exact:true}).click();await expect(page.getByRole('button',{name:'이 대상 확인 완료',exact:true})).toBeEnabled();await guidedReady(page);await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  const number=new URL(page.url()).pathname.split('/').at(-1)!;const completed=(await apiRead(page,`/api/requests/${number}`)).data;
  expect(completed.attachments.map((file:{fileName:string})=>file.fileName).sort()).toEqual(['완료문서.txt','재시도문서.txt']);expect(completed.requestItems[0].detail).toBe('실패 첨부 처리 후 제출');await page.unroute('**/api/attachments?**');
  await apiLogin(page, 'bnoc');
  await page.goto('/notices/new');
  await page.getByLabel('제목', { exact: true }).fill('첨부 전 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('첨부 전 공지 내용');
  let releaseNoticeUpload!: () => void;
  const noticeWaiting = new Promise<void>(resolve => { releaseNoticeUpload = resolve; });
  await page.route('**/api/attachments?**', async route => { await noticeWaiting; await route.continue(); });
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '공지지연문서.txt', mimeType: 'text/plain', buffer: Buffer.from('공지 지연 업로드') });
  await expect(page.getByText(/파일을 올리는 중/)).toBeVisible();
  await expect(page.getByRole('button', { name: '공지 게시', exact: true })).toBeDisabled();
  await page.getByLabel('제목', { exact: true }).fill('첨부 중 바꾼 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('첨부 중 바꾼 공지 내용');
  releaseNoticeUpload();
  await expect(page.getByRole('button', { name: '공지지연문서.txt 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('첨부 중 바꾼 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveText('첨부 중 바꾼 공지 내용');
  await page.unroute('**/api/attachments?**');
  await page.getByRole('button', { name: '공지 게시', exact: true }).click();
  await expect(page.getByRole('heading', { name: '첨부 중 바꾼 공지 제목', exact: true })).toBeVisible();
  await expect(page.getByText('첨부 중 바꾼 공지 내용', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '공지지연문서.txt', exact: true })).toBeVisible();
  await noOverflow(page);
});

test('SR-BE-007,029,030,032: failed, lost, stale and expired saves retain input and require explicit recovery', async ({ page }) => {
  await apiLogin(page,'requester');await page.goto('/new');await expect(page.getByRole('button',{name:'신청 등록',exact:true})).toHaveCount(0);await fields(page,'저장 입력 보존');
  const submissions:Record<string,unknown>[]=[];let intercepted=false,committedNumber='';
  await page.route('**/api/commands',async route=>{
    const payload=route.request().postDataJSON();submissions.push(payload);
    if(!intercepted){intercepted=true;const committed=await route.fetch();expect(committed.status()).toBe(200);committedNumber=(await committed.json()).requestNumber;await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByText(/저장 결과를 확인하지 못했습니다/).first()).toBeVisible();await expectGuidedDetail(page,'저장 입력 보존');
  await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();expect(submissions).toHaveLength(2);expect(submissions[1]).toEqual(submissions[0]);await page.unroute('**/api/commands');
  const number=new URL(page.url()).pathname.split('/').at(-1)!;expect(number).toBe(committedNumber);expect((await apiRead(page,`/api/requests?requestNumber=${number}`)).total).toBe(1);
  await page.getByRole('button',{name:'내용 수정',exact:true}).click();await guidedDetail(page,'사용자 편집 중 입력');
  const snapshot=(await apiRead(page,`/api/requests/${number}`)).data;
  await command(page,'updateRequest',{intakeVersion:1,itemQuantities:snapshot.itemQuantities,requestItems:snapshot.requestItems.map((item:any,index:number)=>index===0?{...item,detail:'서버의 먼저 저장된 내용'}:item)},{requestNumber:number,expectedRevision:snapshot.revision});
  await page.getByRole('button',{name:'수정 저장',exact:true}).click();await expect(page.getByText(/다른 변경.*저장|다른 변경.*반영|다른 담당자.*수정/).first()).toBeVisible();await expectGuidedDetail(page,'사용자 편집 중 입력');
  await page.getByRole('button',{name:'최신 내용 다시 불러오기',exact:true}).click();await expectGuidedDetail(page,'서버의 먼저 저장된 내용');await guidedDetail(page,'세션 만료 뒤 유지');
  const session=(await apiRead(page,'/api/session')).data;expect((await page.request.post('/api/auth/logout',{headers:{Origin:new URL(base).origin,'X-CSRF-Token':session.csrfToken},data:{}})).status()).toBe(200);
  const expiryDialog=page.getByRole('dialog',{name:'로그인 만료'});if(!await expiryDialog.isVisible())await page.getByRole('button',{name:'수정 저장',exact:true}).click();await expect(expiryDialog).toBeVisible();await expect(page.getByText(/만료|다시 로그인/).first()).toBeVisible();
  await expectGuidedDetail(page,'세션 만료 뒤 유지');const before=await page.evaluate(()=>Object.keys(localStorage));expect(before).toHaveLength(0);await loginWithPopup(page,'requester');await expectGuidedDetail(page,'세션 만료 뒤 유지');
  await page.getByRole('button',{name:'수정 저장',exact:true}).click();await expect.poll(async()=>(await apiRead(page,`/api/requests/${number}`)).data.requestItems[0].detail).toBe('세션 만료 뒤 유지');
});

test('SR-BE-010,011,019,027,030,032: BNOC drafts retain their starting versions through reauthentication, notice updates, and assignment-to-classification changes', async ({ page, request: otherRequest }, info) => {
  const other = { request: otherRequest };
  const primarySession = await apiLogin(page, 'bnoc');
  const otherSession = await apiLogin(other, 'bnoc-secondary');
  expect(otherSession.actor.id).not.toBe(primarySession.actor.id);
  expect((await apiRead(page, '/api/session')).data.actor.id).toBe(primarySession.actor.id);
  const expire = async () => {
    const session = (await apiRead(page, '/api/session')).data;
    const response = await page.request.post('/api/auth/logout', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, data: {} });
    expect(response.status()).toBe(200);
  };
  const responseFor = (type: string, status: number) => page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST' && response.request().postDataJSON().type === type && response.status() === status);
  const refreshFor = (resource: string) => page.waitForResponse(response => new URL(response.url()).pathname === resource && response.request().method() === 'GET' && response.status() === 200);
  const noticeSaved = await command(page, 'createDirective', { title: `재인증 공지 ${info.project.name}`, body: '처음 저장한 공지 내용', attachmentRefs: [] });
  const noticeRef = noticeSaved.publicRef;
  const noticeBefore = (await apiRead(page, `/api/notices/${noticeRef}`)).data;
  await page.goto(`/notices/${noticeRef}`);
  await page.getByRole('button', { name: '공지 수정', exact: true }).click();
  await page.getByLabel('제목', { exact: true }).fill('아직 저장하지 않은 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('아직 저장하지 않은 공지 내용');
  await command(other, 'updateDirective', { noticeRef, title: '다른 BNOC가 저장한 공지 제목', body: '다른 BNOC가 저장한 공지 내용', attachmentRefs: [] }, { expectedRevision: noticeBefore.revision });
  const noticeLatest = (await apiRead(other, `/api/notices/${noticeRef}`)).data;
  expect(noticeLatest.revision).toBeGreaterThan(noticeBefore.revision);
  await expire();
  const expiredNotice = responseFor('updateDirective', 401);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  expect((await expiredNotice).request().postDataJSON().expectedRevision).toBe(noticeBefore.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toBeVisible();
  const refreshedNotice = refreshFor(`/api/notices/${noticeRef}`);
  await loginWithPopup(page, 'bnoc');
  expect((await (await refreshedNotice).json()).data.revision).toBe(noticeLatest.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('아직 저장하지 않은 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveText('아직 저장하지 않은 공지 내용');
  const noticeConflict = responseFor('updateDirective', 409);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  const conflictedNotice = await noticeConflict;
  expect((await conflictedNotice.json()).code).toBe('CONFLICT');
  expect(conflictedNotice.request().postDataJSON().expectedRevision).toBe(noticeBefore.revision);
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveText('아직 저장하지 않은 공지 내용');
  expect((await apiRead(other, `/api/notices/${noticeRef}`)).data).toEqual(noticeLatest);
  await page.getByRole('button', { name: '최신 내용 다시 불러오기', exact: true }).click();
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('다른 BNOC가 저장한 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveText('다른 BNOC가 저장한 공지 내용');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('최신 내용 확인 후 다시 작성한 공지');
  const noticeCommitted = responseFor('updateDirective', 200);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  expect((await noticeCommitted).request().postDataJSON().expectedRevision).toBe(noticeLatest.revision);
  await expect(page.getByRole('heading', { name: noticeLatest.title, exact: true })).toBeVisible();
  expect((await apiRead(other, `/api/notices/${noticeRef}`)).data.body).toBe('최신 내용 확인 후 다시 작성한 공지');

  const number = await seed(page, `재인증 배정 확인 ${info.project.name}`);
  await apiLogin(page, 'bnoc');
  const requestBefore = (await apiRead(page, `/api/requests/${number}`)).data;
  await page.goto(`/requests/${number}`);
  await page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ }).selectOption('urgent');
  await page.getByLabel(wire, { exact: true }).check();
  await command(other, 'assignTeams', { teamIds: [wire], priority: 'general' }, { requestNumber: number, expectedRevision: requestBefore.revision });
  const requestLatest = (await apiRead(other, `/api/requests/${number}`)).data;
  expect(requestLatest.workItems).toHaveLength(1); expect(requestLatest.priority).toBe('general');
  await expire();
  const expiredAssignment = responseFor('assignTeams', 401);
  await page.getByRole('button', { name: '선택 작업반 배정', exact: true }).click();
  expect((await expiredAssignment).request().postDataJSON().expectedRevision).toBe(requestBefore.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toBeVisible();
  const refreshedRequest = refreshFor(`/api/requests/${number}`);
  await loginWithPopup(page, 'bnoc');
  expect((await (await refreshedRequest).json()).data.revision).toBe(requestLatest.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '선택 작업반 배정', exact: true })).toHaveCount(0);
  await expect(page.getByText('현재 분류: 일반', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'분류 변경',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'일반·긴급',exact:true})).toHaveValue('general');
  await page.getByRole('combobox',{name:'일반·긴급',exact:true}).selectOption('urgent');
  await command(other,'updateRequest',{detail:`다른 BNOC가 수정 ${info.project.name}`},{requestNumber:number,expectedRevision:requestLatest.revision});
  const requestAfterOtherEdit=(await apiRead(other,`/api/requests/${number}`)).data;
  const classificationConflict=responseFor('changePriority',409);
  await page.getByRole('button',{name:'분류 저장',exact:true}).click();
  const conflictedClassification=await classificationConflict;
  expect((await conflictedClassification.json()).code).toBe('CONFLICT');
  expect(conflictedClassification.request().postDataJSON().expectedRevision).toBe(requestLatest.revision);
  await expect(page.getByRole('combobox',{name:'일반·긴급',exact:true})).toHaveValue('urgent');
  await expect(page.getByRole('button',{name:'최신 내용 다시 불러오기',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'최신 내용 다시 불러오기',exact:true}).click();
  await expect(page.getByText('현재 분류: 일반',{exact:true})).toBeVisible();
  await expect.poll(async()=>(await apiRead(other,`/api/requests/${number}`)).data.detail).toBe(`다른 BNOC가 수정 ${info.project.name}`);
  await page.getByRole('button',{name:'분류 변경',exact:true}).click();
  await page.getByRole('combobox',{name:'일반·긴급',exact:true}).selectOption('urgent');
  const classificationCommitted = responseFor('changePriority', 200);
  await page.getByRole('button', { name: '분류 저장', exact: true }).click();
  expect((await classificationCommitted).request().postDataJSON().expectedRevision).toBe(requestAfterOtherEdit.revision);
  await expect.poll(async () => (await apiRead(other, `/api/requests/${number}`)).data.priority).toBe('urgent');
  expect((await apiRead(other, `/api/requests/${number}`)).data.workItems).toEqual(requestLatest.workItems);
  const publicHistory = (await apiRead(other, `/api/requests/${number}/history`)).data.items;
  const priorityHistory = publicHistory.find((entry: { field: string }) => entry.field === '일반·긴급');
  expect(priorityHistory.field).toBe('일반·긴급');
  expect(priorityHistory.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  expect(Number.isFinite(Date.parse(priorityHistory.at))).toBe(true);
  await humanHistory(page, '일반·긴급: 일반 → 긴급', requestLatest.assignedAt);
  await noOverflow(page);
});

test('SR-BE-026,032,033,035: GPS and CPCON open separate popups with status but no timestamps', async ({ page }, info) => {
  await apiLogin(page, 'requester');
  await page.goto('/requests');
  const nav = page.getByRole('navigation', { name: '주 메뉴' });
  const gpsButton = page.getByRole('button', { name: /^GPS / });
  const cpconButton = page.getByRole('button', { name: /^CPCON / });
  await expect(gpsButton).toBeVisible();
  await expect(cpconButton).toBeVisible();
  await expect(nav.getByRole('button', { name: 'GPS·CPCON', exact: true })).toHaveCount(0);
  let gpsPopup: Page | undefined;
  let cpconPopup: Page | undefined;
  try {
    const gpsOpened = page.waitForEvent('popup');
    await gpsButton.click();
    gpsPopup = await gpsOpened;
    await expect(gpsPopup).toHaveURL(/\/external-systems\/gps\/index\.html$/);
    await expect(gpsPopup.getByRole('heading', { name: 'GPS 정보', exact: true })).toBeVisible();
    await expect(gpsPopup.getByText('GPS 정보원', { exact: true })).toBeVisible();
    await expect(gpsPopup.getByText('CPCON 정보원', { exact: true })).toHaveCount(0);
    await expect(gpsPopup.getByRole('navigation')).toHaveCount(0);
    await expect(gpsPopup.getByText(/원본 기준시각|마지막 성공|마지막 시도/)).toHaveCount(0);
    await expect(gpsPopup.locator('.situation-stage')).toHaveText(/^(?:[1-5]단계(?: · 양호)?|양호|수집된 값 없음)$/);

    const cpconOpened = page.waitForEvent('popup');
    await cpconButton.click();
    cpconPopup = await cpconOpened;
    await expect(cpconPopup).toHaveURL(/\/external-systems\/cpcon\/index\.html$/);
    await expect(cpconPopup.getByRole('heading', { name: 'CPCON 정보', exact: true })).toBeVisible();
    await expect(cpconPopup.getByText('CPCON 정보원', { exact: true })).toBeVisible();
    await expect(cpconPopup.getByText('GPS 정보원', { exact: true })).toHaveCount(0);
    await expect(cpconPopup.getByText(/원본 기준시각|마지막 성공|마지막 시도/)).toHaveCount(0);
    await expect(cpconPopup.locator('.situation-stage')).toHaveText(/^(?:I|II|III|IV|V|수집된 값 없음)$/);
    await expect(cpconPopup.getByRole('button', { name: /단계.*변경|단계.*설정/ })).toHaveCount(0);
    await expect(cpconPopup.getByText(/모의 인증|모의 정보|대회용/)).toHaveCount(0);

    for (const [stageCode,letter,canonical] of [['1','I','Ⅰ'],['2','II','Ⅱ'],['3','III','Ⅲ'],['4','IV','Ⅳ'],['5','V','Ⅴ']]) {
      await providerControl(page,{gps:{scenario:'normal',stageCode:'3'},cpcon:{scenario:'normal',stageCode}});
      await expect.poll(async()=>{const state=(await apiRead(page,'/api/situation/cpcon')).data;return state.collectionState==='ok'&&state.stageCode===stageCode;}).toBe(true);
      await cpconPopup.reload();
      await expect(cpconPopup.locator('.situation-stage')).toHaveText(letter);
      expect((await apiRead(page,'/api/situation/cpcon')).data.stageLabel).toBe(`CPCON${canonical}급`);
    }
    await providerControl(page,{gps:{scenario:'normal',stageCode:'3'},cpcon:{scenario:'normal',stageCode:'4'}});
    await expect.poll(async()=>{const state=(await apiRead(page,'/api/situation/gps')).data;return state.collectionState==='ok'&&Number(state.stageCode)===3;}).toBe(true);
    await providerControl(page,{gps:{scenario:'error'},cpcon:{scenario:'normal',stageCode:'4'}});
    await expect.poll(async()=>{
      const [gps,cpcon]=await Promise.all([apiRead(page,'/api/situation/gps'),apiRead(page,'/api/situation/cpcon')]);
      return gps.data.collectionState==='failed'&&cpcon.data.collectionState==='ok'&&Number(cpcon.data.stageCode)===4;
    }).toBe(true);
    await gpsPopup.reload();
    await cpconPopup.reload();
    await page.reload();
    const gpsCard=gpsPopup.locator('.situation-card');
    const cpconCard=cpconPopup.locator('.situation-card');
    await expect(cpconCard.locator('.situation-stage')).toHaveText('IV');
    await expect(gpsCard.getByText('갱신 실패',{exact:true})).toBeVisible();
    await expect(cpconCard.getByText('수집 정상',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:/GPS.*갱신 실패/})).toBeVisible();
    await expect(page.getByRole('button',{name:/CPCON.*정상/})).toBeVisible();
    await providerControl(page,{gps:{scenario:'normal',stageCode:'3'},cpcon:{scenario:'error'}});
    await expect.poll(async()=>{
      const [gps,cpcon]=await Promise.all([apiRead(page,'/api/situation/gps'),apiRead(page,'/api/situation/cpcon')]);
      return gps.data.collectionState==='ok'&&Number(gps.data.stageCode)===3&&cpcon.data.collectionState==='failed';
    }).toBe(true);
    await gpsPopup.reload();
    await cpconPopup.reload();
    await page.reload();
    await expect(gpsCard.getByText('수집 정상',{exact:true})).toBeVisible();
    await expect(cpconCard.getByText('갱신 실패',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:/GPS.*정상/})).toBeVisible();
    await expect(page.getByRole('button',{name:/CPCON.*갱신 실패/})).toBeVisible();
    await navItem(page,'내 신청');
    await page.route('**/api/situation',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'SAVE_FAILED',message:'상황을 조회하지 못했습니다.'})}));
    const failedSituationRequest=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/situation'&&response.status()===503);
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await failedSituationRequest;
    const gpsContext=page.getByRole('button',{name:/GPS.*조회 오류.*마지막 값/});
    await expect(gpsContext).toContainText('조회 오류 · 마지막 값');
    await expect(gpsContext).not.toContainText('정상');
    await noOverflow(gpsPopup);
    await screenshot(cpconPopup, info, 'situation');
    await page.context().route('**/api/situation/cpcon', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED' }) }));
    const cpconReadFailure = cpconPopup.waitForResponse(response => new URL(response.url()).pathname === '/api/situation/cpcon' && response.status() === 503);
    await cpconPopup.getByRole('button', { name: '새로고침' }).click();
    await cpconReadFailure;
    await expect(cpconCard.locator('.badge')).toHaveText('조회 오류 · 마지막 값');
    await expect(cpconCard.locator('.situation-stage')).toHaveText('IV');
    await expect(cpconCard.locator('.notice')).toContainText('마지막 응답');
  } finally {
    await page.unroute('**/api/situation');
    await page.context().unroute('**/api/situation/cpcon');
    await providerControl(page,{reset:true});
    if (gpsPopup && !gpsPopup.isClosed()) await gpsPopup.close();
    if (cpconPopup && !cpconPopup.isClosed()) await cpconPopup.close();
  }
  await noOverflow(page);
  await expect(page.getByRole('heading', { name: '신청 목록' })).toBeVisible();
  await page.route('**/api/requests?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '일시적으로 조회할 수 없습니다.' }) }));
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText(/조회.*실패|조회.*못|조회할 수 없습니다/).first()).toBeVisible();
  await expect(page.getByText(/조건에 맞는 신청이 없습니다|조회된 항목 없음/)).toHaveCount(0);
  await page.unroute('**/api/requests?**');
  const restoredRequests = page.waitForResponse(response => new URL(response.url()).pathname === '/api/requests' && response.request().method() === 'GET' && response.status() === 200);
  await page.reload();
  await restoredRequests;
  await expect(page.getByRole('heading', { name: '신청 목록', exact: true })).toBeVisible();
  await expect(page.getByText('불러오는 중…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '검색', exact: true })).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '본문으로 건너뛰기', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await noOverflow(page);
  expect(await page.locator('body').innerText()).not.toMatch(/윤하린|배지안|ID-260901|시험 단계\s*[ABab]/);
});

test('SR-BE-014: direct assigned department change without return and started work stays locked', async ({page},info) => {
  const number=await seed(page,`직접 배정 변경 ${info.project.name}`,[wire]);
  await page.goto(`/requests/${number}`);
  const form=page.locator('form').filter({has:page.getByRole('heading',{name:'무선반 배정 변경',exact:true})});
  await expect(form).toBeVisible();
  await expect(form.getByRole('button',{name:'이 부서 배정 해제',exact:true})).toHaveCount(0);
  await form.getByRole('checkbox',{name:'유선반',exact:true}).focus();
  await page.keyboard.press('Space');
  await form.getByRole('button',{name:'배정 변경 저장',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({hasText:'배정을 유선반으로 변경했습니다.'})).toBeVisible();
  await expect.poll(async ()=>(await apiRead(page,`/api/requests/${number}`)).data.teamIds).toEqual(['유선반']);
  await page.reload();
  await expect(page.getByText(/재배정된 과거 작업/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'유선반 배정 변경',exact:true})).toBeVisible();
  await noOverflow(page);await screenshot(page,info,'direct-assignment');
  await apiLogin(page,'team-wireless');await page.goto(`/requests/${number}`);
  await expect(page.getByText('재배정된 이전 작업입니다.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'상태 저장',exact:true})).toHaveCount(0);
  await apiLogin(page,'team-wired');
  const current=(await apiRead(page,`/api/requests/${number}`)).data.workItems.find((work:{resolved:boolean})=>!work.resolved);
  await command(page,'updateWork',{nextStatus:'작업 중'},{requestNumber:number,workNumber:current.workNumber,expectedRevision:current.revision});
  await apiLogin(page,'bnoc');await page.goto(`/requests/${number}`);
  await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'배정 변경 저장',exact:true})).toHaveCount(0);
  await noOverflow(page);
});

test('planned-maintenance UI: date control uses only the native calendar', async ({ page }) => {
  await apiLogin(page, 'team-wireless');
  await page.goto('/requests?view=planned-maintenance');
  await expect(page.getByRole('heading', { name: '계획 정비', exact: true })).toBeVisible();
  await expect(page.locator('.planned-date-control button')).toHaveCount(0);
  await expect(page.locator('.planned-date-panel input[type="date"]')).toHaveCount(1);
});

test('planned-maintenance UI: completion details do not squeeze the task row', async ({ page }) => {
  const businessWrites: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      businessWrites.push(`${request.method()} ${pathname}`);
    }
  });
  await apiLogin(page, 'team-wireless');
  await page.goto('/requests?view=planned-maintenance');
  const title = `공통 UI 정렬 검사 ${randomUUID()}`;
  await page.getByLabel('작업 제목', { exact: true }).fill(title);
  await page.getByRole('button', { name: '작업 추가', exact: true }).click();
  const addedItem = page.locator('.planned-item').filter({ hasText: title });
  await expect(addedItem).toBeVisible();
  await page.reload();
  await expect(page.locator('.planned-item').filter({ hasText: title })).toBeVisible();
  const item = page.locator('.planned-item').filter({ hasText: title });
  await expect(item.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const main = item.locator('.planned-item-main');
  const actions = item.locator('.planned-item-actions');
  const rowDisplay = await item.evaluate(element => getComputedStyle(element).display);
  expect(rowDisplay, 'ActionRow owns the work item layout').toBe('grid');
  const groupLayout = await actions.evaluate(element => ({ display: getComputedStyle(element).display, boxes: [...element.querySelectorAll('button')].map(item => { const box=item.getBoundingClientRect();return {top:box.top,bottom:box.bottom}; }) }));
  expect(groupLayout.display, 'ActionGroup lays out its actions in one row').toBe('flex');
  expect(new Set(groupLayout.boxes.map(box=>`${box.top}:${box.bottom}`)).size, 'single-row action controls share the same vertical bounds').toBe(1);
  await item.getByRole('button', { name: '수정', exact: true }).click();
  const editRow = page.locator('.planned-item').filter({ has: page.locator('.planned-edit') });
  const editCancel = editRow.getByRole('button', { name: '취소', exact: true });
  await expect(editCancel).toHaveJSProperty('type', 'button');
  await editCancel.click();
  await item.getByRole('button', { name: '완료', exact: true }).click();
  const completion = item.locator('.planned-complete-check');
  const detailsSlot = item.locator('.ui-action-row__details');
  await expect(completion.locator('input[type="date"]')).toHaveCount(1);
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const mainBox = await main.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(mainBox!.width, 'task title must retain a readable column').toBeGreaterThan(360);
    const mainCenter = mainBox!.y + mainBox!.height / 2;
    const actionsCenter = actionsBox!.y + actionsBox!.height / 2;
    expect(Math.abs(mainCenter - actionsCenter), 'title and action buttons share one vertical center').toBeLessThan(2);
    const actionButtons = await actions.locator('button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { y: rect.y, height: rect.height, type: button.type };
    }));
    expect(actionButtons.length).toBeGreaterThan(1);
    expect(actionButtons.map(button => button.type), 'row actions must not submit an enclosing form').toEqual(actionButtons.map(() => 'button'));
    expect(Math.min(...actionButtons.map(button => button.height)), 'shared controls meet the 44px minimum').toBeGreaterThanOrEqual(44);
    expect(Math.max(...actionButtons.map(button => button.height)) - Math.min(...actionButtons.map(button => button.height))).toBeLessThan(1);
    expect(Math.max(...actionButtons.map(button => button.y)) - Math.min(...actionButtons.map(button => button.y))).toBeLessThan(2);

    const completionBox = await completion.boundingBox();
    expect(completionBox).not.toBeNull();
    const detailsBox = await detailsSlot.boundingBox();
    expect(detailsBox).not.toBeNull();
    expect(await detailsSlot.evaluate(element => getComputedStyle(element).gridColumn), 'ActionRow details slot spans both grid columns').toBe('1 / -1');
    expect(detailsBox!.y, 'completion controls sit below the task title and actions').toBeGreaterThan(mainBox!.y + mainBox!.height - 1);
    expect(detailsBox!.x).toBeGreaterThanOrEqual((await item.boundingBox())!.x);
    expect(detailsBox!.x + detailsBox!.width).toBeLessThanOrEqual((await item.boundingBox())!.x + (await item.boundingBox())!.width + 1);
  }
  page.once('dialog', dialog => dialog.accept());
  await completion.getByRole('button', { name: '완료 처리', exact: true }).click();
  const completedItem = page.locator('.planned-item').filter({ hasText: title });
  await expect(completedItem.locator('.planned-item-status')).toContainText('완료');
  page.once('dialog', dialog => dialog.accept());
  await completedItem.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.planned-item').filter({ hasText: title })).toHaveCount(0);
  expect(businessWrites, 'create, completion and hard delete use only the planned-work API').toEqual([
    'POST /api/planned-works',
    expect.stringMatching(/^POST \/api\/planned-works\/.+\/complete$/),
    expect.stringMatching(/^DELETE \/api\/planned-works\/.+$/)
  ]);
});

test('planned-maintenance UI: changing the day asks before discarding an edit', async ({ page }) => {
  await apiLogin(page, 'team-wireless');
  await page.goto('/requests?view=planned-maintenance');
  const title = `날짜 이동 초안 검사 ${randomUUID()}`;
  await page.getByLabel('작업 제목', { exact: true }).fill(title);
  await page.getByRole('button', { name: '작업 추가', exact: true }).click();
  const item = page.locator('.planned-item').filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '수정', exact: true }).click();
  const editTitle = page.locator('.planned-edit').getByLabel('작업 제목', { exact: true });
  await editTitle.fill(`${title} 수정 중`);
  const selectedDate = page.locator('.planned-date-panel input[type="date"]');
  const originalDate = await selectedDate.inputValue();

  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '다음 날짜', exact: true }).click();
  await expect(selectedDate).toHaveValue(originalDate);
  await expect(editTitle).toHaveValue(`${title} 수정 중`);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '다음 날짜', exact: true }).click();
  await expect(selectedDate).not.toHaveValue(originalDate);
  await expect(page.locator('.planned-edit')).toHaveCount(0);
  const remainingItem = page.locator('.planned-item').filter({ hasText: title });
  await expect(remainingItem).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await remainingItem.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.planned-item').filter({ hasText: title })).toHaveCount(0);
});

test('planned-maintenance UI: retry after SAVE_FAILED survives reload and another tab', async ({ page, context }) => {
  const operationIds: string[] = [];
  const secondOperationIds: string[] = [];
  let hideFirstResult = true;
  let hideSecondResult = true;
  let releaseFirstRequest!: () => void;
  let markFirstRequestStarted!: () => void;
  const firstRequestStarted = new Promise<void>(resolve => { markFirstRequestStarted = resolve; });
  const firstRequestGate = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
  await apiLogin(page, 'team-wireless');
  await page.route('**/api/planned-works', async route => {
    if (route.request().method() === 'POST') {
      operationIds.push((route.request().postDataJSON() as { operationId: string }).operationId);
      if (hideFirstResult) {
        hideFirstResult = false;
        markFirstRequestStarted();
        await firstRequestGate;
        const committed = await route.fetch();
        expect(committed.ok(), 'the first request must commit before its response is hidden').toBeTruthy();
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '처리를 확인하지 못했습니다. 같은 제출 번호로 다시 확인하세요.' }) });
        return;
      }
    }
    await route.continue();
  });
  await page.goto('/requests?view=planned-maintenance');
  const secondPage = await context.newPage();
  await secondPage.route('**/api/planned-works', async route => {
    if (route.request().method() === 'POST') {
      secondOperationIds.push((route.request().postDataJSON() as { operationId: string }).operationId);
      if (hideSecondResult) {
        hideSecondResult = false;
        const committed = await route.fetch();
        expect(committed.ok(), 'the second request must commit before its response is hidden').toBeTruthy();
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '처리를 확인하지 못했습니다. 같은 제출 번호로 다시 확인하세요.' }) });
        return;
      }
    }
    await route.continue();
  });
  await secondPage.goto('/requests?view=planned-maintenance');
  await expect(secondPage.getByLabel('작업 제목', { exact: true })).toHaveValue('');
  const secondTitle = `다중 탭 저장 검사 ${randomUUID()}`;
  const title = `저장 재시도 검사 ${randomUUID()}`;
  const titleInput = page.getByLabel('작업 제목', { exact: true });
  await titleInput.fill(title);
  await page.getByRole('button', { name: '작업 추가', exact: true }).click();
  const selectedDate = page.locator('.planned-date-panel input[type="date"]');
  await firstRequestStarted;
  try {
    await expect(titleInput).toBeDisabled();
    await expect(selectedDate).toBeDisabled();
    await expect(page.getByRole('button', { name: '다음 날짜', exact: true })).toBeDisabled();
  } finally {
    releaseFirstRequest();
  }
  await expect(page.getByRole('alert')).toContainText('같은 제출을 다시 확인하세요.');
  await expect(titleInput).toHaveValue(title);
  await expect(titleInput).toBeDisabled();
  await expect(selectedDate).toBeDisabled();
  await expect(page.getByRole('button', { name: '다음 날짜', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '전체 작업 현황', exact: true })).toBeDisabled();
  await navItem(page, '부서별 작업 현황');
  await expect(page).toHaveURL(/view=planned-maintenance/);
  await expect(page.getByText('저장 결과를 계획 화면에서 확인한 뒤 이동할 수 있습니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '같은 제출 재확인', exact: true })).toBeEnabled();
  await secondPage.getByLabel('작업 제목', { exact: true }).fill(secondTitle);
  await secondPage.getByRole('button', { name: '작업 추가', exact: true }).click();
  await expect(secondPage.getByRole('alert')).toContainText('같은 제출을 다시 확인하세요.');
  await expect(secondPage.getByLabel('작업 제목', { exact: true })).toHaveValue(secondTitle);
  await expect(secondPage.getByLabel('작업 제목', { exact: true })).toBeDisabled();
  const firstStoredPending = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')).map(key => sessionStorage.getItem(key) ?? '').join('\n'));
  const secondStoredPending = await secondPage.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')).map(key => sessionStorage.getItem(key) ?? '').join('\n'));
  expect(firstStoredPending).not.toContain(title);
  expect(secondStoredPending).not.toContain(secondTitle);
  expect(firstStoredPending).not.toContain('team-wireless');
  expect(secondStoredPending).not.toContain('team-wireless');
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')))).toHaveLength(1);
  await expect.poll(() => secondPage.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')))).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bnoc:planned-create:')))).toEqual([]);
  await secondPage.getByRole('button', { name: '같은 제출 재확인', exact: true }).click();
  await expect(secondPage.locator('.planned-item').filter({ hasText: secondTitle })).toBeVisible();
  expect(secondOperationIds).toHaveLength(2);
  expect(secondOperationIds[1]).toBe(secondOperationIds[0]);
  expect(secondOperationIds[0]).not.toBe(operationIds[0]);
  await expect.poll(() => secondPage.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')))).toEqual([]);
  const submittedDate = await selectedDate.inputValue();
  const firstItemInSecondTab = secondPage.locator('.planned-item').filter({ hasText: title });
  await expect(firstItemInSecondTab).toBeVisible();
  secondPage.once('dialog', dialog => dialog.accept());
  await firstItemInSecondTab.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(secondPage.locator('.planned-item').filter({ hasText: title })).toHaveCount(0);
  await page.reload();
  await expect(titleInput).toHaveValue('');
  await expect(selectedDate).toHaveValue(submittedDate);
  await expect(page.getByRole('alert')).toContainText('원래 작업 제목을 다시 입력하면');
  await expect(page.getByRole('button', { name: '같은 제출 재확인', exact: true })).toBeDisabled();
  await titleInput.fill(title);
  await expect(page.getByRole('button', { name: '같은 제출 재확인', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '같은 제출 재확인', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('같은 제출 번호를 다시 쓸 수 없습니다.');
  expect(operationIds).toHaveLength(2);
  expect(operationIds[1]).toBe(operationIds[0]);
  await page.getByRole('button', { name: '최신 목록 조회', exact: true }).click();
  const latestWorkList = page.getByRole('list', { name: '최신 작업 목록' });
  await expect(latestWorkList).toBeVisible();
  await expect(latestWorkList.getByText(title, { exact: true })).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '목록 확인 후 새 제출 시작', exact: true }).click();
  await expect(page.getByRole('button', { name: '작업 추가', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '작업 추가', exact: true }).click();
  await expect(page.locator('.planned-item').filter({ hasText: title })).toBeVisible();
  expect(operationIds).toHaveLength(3);
  expect(operationIds[2]).not.toBe(operationIds[0]);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bnoc:planned-create:')))).toEqual([]);
  await page.unroute('**/api/planned-works');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.planned-item').filter({ hasText: title }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.planned-item').filter({ hasText: title })).toHaveCount(0);

  secondPage.once('dialog', dialog => dialog.accept());
  await secondPage.locator('.planned-item').filter({ hasText: secondTitle }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(secondPage.locator('.planned-item').filter({ hasText: secondTitle })).toHaveCount(0);
  await secondPage.close();
});

test('planned-maintenance UI: clears a submission rejected after an account or team change', async ({ page }) => {
  await apiLogin(page, 'team-wireless');
  await page.route('**/api/planned-works', async route => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'OPERATION_NOT_AVAILABLE', message: '현재 계정 또는 작업반에서 확인할 수 없는 제출입니다. 작업 목록을 확인하세요.' }) });
      return;
    }
    await route.continue();
  });
  await page.goto('/requests?view=planned-maintenance');
  await page.getByLabel('작업 제목', { exact: true }).fill(`계정 전환 제출 검사 ${randomUUID()}`);
  await page.getByRole('button', { name: '작업 추가', exact: true }).click();
  await expect(page.getByLabel('작업 제목', { exact: true })).toHaveValue('');
  await expect(page.getByText('현재 계정 또는 작업반에서 확인할 수 없는 제출입니다. 작업 목록을 확인하고 새 작업은 제목을 다시 입력하세요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 조회', exact: true })).toHaveCount(0);
});

test('shared DateInput: existing screens use the same native date control without extra calendar buttons', async ({ page }) => {
  const businessWrites: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      businessWrites.push(`${request.method()} ${pathname}`);
    }
  });
  await apiLogin(page, 'team-wireless');
  for (const route of ['/schedule', '/personnel']) {
    await page.goto(route);
    const dates = page.locator('input[type="date"]');
    await expect(dates.first()).toBeVisible();
    expect(await dates.evaluateAll(inputs => inputs.every(input => input.classList.contains('ui-date-input'))), `${route} must use the shared DateInput`).toBeTruthy();
    expect(await dates.evaluateAll(inputs => inputs.every(input => parseFloat(getComputedStyle(input).minHeight) >= 44)), `${route} shared date controls must meet the 44px minimum`).toBeTruthy();
    await expect(page.locator('input[type="date"] + button')).toHaveCount(0);
  }
  await page.goto('/night-duty');
  await expect(page.getByRole('heading',{name:'당직 야간근무 현황'})).toBeVisible();
  const dutyDate=page.locator('input[type="date"]');await expect(dutyDate).toBeVisible();
  expect(await dutyDate.evaluate(input=>parseFloat(getComputedStyle(input).minHeight)>=44)).toBeTruthy();
  await page.getByRole('button',{name:'월',exact:true}).click();
  const month=page.locator('input[type="month"]');await expect(month).toBeVisible();
  expect(await month.evaluate(input=>parseFloat(getComputedStyle(input).minHeight)>=44)).toBeTruthy();
  await expect(page.locator('input[type="date"] + button')).toHaveCount(0);
  await apiLogin(page, 'bnoc');
  for (const route of ['/overview', '/requests']) {
    await page.goto(route);
    await page.getByText('상세 조회 조건', { exact: true }).click();
    const dates = page.locator('input[type="date"]');
    await expect(dates.first()).toBeVisible();
    expect(await dates.evaluateAll(inputs => inputs.length > 0 && inputs.every(input => input.classList.contains('ui-date-input'))), `${route} must use the shared DateInput`).toBeTruthy();
    expect(await dates.evaluateAll(inputs => inputs.length > 0 && inputs.every(input => parseFloat(getComputedStyle(input).minHeight) >= 44)), `${route} shared date controls must meet the 44px minimum`).toBeTruthy();
    await expect(page.locator('input[type="date"] + button')).toHaveCount(0);
  }
  expect(businessWrites, 'date selection does not write business state').toEqual([]);
});


test('FR-052: fixed duty slots keep empty positions and battalion B saves without changing legacy A',async({page},info)=>{
  const suffix=randomUUID().slice(0,8),year=2000+parseInt(suffix.slice(0,4),16)%7000,month=`${year}-${String(1+parseInt(suffix.slice(4),16)%12).padStart(2,'0')}`,date=`${month}-10`;
  await apiLogin(page,'bnoc');
  const names=[`합성 A ${suffix}`,`합성 B ${suffix}`];
  const refs:string[]=[];
  for(const displayName of names){const directory=(await apiRead(page,'/api/personnel-roster')).data;const saved=await command(page,'saveCentralPerson',{department:wire,category:'간부',rank:'대위',displayName,serviceNumber:`QA-${randomUUID()}`,internalPhone:'7654',active:true},{expectedRevision:directory.revision});refs.push(saved.publicRef);}
  const aCommand={month,date,seat:'communications_battalion_day_officer',personRefs:[refs[0]]};
  await command(page,'saveDutySchedule',aCommand,{expectedRevision:0});
  const aBefore=(await apiRead(page,`/api/duty-schedules?month=${month}&seat=communications_battalion_day_officer`)).data.entries;
  const openDate=async()=>{await page.goto('/night-duty');await page.getByRole('button',{name:'월',exact:true}).click();await page.getByLabel('대상 월').fill(month);await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:new RegExp(`^${date} 근무자 보기`)}).click();};
  await openDate();
  const board=page.locator('.duty-officer-board');
  for(const seat of ['당직사관','A대대 일직사관','B대대 일직사관'])await expect(board.getByRole('region',{name:seat,exact:true})).toBeVisible();
  await expect(board.getByRole('region',{name:'A대대 일직사관',exact:true})).toContainText(names[0]);
  await expect(board.getByRole('region',{name:'B대대 일직사관',exact:true}).getByLabel('미편성',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'근무 자리',exact:true}).selectOption('B대대 일직사관');
  await page.getByRole('searchbox',{name:'근무자 검색',exact:true}).fill(names[1]);
  await page.getByRole('checkbox',{name:new RegExp(names[1])}).check();
  await page.locator('.duty-save').click();
  await expect(page.locator('.duty-feedback')).toContainText('저장');
  await expect(board.getByRole('region',{name:'B대대 일직사관',exact:true})).toContainText(names[1]);
  expect((await apiRead(page,`/api/duty-schedules?month=${month}&seat=communications_battalion_day_officer`)).data.entries).toEqual(aBefore);
  const b=(await apiRead(page,`/api/duty-schedules?month=${month}&seat=battalion_b_day_officer`)).data.entries.find((entry:{date:string})=>entry.date===date);expect(b.people[0].personRef).toBe(refs[1]);
  await screenshot(page,info,'duty-battalion-slots');await noOverflow(page);
  await apiLogin(page,'requester');await openDate();
  await expect(page.locator('.duty-editor')).toHaveCount(0);await expect(board.getByRole('region',{name:'A대대 일직사관',exact:true})).toContainText(names[0]);await expect(board.getByRole('region',{name:'B대대 일직사관',exact:true})).toContainText(names[1]);
  for(const entry of (await apiRead(page,`/api/duty-schedules?month=${month}`)).data.entries)for(const person of entry.people)expect(Object.keys(person).sort()).toEqual(['displayName','rank']);
});
