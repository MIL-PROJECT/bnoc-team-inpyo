import { setTestSession, teamIds, teamSubjects } from './survey-test-session.mjs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const root=resolve(process.env.BNOC_PROJECT_ROOT??process.cwd());
const require=createRequire(join(root,'package.json'));
const {chromium,firefox,expect}=require('@playwright/test');
const base=process.env.BNOC_PREVIEW_URL??'http://127.0.0.1:5173';
const evidence=join(root,'runtime/evidence/survey-enhancements-20261022');
await mkdir(evidence,{recursive:true});
const results=[];const begin=new Date().toISOString();
const resultName=process.env.BNOC_RESULT_NAME??'ui-verifier-results.json';
const url=path=>base+path+(path.includes('?')?'&':'?')+'preview=survey';

async function login(page,role='requester',path='/requests'){await setTestSession(page,role);await page.goto(url(path));await expect(page.getByRole('button',{name:'로그아웃',exact:true})).toBeVisible();}
async function overflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PC_DOCUMENT_MUST_NOT_OVERFLOW').toBeTruthy();}
async function shot(page,name){await overflow(page);await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});}
const cases={
async status(page,prefix){
 await login(page);await expect(page.getByRole('button',{name:/요청 105/})).toHaveCount(0);
 const badge=page.getByRole('button',{name:'작업 중',exact:true});await badge.hover();
 const tooltip=page.getByRole('tooltip');await expect(tooltip).toContainText('무선반');await expect(tooltip).toContainText('유선반');await expect(tooltip.getByText('대표번호 미등록',{exact:true})).toHaveCount(2);
 await expect(tooltip.locator('.survey-process')).toHaveCount(0);
 const hoverText=await tooltip.innerText();let bounds=await tooltip.boundingBox();expect(bounds.x>=0&&bounds.x+bounds.width<=page.viewportSize().width).toBeTruthy();
 await tooltip.hover();await expect(tooltip).toBeVisible();await shot(page,prefix+'-hover');
 await badge.focus();expect(await tooltip.innerText()).toBe(hoverText);await page.keyboard.press('Escape');await expect(tooltip).toHaveCount(0);await expect(badge).toBeFocused();
 await page.getByLabel('내용·문서 검색').focus();
 await badge.evaluate(button=>{button.closest('.survey-status').style.cssText='position:fixed;right:16px;bottom:16px;z-index:1';});
 await badge.hover();await expect(tooltip).toBeVisible();bounds=await tooltip.boundingBox();const anchor=await badge.boundingBox();expect(bounds.y+bounds.height<=anchor.y,'STATUS_POPOVER_FLIPS_ABOVE_BOTTOM_EDGE').toBeTruthy();expect(bounds.x>=16&&bounds.x+bounds.width<=page.viewportSize().width-15,'STATUS_POPOVER_STAYS_WITHIN_RIGHT_EDGE').toBeTruthy();
 await page.screenshot({path:join(evidence,prefix+'-edge.png')});await page.keyboard.press('Escape');await badge.evaluate(button=>button.closest('.survey-status').removeAttribute('style'));
 await page.getByRole('button',{name:/요청 101 ·/}).click();const process=page.getByRole('region',{name:'전체 처리 흐름'});await expect(process).toBeVisible();await expect(process.locator('[aria-current="step"]')).toHaveText(/작업 중.*현재/);await expect(process.locator('.survey-step-number')).toHaveText(['1','2','3','4']);await expect(process.getByRole('heading',{name:'처리 현황',exact:true})).toBeVisible();await expect(process.getByText('작업 중',{exact:true})).toHaveCount(1);await expect(process.locator('p,dl')).toHaveCount(0);await shot(page,prefix+'-status-detail');
 await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.getByRole('button',{name:/요청 102 ·/}).click();await expect(process).toContainText('문서 대기');await expect(process.getByRole('list')).toHaveCount(0);await expect(process.locator('[aria-current="step"]')).toHaveCount(0);await shot(page,prefix+'-document-wait');
 await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.getByRole('button',{name:/요청 103 ·/}).click();await expect(process).toContainText('이미 끝낸 작업');await expect(process.getByRole('list')).toHaveCount(0);await expect(process.locator('[aria-current="step"]')).toHaveCount(0);await shot(page,prefix+'-after-action');
 await page.getByRole('button',{name:'목록으로',exact:true}).click();const afterActionRow=page.getByRole('row').filter({has:page.getByRole('button',{name:/요청 103 ·/})});const afterActionBadge=afterActionRow.getByRole('button',{name:'완료',exact:true});await afterActionBadge.hover();const afterActionTooltip=page.getByRole('tooltip');await expect(afterActionTooltip).toContainText('수행 부서');await expect(afterActionTooltip).toContainText('무선반');await expect(afterActionTooltip).toContainText('대표번호 미등록');
},
async search(page,prefix){
 await login(page);const query=page.getByLabel('내용·문서 검색');await query.fill('마이크');await expect(page.getByRole('status')).toHaveText('검색 결과 5건');await query.press('Enter');await expect(page.getByRole('status')).toHaveText('검색 결과 1건 · 검색어: 마이크');await expect(page.getByRole('button',{name:/요청 101 ·/})).toHaveCount(1);
 await page.getByLabel('상태').selectOption('완료');await page.getByRole('button',{name:'검색',exact:true}).click();await expect(page.getByRole('status')).toHaveText('검색 결과 0건 · 검색어: 마이크');await page.getByRole('button',{name:'초기화',exact:true}).click();await query.fill('정기회의');await query.press('Enter');await expect(page.getByRole('status')).toHaveText('검색 결과 2건 · 검색어: 정기회의');await expect(page.getByRole('region',{name:'신청 결과'})).toContainText('문서 정보');await shot(page,prefix+'-search');const hit=page.getByRole('button',{name:/문서 정보 · 회의지원.hwp · 일치 부분 보기/}).first();await hit.click();await expect(page.locator('#document-b2')).toBeFocused();await page.keyboard.press('Escape');await expect(hit).toBeFocused();
 await query.fill('%');await query.press('Enter');await expect(page.getByRole('status')).toContainText('검색 결과 0건');await query.fill('범위 밖');await query.press('Enter');await expect(page.getByRole('status')).toContainText('검색 결과 0건');await page.getByRole('button',{name:'초기화',exact:true}).click();await page.getByText('상세 조회 조건',{exact:true}).click();await page.getByLabel('위치',{exact:true}).fill('가'.repeat(100));await page.getByRole('button',{name:'검색',exact:true}).click();await overflow(page);
},
async documents(page,prefix){
 await login(page,'requester','/requests/101');const open=page.getByRole('button',{name:'회의지원.hwp · 문서 보기',exact:true});await open.click();await expect(page.getByRole('dialog')).toContainText('후보 2개');const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'원본 다운로드',exact:true}).click();const downloaded=await downloading;expect(downloaded.suggestedFilename()).toBe('회의지원.hwp');const bytes=await readFile(await downloaded.path());expect(bytes.subarray(0,8).toString('hex'),'HWP_ORIGINAL_DOWNLOAD_IS_BINARY_HWP').toBe('d0cf11e0a1b11ae1');await expect(page.getByRole('dialog').getByRole('button',{name:'다시 분석 요청',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'원문 근거 보기 · 6번째 문단',exact:true}).click();await expect(page.locator('#document-b6')).toBeFocused();await expect(page.locator('#document-b6')).toHaveClass('survey-source-highlight');const closeBounds=await page.getByRole('button',{name:'닫기',exact:true}).boundingBox();expect(closeBounds.y>=0&&closeBounds.y+closeBounds.height<=page.viewportSize().height,'DOCUMENT_HEADER_MUST_REMAIN_VISIBLE_AFTER_SOURCE_JUMP').toBeTruthy();await shot(page,prefix+'-document-metadata');await page.keyboard.press('Escape');await expect(open).toBeFocused();
 await page.getByRole('button',{name:'Equipment-support.pdf · 문서 보기',exact:true}).click();await page.getByRole('button',{name:'원본 보기',exact:true}).click();await expect(page.getByTitle('원본 PDF')).toBeVisible();const src=await page.getByTitle('원본 PDF').getAttribute('src');expect(src).toMatch(/^blob:/);expect(await page.evaluate(async src=>(await (await fetch(src)).text()).startsWith('%PDF-1.4'),src)).toBeTruthy();await shot(page,prefix+'-document-pdf');await page.getByRole('button',{name:'닫기',exact:true}).click();
},
async documentStates(page,prefix){
 await login(page,'requester','/requests/102');await page.getByRole('button',{name:'분석중.hwp · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('분석 중');await expect(page.getByRole('dialog')).toContainText('요청 등록과 작업 진행은 계속할 수 있습니다');await page.keyboard.press('Escape');await page.getByRole('button',{name:'일부추출.hwp · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('추출된 일부 내용만 표시합니다');await shot(page,prefix+'-document-partial');await page.keyboard.press('Escape');await page.getByRole('button',{name:'분석실패.hwp · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('분석 실패');await page.getByRole('button',{name:'다시 분석 요청',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('분석 대기');await page.keyboard.press('Escape');await page.getByRole('button',{name:'읽기불가.hwp · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('암호화·손상');await page.keyboard.press('Escape');await page.getByRole('button',{name:'텍스트없음.hwp · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('추출할 텍스트를 찾지 못했습니다');await page.keyboard.press('Escape');
},
async form(page,prefix){
 await login(page,'requester','/new');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.locator('[name="detail"]')).toBeFocused();
 await page.locator('[name="detail"]').fill('전화 연결 불가');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');await page.locator('[name="systemType"]').selectOption('인트라넷');await page.locator('[name="resourceType"]').selectOption('전화');await page.locator('[name="workType"]').selectOption('고장');
 await expect(page.getByRole('button',{name:'대상 추가',exact:true})).toHaveCount(0);await expect(page.locator('[name^="items."]')).toHaveCount(0);await shot(page,prefix+'-request-form');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'고장 요청',exact:true})).toBeVisible();await expect(page.getByRole('main')).toContainText('전화 연결 불가');await expect(page.getByText('요청 분류: 장비/체계 · 인트라넷 · 전화 · 고장')).toBeVisible();await page.getByRole('button',{name:'신청 수정',exact:true}).click();await expect(page.locator('[name="detail"]')).toHaveValue('전화 연결 불가');
},
async meetingLegacy(page,prefix){
 await login(page,'requester','/new');await page.locator('[name="category"]').selectOption('회의 지원');await page.locator('[name="meetingType"]').selectOption('일반회의');await page.locator('[name="detail"]').fill('음향 연결');await page.locator('[name="location"]').fill('회의실');await page.locator('[name="contact"]').fill('000-0000');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('main')).toContainText('음향 연결');
 await page.getByRole('button',{name:'신청 수정',exact:true}).click();await expect(page.locator('[name="detail"]')).toHaveValue('음향 연결');await page.getByRole('button',{name:'변경 저장',exact:true}).click();await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.getByRole('button',{name:/요청 102 ·/}).click();await page.getByRole('button',{name:'신청 수정',exact:true}).click();await expect(page.locator('[name="detail"]')).toHaveValue('첨부 문서 처리 상태를 확인합니다.');await page.locator('[name="detail"]').fill('기존 요청 검증');await page.getByRole('button',{name:'변경 저장',exact:true}).click();await expect(page.getByRole('main')).toContainText('기존 요청 검증');await shot(page,prefix+'-legacy-detail');
},
async teamManagement(page,prefix){
 await login(page,'team','/roster');await expect(page.getByRole('main')).not.toContainText('지정 담당');await page.getByLabel('명부 인원 성명').fill('검증 항목');await page.getByRole('button',{name:'명부에 추가',exact:true}).click();await page.getByRole('button',{name:'변경 저장',exact:true}).click();await expect(page.getByRole('status')).toContainText('무선반 명부를 저장했습니다');await page.getByRole('button',{name:'병력 현황',exact:true}).click();await page.getByLabel('검증 항목 병력 상태').selectOption('available');await page.getByRole('button',{name:'변경 저장',exact:true}).click();await page.getByRole('button',{name:'야간 근무',exact:true}).click();await page.getByRole('main').getByLabel('야간 근무',{exact:true}).check();await page.getByRole('button',{name:'변경 저장',exact:true}).click();await shot(page,prefix+'-team-night');await page.getByLabel('조회 부서').selectOption('유선반');await expect(page.getByRole('button',{name:'변경 저장',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'로그아웃',exact:true}).click();await login(page,'bnoc');await page.getByRole('button',{name:'부서 명부',exact:true}).click();await expect(page.getByRole('button',{name:'변경 저장',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'명부에 추가',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'로그아웃',exact:true}).click();await login(page,'admin');await page.getByRole('button',{name:'권한 관리',exact:true}).click();await expect(page.getByRole('main')).not.toContainText('지정 담당');await expect(page.getByRole('main')).not.toContainText('departmentManager');await expect(page.getByRole('heading',{name:'서비스 권한 관리',exact:true})).toBeVisible();for(const team of teamIds)await expect(page.getByRole('cell',{name:team,exact:true}).first()).toBeVisible();await shot(page,prefix+'-access');
},
async navigation(page,prefix){
 await login(page,'requester','/requests/101');await expect(page.getByRole('heading',{name:'회의실 마이크 연결 지원',exact:true})).toBeVisible();await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.goBack();await expect(page.getByRole('heading',{name:'회의실 마이크 연결 지원',exact:true})).toBeVisible();expect(new URL(page.url()).searchParams.get('preview')).toBe('survey');await page.reload();await expect(page.getByRole('heading',{name:'회의실 마이크 연결 지원',exact:true})).toBeVisible();await page.goto(url('/requests/105'));await expect(page.getByRole('heading',{name:'신청을 조회할 수 없습니다',exact:true})).toBeVisible();await page.goto(url('/roster'));await expect(page.getByRole('alert')).toContainText('현재 역할로 조회할 수 없습니다');await shot(page,prefix+'-requester-forbidden');
}
};

cases.afterAction=async(page,prefix)=>{
 await login(page,'team','/after-action');await expect(page.locator('[name="preference1Date"]')).toHaveCount(0);await page.locator('[name="detail"]').fill('조치한 전화 증상');await page.locator('[name="systemType"]').selectOption('인트라넷');await page.locator('[name="resourceType"]').selectOption('전화');await page.locator('[name="workType"]').selectOption('고장');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');await page.locator('[name="actualRequesterText"]').fill('검증 요청');await page.locator('[name="actualStartedAt"]').fill('2026-10-22T09:00');await page.locator('[name="completedAt"]').fill('2026-10-22T10:00');await page.locator('[name="reason"]').fill('선조치 후 보고');await page.getByRole('button',{name:'완료 후보고 등록',exact:true}).click();await expect(page.locator('[name="completionConfirmed"]')).toBeFocused();await page.locator('[name="completionConfirmed"]').check();await page.getByRole('button',{name:'완료 후보고 등록',exact:true}).click();await expect(page.getByRole('region',{name:'전체 처리 흐름'})).toContainText('이미 끝낸 작업');await expect(page.locator('[aria-current="step"]')).toHaveCount(0);await shot(page,prefix+'-after-action');
};
cases.bnocForm=async(page,prefix)=>{
 await login(page,'bnoc','/new');await page.locator('[name="detail"]').fill('점검 요청');await page.locator('[name="systemType"]').selectOption('인트라넷');await page.locator('[name="resourceType"]').selectOption('PC');await page.locator('[name="workType"]').selectOption('고장');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.locator('[name="requesterDisplayText"]')).toBeFocused();await page.locator('[name="requesterDisplayText"]').fill('검증 요청');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'고장 요청',exact:true})).toBeVisible();await shot(page,prefix+'-bnoc-intake');
};
cases.attachmentValidation=async(page,prefix)=>{
 await login(page,'requester','/new');await page.locator('[name="systemType"]').selectOption('AFCCS');await page.locator('[name="resourceType"]').selectOption('PC');await page.locator('[name="workType"]').selectOption('지원');await page.locator('[name="detail"]').fill('화면 오류 지원');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');await page.getByText('선택 정보',{exact:true}).click();await page.locator('[name="files"]').setInputFiles({name:'검증.exe',mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.locator('[name="files"]')).toBeFocused();await expect(page.getByRole('main')).toContainText('첨부는 허용 형식');await page.locator('[name="files"]').setInputFiles({name:'검증.txt',mimeType:'text/plain',buffer:Buffer.from('검증 문서')});await page.getByRole('button',{name:'신청 등록',exact:true}).click();await page.getByRole('button',{name:'검증.txt · 문서 보기',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('분석 대기');await shot(page,prefix+'-uploaded-document');
};


