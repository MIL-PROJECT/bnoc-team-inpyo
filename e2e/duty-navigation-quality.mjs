import {chromium,firefox,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTestSession,teamIds} from './survey-test-session.mjs';
const base=process.env.BNOC_QUALITY_URL||'http://127.0.0.1:5179';
const evidence=process.env.BNOC_DUTY_NAV_EVIDENCE_DIR||'runtime/evidence/duty-navigation-quality';
await mkdir(evidence,{recursive:true});
const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10),at=new Date().toISOString();
const people=[0,1].map(i=>({personRef:`navigation-${i}`,displayName:`검증 사관 ${i+1}`,department:teamIds[0],category:'간부',rank:'대위',complete:true,active:true,absences:[]}));
const report={cases:[],errors:[],actualBusinessWrites:0};
for(const [browserName,engine] of Object.entries({chromium,firefox})) {
  const browser=await engine.launch();
  try { for(const width of [1280,1440]) {
    const page=await browser.newPage({viewport:{width,height:900},locale:'ko-KR'}),dialogs=[];let editable=false;page.setDefaultTimeout(10000);
    page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    page.on('pageerror',error=>report.errors.push(error.message));
    await setTestSession(page,'requester');
    await page.route(url=>url.pathname.startsWith('/api/'),route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      assert(['GET','HEAD'].includes(route.request().method()),'Navigation must never write');
      const data=path==='/api/personnel-roster'?{entries:people,revision:1}:path==='/api/duty-schedules'?{entries:url.searchParams.get('month')===date.slice(0,7)?[{date,seat:'duty_officer',scopeKey:'',revision:1,people:[editable?{...people[0],conflict:false}:{rank:people[0].rank,displayName:people[0].displayName}]}]:[]}:undefined;
      return data?route.fulfill({json:{data,queriedAt:at}}):route.fallback();
    });
    await page.goto(base+'/night-duty');await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
    await expect(page.locator('.duty-daily-summary').getByText(`대위 ${people[0].displayName}`,{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'주',exact:true}).click();
    assert.deepEqual(dialogs,[],'A read-only viewer must not get an unsaved-edit confirmation');
    await expect(page.getByRole('heading',{name:'주간 당직 야간근무 현황',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'월',exact:true}).click();
    assert.deepEqual(dialogs,[]);await expect(page.getByRole('heading',{name:'월간 당직 야간근무 현황',exact:true})).toBeVisible();
    editable=true;await setTestSession(page,'bnoc');await page.goto(base+'/night-duty');await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('checkbox',{name:new RegExp(people[0].displayName)})).toBeChecked();
    await page.getByRole('button',{name:'주',exact:true}).click();assert.deepEqual(dialogs,[],'Loading saved data is not a user edit');
    await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
    await page.getByRole('checkbox',{name:new RegExp(people[1].displayName)}).check();
    await page.getByRole('button',{name:'다음 기간',exact:true}).click();
    assert.deepEqual(dialogs,['저장하지 않은 근무 편성을 취소할까요?'],'A real selection edit must keep the existing confirmation');
    await expect(page.getByRole('checkbox',{name:new RegExp(people[1].displayName)})).toBeChecked();
    await page.screenshot({path:`${evidence}/${browserName}-${width}.png`});report.cases.push({browser:browserName,width,passed:true});await page.close();
  }} catch(error) {report.errors.push(error.stack||String(error));process.exitCode=1;}
  finally {await browser.close();}
}
await writeFile(`${evidence}/results.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
