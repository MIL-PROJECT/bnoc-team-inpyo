import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const evidence=process.env.BNOC_QUALITY_PUBLIC_EVIDENCE_DIR||'runtime/evidence/ui-quality-20261027/public';await mkdir(evidence,{recursive:true});
const services=JSON.parse(await readFile(process.env.BNOC_QUALITY_PUBLIC_STATE||'.local/bnoc-public/services.json','utf8'));
const base=services.url;assert(base?.startsWith('https://'));
const report={url:base,checks:[],businessWrites:[],errors:[]};
try{
 const response=await fetch(base,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);
 const html=await response.text(),local=await readFile('frontend/dist/index.html','utf8');
 const asset=text=>text.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
 assert(asset(html)&&asset(html)===asset(local),'public assets must match the final local build');
 const anonymous=await fetch(base+'/api/session',{signal:AbortSignal.timeout(20000)});assert.equal(anonymous.status,401);
 report.checks.push('public home 200, anonymous API 401, final frontend asset matches');
 report.artifactSha256=createHash('sha256').update(await readFile('backend/build/libs/bnoc-server-1.0.0.jar')).digest('hex');
 assert.equal(report.artifactSha256,services.artifactSha256,'public runtime must use final JAR');
 const browser=await chromium.launch();
 try{for(const subject of ['bnoc','team-wireless','requester','access-admin']){
  const context=await browser.newContext({viewport:{width:1366,height:768},locale:'ko-KR'});const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>report.errors.push(subject+': '+error.message));
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/')&&!path.startsWith('/api/auth/')&&!['GET','HEAD'].includes(request.method()))report.businessWrites.push({subject,path,method:request.method()});});
  await page.goto(base+'/operations');const popupReady=page.waitForEvent('popup');await page.getByRole('button',{name:'SSO 로그인',exact:true}).click();const popup=await popupReady;
  await popup.getByLabel('사용자 역할',{exact:true}).selectOption(subject);await popup.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.getByRole('heading',{name:'부서별 작업 현황',exact:true})).toBeVisible();
  await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),subject+': public overflow');
  assert(!/\d+\/\d+ 정상|부재 없음|조회 결과 · 조건:/.test(await page.locator('main').innerText()));
  if(subject==='bnoc')await page.screenshot({path:evidence+'/bnoc-operations.png'});
  for(const route of ['operations-status','night-duty',...(subject==='bnoc'||subject==='team-wireless'?['personnel','roster']:[])]){
   await page.goto(base+'/'+route);await expect(page.locator('main h1')).toBeVisible();await expect(page.getByText('불러오는 중…',{exact:true})).toHaveCount(0);
   assert(!/\d+\/\d+ 정상|부재 없음|조회 결과 · 조건:/.test(await page.locator('main').innerText()));
   if(route==='night-duty'){
    await expect(page.getByRole('heading',{name:'당직 야간근무 현황',exact:true})).toBeVisible();
    const duty=page.locator('.duty-daily-summary');
    for(const seat of ['당직사관','A대대 일직사관','B대대 일직사관'])await expect(duty.getByRole('region',{name:seat,exact:true})).toBeVisible();
    const current=(await (await page.request.get(base+'/api/session')).json()).data;
    for(const team of current.teams)await expect(duty.getByRole('region',{name:team+' 야간근무',exact:true})).toBeVisible();
    if(subject==='bnoc')await page.screenshot({path:evidence+'/bnoc-duty-slots.png'});
   }
   if(route==='roster'){
    const order=await page.locator('.personnel-department tbody[aria-label] th[scope=rowgroup]').allTextContents();
    const groups=order.map(text=>text.split(' ')[0]);const firstSoldier=groups.indexOf('병'),firstOfficer=groups.indexOf('간부');
    if(firstSoldier>=0&&firstOfficer>=0)assert(firstOfficer<firstSoldier,'public officer group precedes soldier');
   }
   if(subject==='bnoc'&&route==='operations-status')await page.screenshot({path:evidence+'/bnoc-operations-status.png'});
  }
  report.checks.push(subject+': normal public SSO, overview, operations, duty and permitted roster reads');await context.close();
 }}finally{await browser.close();}
 assert.equal(report.businessWrites.length,0,'public smoke must be read-only');
}catch(error){report.errors.push(error.stack||String(error));process.exitCode=1;}
await writeFile(evidence+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
