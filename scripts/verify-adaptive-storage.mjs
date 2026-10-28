import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {testEnvironment} from './bnoc-runtime.mjs';
const env=await testEnvironment(),base=env.BNOC_TEST_URL;
assert.equal(base,'http://127.0.0.1:8083');
const output=new URL('../runtime/evidence/adaptive-intake-20261027/storage/',import.meta.url);await mkdir(output,{recursive:true});
const cookies=new Map();let csrf='';
async function call(method,path,body){
 const headers={Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; '),Origin:base,'X-CSRF-Token':csrf};if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
 for(const cookie of response.headers.getSetCookie()){const[key,...value]=cookie.split(';')[0].split('=');cookies.set(key,value.join('='));}
 assert.equal(response.status,200,`${method} ${path}`);
 return response;
}
const get=async path=>(await (await call('GET',path)).json()).data;
async function login(){const challenge=await get('/api/auth/start');csrf=challenge.csrfToken;const issued=await fetch(env.BNOC_MOCK_URL+'/identity/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'requester',loginAttempt:challenge.loginAttempt,browserBinding:new URL(challenge.providerUrl).searchParams.get('browserBinding')})});await call('POST','/api/auth/complete',{ticket:(await issued.json()).ticket,loginAttempt:challenge.loginAttempt});csrf=(await get('/api/session')).csrfToken;}
await login();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(process.argv[2]==='seed'){
 const file=new FormData();file.append('file',new Blob(['adaptive persistent bytes'],{type:'text/plain'}),'adaptive-persistence.txt');
 const uploaded=await (await call('POST','/api/attachments?resourceKind=request',file)).json();const attachment=uploaded.data??uploaded;
 const items=['인트라넷','인터넷'].map((systemType,index)=>({id:randomUUID(),kind:'회선',workType:'신설',quantity:1,location:`보존 위치 ${index+1}`,systemType,detail:'서버 재시작 보존',attachmentIds:index===1?[attachment.id]:[]}));
 const created=await (await call('POST','/api/commands',{type:'createRequest',operationId:randomUUID(),payload:{category:'장비/체계',intakeVersion:1,itemQuantities:{회선:2},requestItems:items,contact:'000-1234',attachments:[attachment]}})).json();assert.ok(created.ok);
 const detail=await get(`/api/requests/${created.requestNumber}`);assert.equal(detail.requestItems.length,2);
 await writeFile(new URL('before.json',output),JSON.stringify({number:created.requestNumber,items:detail.requestItems,totals:detail.itemQuantities,fileId:attachment.id,fileSha:sha(Buffer.from('adaptive persistent bytes'))},null,2));console.log('Structured request and linked attachment seeded in verification DB.');
}else if(process.argv[2]==='check'){
 const before=JSON.parse(await readFile(new URL('before.json',output),'utf8')),detail=await get(`/api/requests/${before.number}`);
 assert.deepEqual(detail.requestItems,before.items,'ALL_INTAKE_ITEMS_SURVIVE_MYSQL_RESTART');assert.deepEqual(detail.itemQuantities,before.totals);
 const bytes=Buffer.from(await (await call('GET',`/api/attachments/${before.fileId}`)).arrayBuffer());assert.equal(sha(bytes),before.fileSha);
 await writeFile(new URL('result.json',output),JSON.stringify({requestNumber:before.number,itemCount:detail.requestItems.length,itemsEqual:true,quantitiesEqual:true,attachmentBytesEqual:true},null,2));console.log('All target rows, quantities, references and attachment bytes survived restart.');
}else throw new Error('Choose seed or check');