cases.memoryAndForward=async(page,prefix)=>{
 await login(page,'requester','/new');await page.locator('[name="systemType"]').selectOption('인트라넷');await page.locator('[name="resourceType"]').selectOption('PC');await page.locator('[name="workType"]').selectOption('고장');await page.locator('[name="detail"]').fill('화면 오류');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('heading',{name:'고장 요청',exact:true})).toBeVisible();expect(new URL(page.url()).pathname).toBe('/requests/107');await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.goBack();await expect(page.getByRole('heading',{name:'고장 요청',exact:true})).toBeVisible();await page.goForward();await expect(page.getByRole('heading',{name:'신청 목록',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/요청 107 ·/})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:/요청 107 ·/})).toHaveCount(0);await expect(page.getByRole('button',{name:/요청 105 ·/})).toHaveCount(0);await page.getByRole('button',{name:'로그아웃',exact:true}).click();await login(page,'bnoc');await expect(page.getByRole('button',{name:/요청 105 ·/})).toBeVisible();expect(new URL(page.url()).searchParams.get('preview')).toBe('survey');await shot(page,prefix+'-memory-reset');
};

cases.resourceRemoval=async(page,prefix)=>{
 for(const role of ['requester','bnoc','team','admin']){
  await login(page,role);await expect(page.getByRole('button',{name:'자원 현황',exact:true}),'RESOURCE_MENU_REMOVED').toHaveCount(0);
  if(role==='requester'||role==='bnoc'){await page.getByRole('button',{name:role==='bnoc'?'대리 등록':'작업 신청',exact:true}).click();await expect(page.getByRole('button',{name:'자원 현황 보기',exact:true})).toHaveCount(0);await expect(page.locator('[name="resourceType"]')).toBeVisible();}
  if(role==='team'){await page.getByRole('button',{name:'선조치 후보고',exact:true}).click();await expect(page.getByRole('button',{name:'자원 현황 보기',exact:true})).toHaveCount(0);await expect(page.locator('[name="resourceType"]')).toBeVisible();}
 }
 await login(page,'team','/resources');await expect(page.getByRole('heading',{name:'페이지를 찾을 수 없습니다',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'자원 등록',exact:true})).toHaveCount(0);await shot(page,prefix+'-removed-route');
};

