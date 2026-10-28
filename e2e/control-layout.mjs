import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTestSession } from './survey-test-session.mjs';

const base = process.env.BNOC_CONTROL_URL || 'http://127.0.0.1:5173';
const evidence = process.env.BNOC_CONTROL_EVIDENCE_DIR || 'runtime/evidence/control-consistency-20261026/contracts';
await mkdir(evidence, { recursive: true });
const results = [];
async function boxes(locator) {
  return locator.evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => {
    const rect = element.getBoundingClientRect();
    return { label: element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('type') || element.tagName, height: rect.height, top: rect.top, bottom: rect.bottom, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  }));
}
async function equalHeight(locator, size, label) {
  const values = await boxes(locator);
  assert.ok(values.length, `${label}: controls must exist`);
  for (const value of values) assert.ok(Math.abs(value.height - size) < .5, `CONTROL_HEIGHT ${label}: ${value.label} ${value.height}, expected ${size}`);
  return values;
}
async function aligned(locator, label) {
  const values = await equalHeight(locator, 44, label);
  assert.ok(Math.max(...values.map(value => value.bottom)) - Math.min(...values.map(value => value.bottom)) < 1, `CONTROL_ALIGNMENT ${label}: bottom edges differ`);
}
for (const [browserName, type] of [['chromium', chromium], ['firefox', firefox]]) {
  const browser = await type.launch({ headless: true });
  try {
    for (const width of [1024, 1280, 1440]) {
      for (const height of [768, 900]) {
      const page = await browser.newPage({ viewport: { width, height }, locale: 'ko-KR' });
      const errors = [], writes = [], rosterReads = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { const path = new URL(request.url()).pathname; if (path==='/api/personnel-roster'&&request.method()==='GET') rosterReads.push(path); if (path.startsWith('/api/') && request.method() !== 'GET') writes.push(`${request.method()} ${path}`); });
      await setTestSession(page, 'bnoc');
      const today = await page.evaluate(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()));
      const fixturePeople = Array.from({ length: 7 }, (_, index) => ({ personRef: `layout-person-${index}`, category: '간부', rank: index === 0 ? '대령' : '소위', displayName: ['인원가가','인원나','인원다','인원라','인원마','인원바','인원사'][index], department: ['전장반', '무선반', '유선반', '교환반', '전산반'][index % 5], serviceNumber: `LAYOUT-${index}`, internalPhone: '0000', active: true, absences: [] }));
      let fixtureSchedule = fixturePeople.map((person, index) => ({ date: today, seat: index === 0 || index > 2 ? 'team_night' : index === 1 ? 'duty_officer' : 'communications_battalion_day_officer', scopeKey: index === 0 || index > 2 ? person.department : '', revision: 1, people: [{ personRef: person.personRef, displayName: person.displayName, rank: person.rank, category: person.category, department: person.department, active: true, conflict: false }] }));
      await page.route(url=>['/api/personnel-roster','/api/duty-schedules'].includes(url.pathname),route=>{const roster=new URL(route.request().url()).pathname==='/api/personnel-roster';return route.fulfill({json:{data:roster?{entries:fixturePeople,revision:1}:{entries:fixtureSchedule},queriedAt:new Date().toISOString()}});});
      await page.goto(base + '/night-duty?preview=main');
      await expect(page.getByRole('heading', { name: '당직 야간근무 현황', exact: true })).toBeVisible();
      await expect(page.getByText('불러오는 중…')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '금일 근무 편성', exact: true })).toBeVisible();
      await expect(page.getByRole('button', {name:'일',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(page.getByText('당직사관 · 24시간', {exact:true})).toBeVisible();
      await expect(page.getByText('A대대 일직사관 · 24시간', {exact:true})).toBeVisible();
      const dutySummary=page.locator('.duty-daily-summary');
      for(const seat of ['당직사관','A대대 일직사관','B대대 일직사관'])await expect(dutySummary.getByRole('region',{name:seat,exact:true})).toBeVisible();
      await expect(dutySummary.getByRole('region',{name:'B대대 일직사관',exact:true}).getByLabel('미편성',{exact:true})).toBeVisible();
      for(const team of ['무선반','유선반','전장반(전산장비)','정체반','암호반'])await expect(dutySummary.getByRole('region',{name:team+' 야간근무',exact:true})).toBeVisible();

      await expect(page.getByText(/당직사관, A대대 일직사관, B대대 일직사관은 24시간 근무자로 야간 현황에 포함됩니다/)).toBeVisible();
      await page.getByRole('button', {name:'주',exact:true}).click();
      await expect(page.locator('.duty-day')).toHaveCount(7);
      await expect(page.locator('.duty-officer-board').getByRole('region',{name:'B대대 일직사관',exact:true})).toBeVisible();
      await page.getByRole('button', {name:'월',exact:true}).click();
      const dutyCalendar = page.locator('.duty-calendar-panel');
      for(const seat of ['당직사관','A대대 일직사관','B대대 일직사관'])await expect(page.locator('.duty-officer-board').getByRole('region',{name:seat,exact:true})).toBeVisible();
      const dateCell = page.getByRole('button', { name: new RegExp(`${today} 근무자 보기`) });
      const firstNameEntry = dateCell.locator('.duty-entry').first();
      assert.equal(await firstNameEntry.innerText(), '대령 인원가가', 'DUTY_NAME_FIRST: show rank and name without a department prefix');
      const nameWidth = await firstNameEntry.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
      assert.ok(nameWidth.scroll <= nameWidth.client, `DUTY_NAME_CLIPPED: ${JSON.stringify(nameWidth)}`);
      assert.match(await dateCell.getAttribute('aria-label') || '', /소위 인원사/, 'DUTY_ACCESSIBLE_NAMES: include names beyond the visible summary');
      assert.match(await dateCell.getAttribute('title') || '', /소위 인원사/, 'DUTY_TOOLTIP_NAMES: include names beyond the visible summary');
      assert.doesNotMatch(await dateCell.innerText(), /전장반|무선반|유선반|교환반|전산반/, 'DUTY_DEPARTMENT_VISIBLE');
      assert.doesNotMatch(await dateCell.getAttribute('aria-label') || '', /전장반|무선반|유선반|교환반|전산반/, 'DUTY_ACCESSIBLE_DEPARTMENT_VISIBLE');
      assert.doesNotMatch(await dateCell.getAttribute('title') || '', /전장반|무선반|유선반|교환반|전산반/, 'DUTY_TOOLTIP_DEPARTMENT_VISIBLE');
      const cellHeights = await page.locator('.duty-day').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      assert.ok(Math.max(...cellHeights) - Math.min(...cellHeights) < 1, 'DUTY_CELL_HEIGHT: assignment text must not expand month rows');
      assert.ok(await page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight), 'DUTY_VIEWPORT_OVERFLOW: monthly duty must stay within one viewport');
      const calendarBox = await dutyCalendar.boundingBox();
      assert.ok(calendarBox && calendarBox.y + calendarBox.height <= height, `DUTY_CALENDAR_VIEWPORT: ${JSON.stringify(calendarBox)}`);
      const dutyEditor = page.locator('.duty-editor');
      if (width >= 1024) {
        assert.ok(await dutyEditor.evaluate(node => node.scrollHeight <= node.clientHeight + 1), `DUTY_EDITOR_SCROLL: ${width}x${height} ${await dutyEditor.evaluate(node => JSON.stringify({scrollHeight:node.scrollHeight,clientHeight:node.clientHeight}))}`);
        const saveBox = await page.getByRole('button', {name:/야간근무표 저장|당직·일직 편성 저장/}).boundingBox();
        const editorBox = await dutyEditor.boundingBox();
        assert.ok(saveBox && editorBox && saveBox.y + saveBox.height <= editorBox.y + editorBox.height, `DUTY_SAVE_HIDDEN: ${width}x${height} ${JSON.stringify({saveBox,editorBox})}`);
      }
      await expect(dateCell).toHaveAttribute('aria-label', new RegExp('소위 인원사'));
      const keyboardDate = page.locator('.duty-day:not([aria-pressed="true"])').first();
      const keyboardDateLabel = await keyboardDate.getAttribute('aria-label');
      await keyboardDate.focus(); await page.keyboard.press('Enter');
      await expect(page.locator(`.duty-day[aria-label="${keyboardDateLabel}"]`)).toHaveAttribute('aria-pressed', 'true');
      // FR-052 / R03: six-week months retain readable names even with several officers.
      const originalSchedule=fixtureSchedule,originalPeopleCount=fixturePeople.length;
      for(const officerCount of [2,12]) {
        const stressDate='2026-11-10';
        const officers=Array.from({length:officerCount},(_,index)=>({personRef:`layout-officer-${officerCount}-${index}`,category:'간부',rank:'소위',displayName:`인원 ${index+1}`,department:'무선반',serviceNumber:`LAYOUT-OFFICER-${index}`,internalPhone:'0000',active:true,absences:[]}));
        fixturePeople.push(...officers);
        fixtureSchedule=[{date:stressDate,seat:'duty_officer',scopeKey:'',revision:1,people:officers.map(person=>({...person,conflict:false}))}];
        await page.reload();await page.getByRole('button',{name:'월',exact:true}).click();await page.getByLabel('대상 월',{exact:true}).fill('2026-11');
        const stressCell=page.getByRole('button',{name:new RegExp(`^${stressDate} 근무자 보기`)});await stressCell.click();
        const nameEntry=stressCell.locator('.duty-entry').first();await expect(nameEntry).toContainText('소위 인원 1');
        const nameBox=await nameEntry.evaluate(node=>({height:node.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(node).lineHeight)}));
        assert.ok(nameBox.height+.5>=nameBox.lineHeight,`DUTY_SIX_WEEK_NAME_HEIGHT: ${width}x${height} officers=${officerCount} ${JSON.stringify(nameBox)}`);
        assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight<=innerHeight),'DUTY_SIX_WEEK_VIEWPORT');
        const stressCalendar=await page.locator('.duty-calendar-panel').boundingBox();assert.ok(stressCalendar&&stressCalendar.y+stressCalendar.height<=height,'DUTY_SIX_WEEK_CALENDAR');
        for(const seat of ['당직사관','A대대 일직사관','B대대 일직사관'])await expect(page.locator('.duty-officer-board').getByRole('region',{name:seat,exact:true})).toBeVisible();
        await page.screenshot({path:join(evidence,`${browserName}-${width}-${height}-six-week-${officerCount}.png`)});
        fixturePeople.splice(originalPeopleCount);
      }
      fixtureSchedule=originalSchedule;
      const rosterReadsBeforeRequester=rosterReads.length;
      await setTestSession(page,'requester');
      await page.goto(base + '/night-duty?preview=main');
      await expect(page.getByRole('heading', { name: '당직 야간근무 현황', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '금일 근무 편성', exact: true })).toBeVisible();
      await expect(page.getByText('소위 인원다', {exact:true})).toBeVisible();
      await expect(page.getByText('당직사관 · 24시간', {exact:true})).toBeVisible();
      await expect(page.getByRole('form', { name: '근무 편성' })).toHaveCount(0);
      assert.equal(rosterReads.length,rosterReadsBeforeRequester,'DUTY_READ_ONLY_ROSTER: requester must not load central personnel data');
      await page.getByRole('button', {name:'주',exact:true}).click();
      await expect(page.locator('.duty-day')).toHaveCount(7);
      await page.locator('.duty-day[aria-pressed="false"]').first().click();
      await expect(page.locator('.duty-readonly-details')).toBeVisible();
      await page.getByRole('button', {name:'월',exact:true}).click();
      await expect(page.getByRole('button', {name:'월',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(page.locator('.duty-calendar-panel')).toBeVisible();
      assert.equal(writes.length,0,'DUTY_VIEW_NO_WRITES: viewing schedules must be read-only');
      await setTestSession(page,'team-wireless');
      await page.goto(base + '/night-duty?preview=main');
      await expect(page.getByText(/작업반은 자기 반 야간근무자를 월별로 편성합니다/)).toBeVisible();
      await expect(page.getByText(/당직사관, A대대 일직사관, B대대 일직사관은 24시간 근무자로 야간 현황에 포함됩니다/)).toBeVisible();
      await expect(page.getByRole('form', { name: '근무 편성' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '금일 근무 편성', exact: true })).toBeVisible();
      await setTestSession(page,'bnoc');
      await page.goto(base + '/night-duty?preview=main');
      await expect(page.getByRole('heading', { name: '당직 야간근무 현황', exact: true })).toBeVisible();
      await expect(page.getByText('불러오는 중…')).toHaveCount(0);
      await aligned(page.locator('.duty-toolbar .ui-action-group').locator('button,input'), 'month navigation');
      await equalHeight(page.locator('.duty-editor input[type="search"],.duty-editor select,.duty-save'), 44, 'duty editor');
      await page.screenshot({ path: join(evidence, `${browserName}-${width}-${height}-duty.png`) });
      await page.locator('.duty-toolbar').screenshot({ path: join(evidence, `${browserName}-${width}-${height}-month.png`) });
      await page.locator('.nav-group summary').filter({ hasText: '부대 현황' }).click();
      await page.getByRole('button', { name: '부대 인원 명부', exact: true }).click();
      await aligned(page.locator('.personnel-toolbar').locator('input,select,button'), 'roster toolbar');
      await equalHeight(page.locator('.personnel-categories button'), 44, 'category buttons with counts');
      await page.getByRole('button', { name: '인원 등록', exact: true }).click();
      await equalHeight(page.locator('.personnel-editor input:not([type="checkbox"]),.personnel-editor select,.personnel-editor button'), 44, 'personnel form');
      await equalHeight(page.locator('.personnel-editor input[type="checkbox"]'), 18, 'personnel choices');
      await page.screenshot({ path: join(evidence, `${browserName}-${width}-roster.png`), fullPage: true });
      // Render contract cases with the same loaded product styles; no product route or business writes.
      await page.evaluate(() => {
        const fixture = document.createElement('section');
        fixture.id = 'control-contract';
        fixture.innerHTML = `<div class="ui-action-group" id="single-controls"><button class="ui-button">버튼</button><input aria-label="텍스트" value="입력값"><input type="search" aria-label="검색"><input type="number" value="12"><input type="date" value="2026-10-26"><input type="month" value="2026-10"><input type="time" value="14:30"><select><option>선택값</option></select><button disabled>비활성</button></div><textarea rows="4">여러 줄 내용</textarea><input type="checkbox"><input type="radio"><input type="file"><div class="notice-toolbar"><button>굵게</button><label class="field"><span>크기</span><select><option>본문</option></select></label></div><button class="auth-button">로그인</button><div class="header-context"><button><strong>GPS · 정상</strong><small>수집 성공</small></button></div><button class="calendar-item" style="width:220px">${'<span>여러 줄 정비 작업 내용</span>'.repeat(8)}</button><button class="ui-button duty-day" style="width:160px">${'<span>날짜별 여러 근무자</span>'.repeat(10)}</button><div class="metric-buttons"><button><strong>125</strong><span>정비 집계</span></button></div><div class="queue-row"><button class="queue-row__open">요청 제목</button><button class="ui-button badge">대기</button></div><button class="queue-row" style="width:180px;display:block">${'줄바꿈이 필요한 긴 요청 제목 '.repeat(6)}</button><button class="link" style="width:160px;display:block">${'긴 문서 검색 결과 '.repeat(10)}</button>`;
        document.querySelector('main').append(fixture);
      });
      await equalHeight(page.locator('#single-controls').locator('button,input,select'), 44, 'single-line contract');
      await equalHeight(page.locator('#control-contract .notice-toolbar button,#control-contract .notice-toolbar select'), 36, 'compact editing controls');
      await equalHeight(page.locator('#control-contract .auth-button'), 52, 'prominent login');
      await equalHeight(page.locator('#control-contract input[type="checkbox"],#control-contract input[type="radio"]'), 18, 'choices');
      await equalHeight(page.locator('#control-contract input[type="file"]'), 44, 'file input');
      await equalHeight(page.locator('#control-contract div.queue-row .badge'), 44, 'nested status badge');
      for (const selector of ['textarea', '.calendar-item', '.duty-day', '.metric-buttons button', 'button.queue-row', '.link', '.header-context button']) {
        const values = await boxes(page.locator('#control-contract ' + selector));
        assert.ok(values[0].height > 44, `CONTENT_HEIGHT ${selector}: content must grow`);
        assert.ok(values[0].scrollHeight <= values[0].clientHeight + 1, `CONTENT_CLIPPING ${selector}: content clipped`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'PAGE_OVERFLOW');
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      results.push({ browser: browserName, width, height, result: 'pass', writes: 0 });
      await page.close();
      }
    }
  } finally { await browser.close(); }
}
await writeFile(join(evidence, 'results.json'), JSON.stringify({ results }, null, 2));
console.log(JSON.stringify({ total: results.length, passed: results.length, evidence }));
