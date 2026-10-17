import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:8083';
const cookies = new Map();
let csrf = '';
async function request(method, path, body) {
  const headers = { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') };
  if (method !== 'GET') Object.assign(headers, { Origin: base, 'X-CSRF-Token': csrf });
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  for (const cookie of response.headers.getSetCookie()) { const [key,...value] = cookie.split(';')[0].split('='); cookies.set(key,value.join('=')); }
  assert.equal(response.status,200,`${method} ${path}`);
  return response;
}
const challenge = (await (await request('GET','/api/auth/start')).json()).data;
csrf = challenge.csrfToken;
const proof = await fetch('http://127.0.0.1:8082/identity/issue', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'requester',loginAttempt:challenge.loginAttempt,browserBinding:new URL(challenge.providerUrl).searchParams.get('browserBinding')}) });
assert.equal(proof.status,200);
await request('POST','/api/auth/complete',{ticket:(await proof.json()).ticket,loginAttempt:challenge.loginAttempt});
csrf = (await (await request('GET','/api/session')).json()).data.csrfToken;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === 'seed') {
  const content = `team persistence ${randomUUID()}`;
  const form = new FormData(); form.set('file',new Blob([content],{type:'text/plain'}),'team-persistence.txt');
  const file = (await (await request('POST','/api/attachments?resourceKind=request',form)).json()).data;
  const result = await (await request('POST','/api/commands',{type:'createRequest',operationId:randomUUID(),payload:{category:'장비/체계',subcategories:{systemType:'인트라넷',resourceType:'PC',workType:'지원'},detail:content,location:'요청 위치',contact:'000-0000',attachments:[{id:file.id}]}})).json();
  assert.equal(result.ok,true);
  await writeFile('/evidence/persistence-seed.json',JSON.stringify({number:result.requestNumber,file:file.id,content,sha256:hash(content)}));
} else if (process.argv[2] === 'check') {
  const saved = JSON.parse(await readFile('/evidence/persistence-seed.json','utf8'));
  const detail = (await (await request('GET',`/api/requests/${saved.number}`)).json()).data;
  assert.equal(detail.detail,saved.content);
  assert.equal(detail.attachments[0].id,saved.file);
  assert.equal(hash(Buffer.from(await (await request('GET',`/api/attachments/${saved.file}`)).arrayBuffer())),saved.sha256);
  await writeFile('/evidence/persistence-result.json',JSON.stringify({passed:true,requestNumber:saved.number,attachmentSha256:saved.sha256,checkedAt:new Date().toISOString()}));
} else throw new Error('Expected seed or check');
