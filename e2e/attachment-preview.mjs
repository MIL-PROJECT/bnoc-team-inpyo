import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,firefox} from '@playwright/test';
import {docxFixture,previewPng,previewPdf} from './document-preview-fixture.mjs';
import init,{HwpDocument} from '../frontend/node_modules/@rhwp/core/rhwp.js';

const base=process.env.BNOC_ATTACHMENT_UI_URL??'http://127.0.0.1:5188';
const evidence=resolve(process.env.BNOC_ATTACHMENT_UI_EVIDENCE??'runtime/evidence/team-feedback-20261028/attachment-ui');
const mode=process.env.BNOC_ATTACHMENT_UI_MODE??'full';
await mkdir(evidence,{recursive:true});
const hwp=await readFile('frontend/src/preview/fixtures/support.hwp');
globalThis.measureTextWidth=(_font,text)=>text.length*10;
await init({module_or_path:new Uint8Array(await readFile('frontend/node_modules/@rhwp/core/rhwp_bg.wasm'))});
const parsed=new HwpDocument(hwp);parsed.insertPageBreak(0,1,0);
assert(parsed.pageCount()>1,'MULTIPAGE_HWPX_FIXTURE_REQUIRED');
const hwpx=Buffer.from(parsed.exportHwpx());parsed.free();
await writeFile(resolve(evidence,'support.hwpx'),hwpx);
const source=new Map([['hwp',hwp],['hwpx',hwpx],['broken',Buffer.from('broken HWP')],['docx',docxFixture()],['pdf',previewPdf()],['png',previewPng]]);
const transformed=await (await fetch(base+'/src/main.tsx')).text();
const reactImport=transformed.match(/from "([^"]*\/react\.js[^"]*)"/)[1],reactDomImport=transformed.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)[1];
const entry=`import React from '${reactImport}';const {useState}=React;
import ReactDOM from '${reactDomImport}';const {createRoot}=ReactDOM;
import {AttachmentPicker} from '/src/screens/AttachmentPicker.tsx';
import {AttachmentDocumentDialog} from '/src/screens/AttachmentDocumentDialog.tsx';
import {ApiClient} from '/src/api/apiClient.mjs';
import '/src/styles/global.css';import '/src/ui/components.css';
const api=new ApiClient();const root=createRoot(document.getElementById('root'));
function Harness({file='hwp',kind='picker'}){const [files,setFiles]=useState(kind==='restored'?[{id:file,fileName:'복원.hwp',size:5000,type:'application/octet-stream'}]:[]);return React.createElement('main',{'data-file':file},React.createElement('h1',null,'첨부 검증'),kind==='dialog'?React.createElement(AttachmentDocumentDialog,{api,attachmentId:file,onClose:()=>window.showAttachment('hwp','picker')}):React.createElement(AttachmentPicker,{files,onChange:setFiles,upload:async selected=>({id:file,fileName:selected.name,size:selected.size,type:'application/octet-stream'}),label:'사진·문서 첨부'}));}
window.showAttachment=(file,kind)=>root.render(React.createElement(Harness,{key:file+kind,file,kind}));window.showAttachment('hwp','picker');`;
const results=[];
for(const [browserName,engine] of Object.entries({chromium,firefox}))for(const width of [1280,1440]){
 const browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.log('pageerror',error.message)});page.on('console',message=>{if(message.type()==='error')console.log('console',message.text().slice(0,300))});
 await page.route('**/src/main.tsx*',route=>route.fulfill({contentType:'text/javascript',body:entry}));
 await page.route('**/api/attachments/**',async route=>{
  const path=new URL(route.request().url()).pathname,ref=path.split('/')[3],extension=ref==='broken'?'hwp':ref;
  if(path.endsWith('/document'))return route.fulfill({json:{data:{fileName:`지원.${extension}`,status:'temporary',blocks:[],metadata:[],offset:0,totalBlocks:0,canRetry:false}}});
  if(path.endsWith('/render-source'))return route.fulfill({contentType:'application/octet-stream',body:source.get(ref)});
  if(path.endsWith('/inline'))return route.fulfill({contentType:ref==='pdf'?'application/pdf':'image/png',body:source.get(ref)});
  return route.fulfill({contentType:'application/octet-stream',body:source.get(ref)});
 });
 try{
  await page.goto(base);await page.waitForFunction(()=>typeof window.showAttachment==='function');
  await page.getByLabel('사진·문서 첨부',{exact:true}).setInputFiles({name:'지원.hwp',mimeType:'application/octet-stream',buffer:hwp});
  const preview=page.getByRole('button',{name:'지원.hwp 미리보기',exact:true});
  const visible=await preview.isVisible();results.push({browserName,width,case:'picker preview available before submission',passed:visible});
  if(mode==='red'){
   await page.evaluate(()=>window.showAttachment('hwpx','dialog'));await page.getByRole('dialog').waitFor();await page.waitForTimeout(300);
   const supported=await page.locator('.hwp-page-view').count()>0;results.push({browserName,width,case:'HWPX original renderer selected',passed:supported});
   await page.screenshot({path:resolve(evidence,`red-${browserName}-${width}.png`)});
   continue;
  }
  assert(visible,'UPLOADED_FILE_PREVIEW_ACTION_REQUIRED');await preview.click();
  await page.locator('.hwp-page-view__image').waitFor();assert(await page.locator('.hwp-page-view__image').evaluate(image=>image.complete&&image.naturalWidth>0),'HWP_ORIGINAL_IMAGE_REQUIRED');
  await page.screenshot({path:resolve(evidence,`hwp-${browserName}-${width}.png`)});
  await page.getByRole('button',{name:'닫기',exact:true}).click();assert(await preview.evaluate(button=>document.activeElement===button),'PREVIEW_OPENER_FOCUS_REQUIRED');
  results.push({browserName,width,case:'HWP original before submit and focus restore',passed:true});
  await page.evaluate(()=>window.showAttachment('hwpx','dialog'));await page.locator('.hwp-page-view__image').waitFor();
  assert(await page.locator('.hwp-page-view__image').evaluate(image=>image.complete&&image.naturalWidth>0),'HWPX_ORIGINAL_IMAGE_REQUIRED');
  results.push({browserName,width,case:'HWPX original pages',passed:true});
  await page.getByRole('button',{name:'다음 쪽',exact:true}).click();await page.getByRole('img',{name:'지원.hwpx 2쪽',exact:true}).waitFor();
  await page.getByRole('button',{name:'이전 쪽',exact:true}).click();await page.getByRole('img',{name:'지원.hwpx 1쪽',exact:true}).waitFor();
  results.push({browserName,width,case:'HWPX multiple pages and return',passed:true});
  await page.screenshot({path:resolve(evidence,`hwpx-${browserName}-${width}.png`)});
  await page.getByRole('button',{name:'닫기',exact:true}).click();await page.evaluate(()=>window.showAttachment('broken','dialog'));
  await page.getByRole('button',{name:'한글 파일 다시 열기',exact:true}).waitFor();
  await page.getByRole('button',{name:'한글 파일 다시 열기',exact:true}).click();await page.getByRole('button',{name:'한글 파일 다시 열기',exact:true}).waitFor();
  results.push({browserName,width,case:'invalid HWP finite failure and retry',passed:true});
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  for(const format of ['png','pdf','docx']){
   await page.evaluate(value=>window.showAttachment(value,'picker'),format);await page.waitForFunction(value=>document.querySelector('main')?.dataset.file===value,format);
   await page.getByLabel('사진·문서 첨부',{exact:true}).setInputFiles({name:`지원.${format}`,mimeType:'application/octet-stream',buffer:source.get(format)});
   await page.getByRole('button',{name:`지원.${format} 미리보기`,exact:true}).click();
   if(format==='png'){await page.getByRole('img',{name:'지원.png',exact:true}).waitFor();assert(await page.getByRole('img',{name:'지원.png',exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0),'PNG_ORIGINAL_REQUIRED');}
   if(format==='pdf')await page.getByTitle('원본 PDF').waitFor();
   if(format==='docx'){
    const frame=page.frameLocator('dialog iframe');await frame.getByText('회의 지원 원본 7319',{exact:true}).waitFor();
    assert(await page.locator('dialog iframe').getAttribute('sandbox')==='allow-scripts','DOCX_SANDBOX_REQUIRED');
    assert(await frame.locator('body').evaluate(()=>{try{void parent.document.body;return false;}catch{return true;}}),'DOCX_PARENT_ISOLATION_REQUIRED');
    assert(await frame.locator('a[href]').count()===0,'DOCX_LINKS_DISABLED');
   }
   results.push({browserName,width,case:`${format.toUpperCase()} original before submission`,passed:true});
   await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
  }
  await page.clock.install();
  await page.evaluate(()=>{window.originalWorker=window.Worker;window.Worker=class {postMessage(){} terminate(){}};window.showAttachment('hwp','dialog');});
  await page.getByText('한글 파일 여는 중…',{exact:true}).waitFor();await page.clock.fastForward(30001);
  await page.getByRole('button',{name:'한글 파일 다시 열기',exact:true}).waitFor();
  await page.evaluate(()=>{window.Worker=window.originalWorker;});await page.getByRole('button',{name:'한글 파일 다시 열기',exact:true}).click();
  await page.locator('.hwp-page-view__image').waitFor();
  results.push({browserName,width,case:'unresponsive worker times out and retry recovers',passed:true});
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.route('**/api/attachments/hwp/render-source',route=>route.fulfill({status:503,json:{errorCode:'SAVE_FAILED',message:'원본 조회 실패'}}),{times:1});
  await page.evaluate(()=>window.showAttachment('hwp','dialog'));await page.getByRole('button',{name:'원본 다시 불러오기',exact:true}).waitFor();
  await page.getByRole('button',{name:'원본 다시 불러오기',exact:true}).click();await page.locator('.hwp-page-view__image').waitFor();
  results.push({browserName,width,case:'source request failure retry recovers',passed:true});
  await page.getByRole('button',{name:'닫기',exact:true}).click();await page.evaluate(()=>window.showAttachment('hwp','restored'));
  await page.getByRole('button',{name:'복원.hwp 미리보기',exact:true}).click();await page.locator('.hwp-page-view__image').waitFor();
  results.push({browserName,width,case:'restored metadata previews without local File',passed:true});
  assert(errors.length===0,`PAGE_ERRORS ${errors.join('; ')}`);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PAGE_OVERFLOW');
 }catch(error){results.push({browserName,width,case:'execution',passed:false,error:error.message});await page.screenshot({path:resolve(evidence,`failure-${browserName}-${width}.png`)}).catch(()=>{});}
 finally{await browser.close();}
}
await writeFile(resolve(evidence,`${mode}-results.json`),JSON.stringify({mode,results},null,2)+'\n');
console.log(JSON.stringify({mode,passed:results.filter(row=>row.passed).length,failed:results.filter(row=>!row.passed).length,results}));
if(mode!=='red'&&results.some(row=>!row.passed))process.exitCode=1;