cases.originalLogin=async(page,prefix)=>{
 await setTestSession(page,null);await page.goto(url('/requests'));await expect(page.getByRole('button',{name:'SSO 로그인',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'작업반으로 로그인',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'요청자로 로그인',exact:true})).toHaveCount(0);await shot(page,prefix+'-original-login');
};
cases.originalTeams=async(page,prefix)=>{
 for(const subject of teamSubjects){await login(page,subject,'/roster');await expect(page.getByLabel('조회 부서')).toHaveValue(teamIds[teamSubjects.indexOf(subject)]);for(const target of teamIds){await page.getByLabel('조회 부서').selectOption(target);await expect(page.getByRole('button',{name:'명부에 추가',exact:true})).toHaveCount(target===teamIds[teamSubjects.indexOf(subject)]?1:0);}await page.getByRole('button',{name:'로그아웃',exact:true}).click();await expect(page.getByRole('button',{name:'SSO 로그인',exact:true})).toBeVisible();}await shot(page,prefix+'-original-teams');
};

cases.schedulePreferences=async(page,prefix)=>{
 await login(page,'requester','/new');
 await page.locator('[name="systemType"]').selectOption('인트라넷');await page.locator('[name="resourceType"]').selectOption('PC');await page.locator('[name="workType"]').selectOption('고장');await page.locator('[name="detail"]').fill('화면 점검');await page.locator('[name="location"]').fill('검증 위치');await page.locator('[name="contact"]').fill('000-0000');
 await page.getByText('선택 정보',{exact:true}).click();await page.getByLabel('2지망 날짜',{exact:true}).fill('2026-10-26');await page.getByLabel('2지망 오전·오후',{exact:true}).selectOption('PM');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByLabel('1지망 날짜',{exact:true})).toBeFocused();await expect(page.getByLabel('1지망 날짜',{exact:true})).toHaveAttribute('aria-invalid','true');await expect(page.getByLabel('1지망 날짜',{exact:true})).toHaveAccessibleDescription('2지망은 1지망과 함께 입력하세요.');await expect(page.getByRole('main')).toContainText('2지망은 1지망과 함께 입력하세요.');
 await page.getByLabel('1지망 날짜',{exact:true}).fill('2026-10-25');await page.getByLabel('1지망 오전·오후',{exact:true}).selectOption('AM');await page.getByRole('button',{name:'신청 등록',exact:true}).click();await expect(page.getByRole('main')).toContainText('1지망: 2026-10-25 오전');await expect(page.getByRole('main')).toContainText('2지망: 2026-10-26 오후');
 await page.getByRole('button',{name:'신청 수정',exact:true}).click();await page.getByText('선택 정보',{exact:true}).click();await expect(page.getByLabel('1지망 날짜',{exact:true})).toHaveValue('2026-10-25');await expect(page.getByLabel('2지망 오전·오후',{exact:true})).toHaveValue('PM');await shot(page,prefix+'-preferences');
 await login(page,'requester','/requests/102');await page.getByRole('button',{name:'신청 수정',exact:true}).click();await page.getByText('선택 정보',{exact:true}).click();await page.getByLabel('2지망 날짜',{exact:true}).fill('2026-10-26');await page.getByLabel('2지망 오전·오후',{exact:true}).selectOption('PM');await page.getByRole('button',{name:'변경 저장',exact:true}).click();await expect(page.getByLabel('1지망 날짜',{exact:true})).toBeFocused();
};


