import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTestSession } from './survey-test-session.mjs';

assert(process.env.BNOC_FEEDBACK_EVIDENCE_DIR, 'Set a new dedicated evidence directory');
const evidence=resolve(process.env.BNOC_FEEDBACK_EVIDENCE_DIR);
await mkdir(evidence,{recursive:false,mode:0o700});
const report={checks:[],errors:[],pageErrors:[],writes:[]};
const date=(offset=0)=>new Date(Date.now()+9*3600000+offset*86400000).toISOString().slice(0,10);
const at=new Date().toISOString(),id='11111111-1111-1111-1111-111111111111';
const server=await createServer({root:resolve('frontend'),cacheDir:resolve(evidence,'vite-cache'),server:{host:'127.0.0.1',port:0,hmr:false,watch:null},logLevel:'error'});
await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
try {
  for(const [browserName,engine] of Object.entries({chromium,firefox})) {
    const browser=await engine.launch();
    try {
      for(const width of [1280,1440]) {
        const label=`${browserName}-${width}`;
        const context=await browser.newContext({viewport:{width,height:900},locale:'ko-KR',serviceWorkers:'block'});
        try {
          const page=await context.newPage();page.setDefaultTimeout(8000);
          page.on('pageerror',error=>report.pageErrors.push({label,message:error.message}));
          await setTestSession(page,'bnoc');
          let notice={noticeRef:'format-feedback',title:'서식 저장 확인',body:'첫째 문단\n둘째 문단',bodyDocument:{version:1,blocks:['첫째 문단','둘째 문단'].map(text=>({type:'paragraph',runs:[{text}]}))},createdAt:at,updatedAt:at,createdBy:'BNOC',revision:1,attachments:[]};
          const commands=[];
          await page.route('**/api/notices**',route=>route.fulfill({json:{data:new URL(route.request().url()).pathname==='/api/notices'?{items:[notice],total:1}:notice,queriedAt:at}}));
          await page.route('**/api/commands',async route=>{
            const command=route.request().postDataJSON();commands.push(command);report.writes.push({label,kind:'notice-fixture',type:command.type});
            assert.equal(command.type,'updateDirective');
            notice={...notice,...command.payload,revision:2};
            return route.fulfill({json:{ok:true,publicRef:notice.noticeRef,revision:2}});
          });
          await page.goto(base+'/notices');
          await expect(page.locator('.notice-list-preview')).toHaveText('첫째 문단 둘째 문단');
          await page.getByRole('button',{name:notice.title,exact:true}).click();
          await page.getByRole('button',{name:'공지 수정',exact:true}).click();
          const editor=page.getByRole('textbox',{name:'내용',exact:true});
          const selectAll=async()=>{await editor.focus();await page.keyboard.press('ControlOrMeta+A');};
          await selectAll();await page.getByLabel('글꼴',{exact:true}).selectOption('serif');
          await selectAll();await page.getByLabel('글자 크기',{exact:true}).fill('32');await page.getByRole('button',{name:'크기 적용',exact:true}).click();
          await selectAll();await page.getByRole('button',{name:'기울임',exact:true}).click();
          const getModel=()=>editor.evaluate(async root=>(await import('/src/screens/NoticeBodyEditor.tsx')).serializeNoticeEditor(root));
          let model=await getModel();
          assert.equal(model.blocks.length,2,'MULTI_PARAGRAPH_FORMAT_MUST_KEEP_BLOCKS');
          assert(model.blocks.flatMap(block=>block.runs).every(run=>run.font==='serif'&&run.size===32&&run.italic),'CUSTOM_NOTICE_FORMAT_MUST_SERIALIZE');
          await selectAll();await page.getByLabel('글꼴',{exact:true}).selectOption('monospace');
          await selectAll();await page.getByLabel('글자 크기',{exact:true}).fill('12');await page.getByRole('button',{name:'크기 적용',exact:true}).click();
          model=await getModel();assert(model.blocks.flatMap(block=>block.runs).every(run=>run.font==='monospace'&&run.size===12&&run.italic));
          await selectAll();await page.getByRole('button',{name:'글자 크기 24',exact:true}).click();
          await selectAll();await page.getByLabel('글자색',{exact:true}).selectOption('#b91c1c');
          await selectAll();await page.getByLabel('글자색',{exact:true}).selectOption('default');
          model=await getModel();assert(model.blocks.flatMap(block=>block.runs).every(run=>run.size===24&&run.color==='default'&&run.font==='monospace'));
          await editor.evaluate(async root=>{const {serializeNoticeEditor,writeNoticeEditor}=await import('/src/screens/NoticeBodyEditor.tsx');writeNoticeEditor(root,serializeNoticeEditor(root));});
          assert.deepEqual(await getModel(),model,'NOTICE_RELOAD_MUST_PRESERVE_FORMAT');
          await page.getByRole('button',{name:'수정 저장',exact:true}).click();
          await expect(page.getByRole('heading',{name:notice.title,exact:true})).toBeVisible();
          assert.equal(commands.length,1);assert.deepEqual(commands[0].payload.bodyDocument,model);
          await page.reload();
          await expect(page.locator('.notice-content p')).toHaveCount(2);
          assert(await page.locator('.notice-content span').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).fontSize==='24px'&&getComputedStyle(element).fontStyle==='italic'&&getComputedStyle(element).fontFamily==='monospace')));
          await page.screenshot({path:resolve(evidence,`${label}-notice.png`),fullPage:true});
          report.checks.push(`${label}: notice list preview, multi paragraph fonts, custom size, italic, reselect, save and reload`);
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));

          await setTestSession(page,'team');
          let planned={id,teamId:'무선반',department:'무선반',title:'완료일 수정 확인',status:'완료',firstWorkDate:date(-5),completedDate:date(-1),revision:2,updatedAt:at};
          const patches=[];
          await page.route('**/api/planned-works**',route=>{
            if(route.request().method()==='PATCH') {
              const body=route.request().postDataJSON();patches.push(body);report.writes.push({label,kind:'planned-fixture',completedDate:body.completedDate});
              planned={...planned,...body,revision:planned.revision+1};
              return route.fulfill({json:{data:{plannedWork:planned,replayed:false}}});
            }
            return route.fulfill({json:{data:{workDate:new URL(route.request().url()).searchParams.get('workDate'),inProgress:[],completed:[planned]},queriedAt:at}});
          });
          await page.goto(base+'/requests?view=planned-maintenance');
          await page.getByRole('button',{name:'수정',exact:true}).click();
          const edit=page.locator('.planned-edit');
          await edit.getByLabel('완료일',{exact:true}).fill(date(-2));
          await edit.getByRole('button',{name:'저장',exact:true}).click();
          await expect(edit).toHaveCount(0);
          assert.equal(patches.length,1);assert.equal(patches[0].completedDate,date(-2));assert.equal(patches[0].revision,2);assert.equal(patches[0].firstWorkDate,date(-5));assert(patches[0].operationId);
          await page.reload();await expect(page.locator('.planned-item-status')).toContainText('완료');
          await page.getByRole('button',{name:'수정',exact:true}).click();
          await expect(page.locator('.planned-edit').getByLabel('완료일',{exact:true})).toHaveValue(date(-2));
          await page.locator('.planned-edit').getByLabel('완료일',{exact:true}).fill(date(1));
          await page.locator('.planned-edit').getByRole('button',{name:'저장',exact:true}).click();
          assert.equal(patches.length,1,'FUTURE_COMPLETION_MUST_NOT_SAVE');
          await page.screenshot({path:resolve(evidence,`${label}-planned.png`),fullPage:true});
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
          report.checks.push(`${label}: completed date PATCH and persisted edit value, future date blocked`);
        } catch(error) { report.errors.push({label,message:error.stack??String(error)}); }
        finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  await server.close();await rm(resolve(evidence,'vite-cache'),{recursive:true,force:true});
  await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
assert.equal(report.errors.length,0);assert.equal(report.pageErrors.length,0);
