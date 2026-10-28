import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createProvider } from '../mock-provider/server.mjs';
import { setTestSession, teamIds } from './survey-test-session.mjs';
import { previewPng } from './document-preview-fixture.mjs';

const base=process.env.BNOC_QUALITY_URL||'http://127.0.0.1:5179';
const evidence=process.env.BNOC_EXPERIENCE_EVIDENCE_DIR||'runtime/evidence/experience-quality';
await mkdir(evidence,{recursive:true});
const report={cases:[],errors:[],attemptedWrites:0,actualBusinessWrites:0};
const at=new Date().toISOString(),date=at.slice(0,10);
const roster=teamIds.flatMap((department,t)=>Array.from({length:6},(_,i)=>({personRef:`experience-${t}-${i}`,displayName:`검증 인원 ${t+1}-${i+1}`,department,category:'병',rank:'상병',serviceNumber:`TEST-${t}-${i}`,internalPhone:'0000',complete:true,active:true,absences:t===4&&i===5?[{absenceRef:'experience-absence',absenceType:'휴가',startDate:date,endDate:date,revision:1}]:[]})));
const provider=createProvider({secret:randomBytes(32).toString('hex'),allowedOrigins:[new URL(base).origin]});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const identity=new URL(`http://127.0.0.1:${provider.address().port}/identity`);
identity.search=new URLSearchParams({loginAttempt:'experience-quality-attempt',browserBinding:'experience-quality-binding',returnUrl:new URL('/auth/callback',base).href});
const inViewport=async locator=>{
  await expect.poll(async()=>{const box=await locator.boundingBox();return !!box&&box.y>=0&&box.y+box.height<=900;},{message:'Focused control or feedback must be visible'}).toBe(true);
};
try {
  for(const [browserName,engine] of Object.entries({chromium,firefox})) {
    const browser=await engine.launch();
    try { for(const width of [1280,1440]) {
      const page=await browser.newPage({viewport:{width,height:900},locale:'ko-KR'});
      page.on('pageerror',error=>report.errors.push(error.message));
      page.on('dialog',dialog=>dialog.accept());
      await setTestSession(page,'admin');
      await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
        const request=route.request(),path=new URL(request.url()).pathname;
        if(!['GET','HEAD'].includes(request.method())) {
          report.attemptedWrites++;
          return route.fulfill({status:400,json:{ok:false,errorCode:'VALIDATION',message:'권한 저장 실패',fieldErrors:{}}});
        }
        let data;
        if(path==='/api/access-assignments')data={items:Array.from({length:20},(_,i)=>({subjectRef:`experience-user-${i}`,displayName:`검증 사용자 ${i+1}`,role:'requester',department:'요청 부서',departmentManager:false,active:true,revision:1})),total:20};
        else if(path==='/api/personnel-roster')data={entries:roster,revision:1};
        else if(path==='/api/requests/EXPERIENCE')data={requestNumber:'EXPERIENCE',requesterDisplayText:'검증 요청자',registeredBy:'requester',registeredAt:at,updatedAt:at,category:'장비/체계',status:'배정',revision:1,detail:'검증 내용',location:'검증 위치',contact:'0000',subcategories:{systemType:'인터넷'},schedulePreferences:[],teamIds:[],workItems:[],attachments:[{id:'experience-document',fileName:'검증 문서.txt',size:1024,contentType:'text/plain'}],history:[]};
        else if(path==='/api/requests/EXPERIENCE/history')data={items:[],total:0};
        else return route.fallback();
        return route.fulfill({json:{data,queriedAt:at}});
      }); // The underlying test-session handler fulfills every other API request locally.
      await page.goto(base+'/access');
      await page.getByRole('button',{name:'권한 변경',exact:true}).first().click();
      const role=page.getByRole('combobox',{name:'서비스 역할',exact:true});
      await expect(role).toBeFocused();await inViewport(role);
      await role.selectOption('team');
      await page.getByRole('button',{name:'권한 저장',exact:true}).click();
      const feedback=page.getByRole('alert').filter({hasText:'권한 저장 실패'});
      await expect(feedback).toBeFocused();await inViewport(feedback);await expect(role).toHaveValue('team');
      await page.screenshot({path:`${evidence}/${browserName}-${width}-access.png`});
      await setTestSession(page,'bnoc');await page.goto(base+'/roster');
      await page.locator('.personnel-department').getByRole('button',{name:'수정',exact:true}).last().click();
      const editor=page.locator('.personnel-editor'),first=editor.locator('select:not(:disabled)').first();
      await expect(first).toBeFocused();await inViewport(first);
      const name=editor.getByRole('textbox',{name:'이름',exact:true});await name.fill('수정 중 검증 인원');await expect(name).toBeFocused();
      await editor.getByRole('button',{name:'취소',exact:true}).click();
      await page.getByRole('button',{name:new RegExp(`휴가 ${date} 부재 수정`)}).click();
      await expect(editor.getByRole('combobox',{name:'인원',exact:true})).toBeFocused();await inViewport(editor.getByRole('combobox',{name:'인원',exact:true}));
      await page.screenshot({path:`${evidence}/${browserName}-${width}-personnel.png`});
      await editor.getByRole('button',{name:'취소',exact:true}).click();
      let documentAttempts=0,documentUnavailable=true;
      const doc={fileName:'검증 문서.png',status:'ready',canRetry:false,offset:0,totalBlocks:1,blocks:[{id:'block',type:'paragraph',text:'검증 문서 본문'}],metadata:[]};
      await page.route('**/api/attachments/experience-document/document*',route=>{documentAttempts++;return documentUnavailable?route.fulfill({status:503,json:{code:'UNAVAILABLE',message:'문서 조회 실패'}}):route.fulfill({json:{data:doc,queriedAt:at}});});
      await page.route('**/api/attachments/experience-document/inline',route=>route.fulfill({contentType:'image/png',body:previewPng}));
      await page.goto(base+'/requests/EXPERIENCE');await page.getByRole('button',{name:'문서 보기',exact:true}).click();
      const dialog=page.getByRole('dialog');await expect(dialog.getByRole('alert')).toContainText('문서 조회 실패');
      await expect(dialog.getByRole('status')).toHaveText('문서 조회 실패');
      const beforeRetry=documentAttempts;documentUnavailable=false;
      await dialog.getByRole('button',{name:'문서 다시 불러오기',exact:true}).click();
      await expect(dialog.getByRole('status')).toHaveText('분석 완료');assert.equal(documentAttempts,beforeRetry+1);
      const download=dialog.getByRole('link',{name:'원본 다운로드',exact:true});assert.equal((await download.boundingBox()).height,44);
      for(const selected of ['추출 본문','원본 보기']) {
        await dialog.getByRole('button',{name:selected,exact:true}).click();await page.mouse.move(0,0);
        await expect(dialog.getByRole('button',{name:selected,exact:true})).toHaveAttribute('aria-pressed','true');
        await expect(dialog.getByRole('button',{name:selected,exact:true})).toHaveCSS('background-color','rgb(239, 246, 255)');
        await expect(dialog.getByRole('button',{name:selected,exact:true})).toHaveCSS('color','rgb(29, 78, 216)');
        await expect(dialog.locator('[aria-pressed="false"]')).toHaveCSS('background-color','rgb(255, 255, 255)');
      }
      await page.screenshot({path:`${evidence}/${browserName}-${width}-document.png`});
      await dialog.getByRole('button',{name:'닫기',exact:true}).click();
      await page.goto(identity.href);
      assert.equal((await page.getByRole('combobox',{name:'사용자 역할',exact:true}).boundingBox()).height,44);
      assert.equal((await page.getByRole('button',{name:'로그인',exact:true}).boundingBox()).height,52);
      await page.keyboard.press('Tab');await expect(page.getByRole('combobox',{name:'사용자 역할',exact:true})).toBeFocused();
      await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'로그인',exact:true})).toBeFocused();
      assert.equal(await page.getByRole('button',{name:'로그인',exact:true}).evaluate(button=>getComputedStyle(button).outlineWidth),'3px');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:`${evidence}/${browserName}-${width}-identity.png`});
      report.cases.push({browser:browserName,width,passed:true});await page.close();
    }} finally { await browser.close(); }
  }
} catch(error) { report.errors.push(error.stack||String(error));process.exitCode=1; }
finally { await new Promise(resolve=>provider.close(resolve));await writeFile(`${evidence}/results.json`,JSON.stringify(report,null,2)); }
console.log(JSON.stringify(report));