cases.noExpandedRequestFields=async(page,prefix)=>{
 await login(page,'requester','/new');await expect(page.locator('[name="category"]')).toBeVisible();await expect(page.locator('[name="systemType"]')).toBeVisible();await expect(page.locator('[name="resourceType"]')).toBeVisible();await expect(page.locator('[name="workType"]')).toBeVisible();await expect(page.locator('[name="detail"]')).toBeVisible();await expect(page.getByRole('button',{name:'대상 추가',exact:true})).toHaveCount(0);await expect(page.locator('[name^="items."]')).toHaveCount(0);await shot(page,prefix+'-existing-form-fields');
};
cases.workStatusGuidance=async(page,prefix)=>{
 await login(page,'team','/requests');
 const row=page.getByRole('row').filter({has:page.getByRole('button',{name:/요청 101 ·/})});
 const requestBadge=row.getByRole('button',{name:'작업 중',exact:true});
 const workBadge=row.getByRole('button',{name:'작업 준비',exact:true});
 await requestBadge.hover();const requestTooltip=page.getByRole('tooltip');await expect(requestTooltip).toContainText('무선반');await expect(requestTooltip).toContainText('유선반');await expect(requestTooltip.getByText('대표번호 미등록',{exact:true})).toHaveCount(2);
 await page.keyboard.press('Escape');await workBadge.hover();
 const workTooltip=page.getByRole('tooltip');await expect(workTooltip).toContainText('무선반');await expect(workTooltip).not.toContainText('유선반');await expect(workTooltip.getByText('대표번호 미등록',{exact:true})).toHaveCount(1);
 await page.keyboard.press('Escape');await row.getByRole('button',{name:/요청 101 ·/}).click();
 await expect(page.getByRole('region',{name:'전체 처리 흐름'}).getByRole('listitem')).toHaveCount(4);
 await expect(page.getByRole('region',{name:'우리 반 작업 흐름'}).getByRole('listitem')).toHaveCount(3);
 await expect(page.getByRole('region',{name:'우리 반 작업 흐름'})).toContainText('작업 준비');
 await shot(page,prefix+'-detail');
 await login(page,'team-wired','/requests');
 const wiredRow=page.getByRole('row').filter({has:page.getByRole('button',{name:/요청 101 ·/})});
 await expect(wiredRow.getByRole('button',{name:'작업 중',exact:true})).toBeVisible();
 const wiredWorkBadge=wiredRow.getByRole('button',{name:'배정',exact:true});await expect(wiredWorkBadge).toBeVisible();
 await wiredWorkBadge.hover();const wiredWorkTooltip=page.getByRole('tooltip');await expect(wiredWorkTooltip).toContainText('유선반');await expect(wiredWorkTooltip).not.toContainText('무선반');await expect(wiredWorkTooltip.getByText('대표번호 미등록',{exact:true})).toHaveCount(1);
 await page.keyboard.press('Escape');await wiredRow.getByRole('button',{name:/요청 101 ·/}).click();
 await expect(page.getByRole('region',{name:'전체 처리 흐름'})).toContainText('작업 중');
 await expect(page.getByRole('region',{name:'우리 반 작업 흐름'})).toContainText('배정');
 await expect(page.getByRole('group',{name:'다른 부서 진행'})).toContainText('무선반');
 await expect(page.getByRole('group',{name:'다른 부서 진행'})).not.toContainText('유선반');
 await page.getByRole('button',{name:'목록으로'}).click();
 await page.getByLabel('작업반').selectOption('유선반');await page.getByRole('button',{name:'검색',exact:true}).click();
 await expect(page.getByRole('row').filter({has:page.getByRole('button',{name:/요청 101 ·/})})).toBeVisible();
 await shot(page,prefix+'-wired');
};
cases.serverDetailProvenance=async(page,prefix)=>{
 await setTestSession(page,'bnoc');
 const envelope=data=>({data,queriedAt:new Date().toISOString()});
 const item=number=>({requestNumber:number,workNumber:number+'-1',source:'assigned',teamId:'무선반',status:'작업 중',category:'장비/체계',workType:'고장',canOpenDetail:true,scheduleIntervals:[],requesterContact:'000-0000'});
 const detail=number=>({requestNumber:number,registeredAt:'2026-10-23T00:00:00Z',revision:1,status:'작업 중',category:'장비/체계',requesterDisplayText:'요청자',location:'검증 위치',contact:'000-0000',detail:'서버 상세 '+number,schedulePreferences:[],attachments:[],workItems:[],canEdit:false,canCancel:false,canAssign:false});
 await page.route(url=>url.pathname.startsWith('/api/'),route=>{
  const path=new URL(route.request().url()).pathname;
  const data=path==='/api/work-overview'?{counts:{assigned:2},items:[item('101'),item('901')],byDepartment:[],total:2}
   :path==='/api/overview'?{total:2,byStatus:{'작업 중':2},list:['101','901'].map(requestNumber=>({requestNumber,requesterDisplayText:'요청자',status:'작업 중'}))}
   :path==='/api/schedule'?{entries:[],completedRecords:[],unscheduled:['101','901'].map(number=>({...item(number),request:{requestNumber:number},location:'검증 위치'}))}
   :path==='/api/notifications'?{items:['101','901'].map(number=>({notificationId:'n'+number,event:'작업 알림',relatedRequestId:number,read:true,at:'2026-10-23T00:00:00Z'})),total:2}
   :/^\/api\/requests\/(101|901)$/.test(path)?detail(path.split('/').at(-1))
   :/^\/api\/requests\/(101|901)\/history$/.test(path)?{items:[],total:0}:null;
  return data?route.fulfill({json:envelope(data)}):route.fallback();
 });
 for(const source of ['schedule','overview','operations','notifications'])for(const number of ['101','901']){
  await page.goto(url('/'+source));await expect(page.getByRole('button',{name:'로그아웃',exact:true})).toBeVisible();
  if(source==='schedule'){await page.getByText('일정 미정',{exact:false}).first().click();await page.getByRole('button',{name:new RegExp('작업번호: '+number+'-1')}).click();}
  else if(source==='overview')await page.getByRole('button',{name:new RegExp('^'+number+' · 요청자')}).click();
  else await page.getByRole('button',{name:source==='operations'?number+'-1':number,exact:true}).click();
  await expect(page.getByRole('heading',{name:'신청 상세',exact:true})).toBeVisible();expect(new URL(page.url()).pathname,'SERVER_REQUEST_NUMBER_PRESERVED').toBe('/requests/'+number);expect(new URL(page.url()).searchParams.has('preview'),'SERVER_DETAIL_MUST_NOT_OPEN_MEMORY_FIXTURE').toBeFalsy();await expect(page.getByRole('main')).toContainText('서버 상세 '+number);await overflow(page);
 }
 await page.reload();await expect(page.getByRole('main')).toContainText('서버 상세 901');await shot(page,prefix+'-server-detail');
};

