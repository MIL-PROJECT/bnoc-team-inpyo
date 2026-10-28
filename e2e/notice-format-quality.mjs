import {chromium,firefox,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTestSession} from './survey-test-session.mjs';
const base=process.env.BNOC_QUALITY_URL||'http://127.0.0.1:5179';
const evidence=process.env.BNOC_NOTICE_FORMAT_EVIDENCE_DIR||'runtime/evidence/notice-format-quality';
await mkdir(evidence,{recursive:true});
const text='보존 앞 선택 가운데 보존 뒤',at=new Date().toISOString(),report={cases:[],errors:[],actualBusinessWrites:0};
for(const [browserName,engine]of Object.entries({chromium,firefox})){
 const browser=await engine.launch();
 try{for(const width of [1280,1440]){
  const page=await browser.newPage({viewport:{width,height:900},locale:'ko-KR'});page.setDefaultTimeout(10000);await setTestSession(page,'bnoc');
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.route('**/api/notices/format-test',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{data:{noticeRef:'format-test',title:'합성 서식 검증',body:text,bodyDocument:{version:1,blocks:[{type:'paragraph',runs:[{text}]}]},createdAt:at,updatedAt:at,createdBy:'BNOC',revision:1,attachments:[]},queriedAt:at}});});
  await page.goto(base+'/notices/format-test');await page.getByRole('button',{name:'공지 수정',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'내용',exact:true}),select=async()=>{await editor.focus();await page.keyboard.press('ControlOrMeta+A');};
  const measure=()=>editor.evaluate(root=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),runs=[];while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent?.trim())continue;const style=getComputedStyle(node.parentElement);runs.push({text:node.textContent,size:style.fontSize,color:style.color,bold:style.fontWeight,underline:!!node.parentElement.closest('u')});}return runs;});
  const color=await editor.evaluate(root=>getComputedStyle(root).color);
  await select();await page.getByRole('button',{name:'굵게',exact:true}).click();await select();await page.getByRole('button',{name:'밑줄',exact:true}).click();
  for(const size of [16,20,24,16]){await select();await page.getByRole('button',{name:`글자 크기 ${size}`,exact:true}).click();assert((await measure()).every(r=>r.size===`${size}px`),'Sequential size must reach visible text');}
  for(const [value,expected]of [['#b91c1c','rgb(185, 28, 28)'],['#1d4ed8','rgb(29, 78, 216)'],['#166534','rgb(22, 101, 52)'],['default',color]]){await select();await page.getByLabel('글자색',{exact:true}).selectOption(value);assert((await measure()).every(r=>r.color===expected),'Sequential color must reach visible text');}
  await select();await page.getByRole('button',{name:'글자 크기 20',exact:true}).click();await select();await page.getByLabel('글자색',{exact:true}).selectOption('#b91c1c');
  const start=text.indexOf('선택 가운데'),end=start+'선택 가운데'.length;
  const partial=()=>editor.evaluate((root,{start,end})=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=document.createRange();let offset=0,started=false;while(walker.nextNode()){const node=walker.currentNode,length=node.textContent.length;if(!started&&start>=offset&&start<offset+length){range.setStart(node,start-offset);started=true;}if(started&&end<=offset+length){range.setEnd(node,end-offset);break;}offset+=length;}root.focus();const selection=getSelection();selection.removeAllRanges();selection.addRange(range);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));},{start,end});
  await partial();await page.getByRole('button',{name:'글자 크기 24',exact:true}).click();await partial();await page.getByLabel('글자색',{exact:true}).selectOption('default');
  const before=await measure();assert.equal(before.map(r=>r.text).join(''),text);let offset=0;
  for(const run of before){for(const c of run.text){const selected=offset>=start&&offset<end;assert.equal(run.size,selected?'24px':'20px');assert.equal(run.color,selected?color:'rgb(185, 28, 28)');assert.equal(run.bold,'700');assert(run.underline);offset++;}}
  const model=await editor.evaluate(async root=>{const {serializeNoticeEditor,writeNoticeEditor}=await import('/src/screens/NoticeBodyEditor.tsx');const value=serializeNoticeEditor(root);writeNoticeEditor(root,value);return value;});
  assert.deepEqual(await measure(),before,'Serialization/write must preserve visible runs');assert.equal(model.blocks.flatMap(b=>b.runs).map(r=>r.text).join(''),text);
  await select();await page.getByRole('button',{name:'글머리 목록',exact:true}).click();await expect(editor.locator('ul>li')).toHaveCount(1);await select();await page.getByRole('button',{name:'번호 목록',exact:true}).click();await expect(editor.locator('ol>li')).toHaveCount(1);await expect(editor.locator('ul')).toHaveCount(0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${evidence}/${browserName}-${width}.png`});report.cases.push({browser:browserName,width,passed:true,model});await page.close();
 }}catch(error){report.errors.push(error.stack||String(error));process.exitCode=1;}finally{await browser.close();}
}
await writeFile(evidence+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