const names=(process.env.BNOC_CASES??Object.keys(cases).join(',')).split(',');
for(const [browserName,engine] of [['chromium',chromium],['firefox',firefox]]){
 if(process.env.BNOC_BROWSERS&&!process.env.BNOC_BROWSERS.split(',').includes(browserName))continue;
 let browser;try{browser=await engine.launch({headless:true});}catch(error){results.push({browserName,status:'not_run',error:String(error)});continue;}
 for(const width of [1280,1440])for(const name of names){
  const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});const page=await context.newPage();page.setDefaultTimeout(6000);
  const api=[],outside=[],errors=[];page.on('request',request=>{const u=new URL(request.url());if(/^\/(api|identity)(\/|$)/.test(u.pathname))api.push({method:request.method(),path:u.pathname});if(u.protocol.startsWith('http')&&u.origin!==new URL(base).origin)outside.push(u.origin);});page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const started=new Date().toISOString();let failure;
  try{await cases[name](page,`${browserName}-${width}-${name}`);await overflow(page);expect(api.filter(request=>request.method!=='GET'&&!['/api/auth/logout'].includes(request.path)),'PREVIEW_MUST_NOT_WRITE_BUSINESS_API').toEqual([]);expect(outside,'PREVIEW_MUST_NOT_CALL_EXTERNAL_ORIGIN').toEqual([]);expect(errors,'PREVIEW_MUST_NOT_THROW_PAGEERROR').toEqual([]);}catch(error){failure=String(error);await page.screenshot({path:join(evidence,`${browserName}-${width}-${name}-failure.png`),fullPage:true}).catch(()=>{});}
  results.push({browserName,width,name,status:failure?'failed':'passed',started,ended:new Date().toISOString(),api,outside,errors,...(failure?{failure}:{})});console.log(browserName,width,name,failure?'FAILED '+failure.split('\n')[0]:'passed');await context.close();await writeFile(join(evidence,resultName),JSON.stringify({begin,ended:new Date().toISOString(),results},null,2));
 }
 await browser.close();
}
const summary={begin,ended:new Date().toISOString(),passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,notRun:results.filter(x=>x.status==='not_run').length,results};await writeFile(join(evidence,resultName),JSON.stringify(summary,null,2));console.log(JSON.stringify({passed:summary.passed,failed:summary.failed,notRun:summary.notRun}));process.exitCode=summary.failed||summary.notRun?1:0;
