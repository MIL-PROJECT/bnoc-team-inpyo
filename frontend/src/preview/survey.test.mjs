import test from 'node:test';
import assert from 'node:assert/strict';
import { identities } from '../../../mock-provider/server.mjs';
const originalTeams=['무선반','유선반','전장반(전산장비)','정체반','암호반'];
const originalSubjects=['team-wireless','team-wired','team-display','team-info','team-crypto'];
// Test input only: product preview never creates identities or completes login.
function choosePreviewRole(role) {
  const subject=role==='team'?'team-wireless':role==='admin'?'access-admin':role;
  const identity=identities.find(item=>item.subject===subject);assert.ok(identity);
  const teamIndex=originalSubjects.indexOf(subject),teamId=originalTeams[teamIndex];
  const actor={id:subject,role:teamIndex>=0?'team':subject==='access-admin'?'admin':subject,displayName:identity.label,department:teamId??'',...(teamId?{teamId}:{}),...(subject==='access-admin'?{accessAdmin:true}:{})};
  bindPreviewContext(actor,originalTeams);return actor;
}
import { statusGuide } from './statusDescriptions.mjs';
import { bindPreviewContext, visibleRequests, readRequest } from './surveyStore.mjs';
test('status guide identifies current position without inventing completed history or a next assignee',()=>{
  const request=statusGuide('작업 중'),work=statusGuide('작업 중',true);
  assert.equal(request.currentIndex,2,'REQUEST_CURRENT_STEP');assert.equal(work.currentIndex,1);
  assert.deepEqual(request.flow.map(step=>step.status),['대기','배정','작업 중','완료']);
  assert.deepEqual(work.flow.map(step=>step.status),['배정','작업 중','완료']);
  assert.doesNotMatch(statusGuide('대기').summary,/배정 전|처음 접수|미배정/,'WAIT_CAN_INCLUDE_RETURNED_WORK');
  assert.match(statusGuide('완료',true).summary,/이 작업/);assert.doesNotMatch(statusGuide('완료',true).summary,/모두/);
  assert.match(statusGuide('완료').summary,/모두/);
  for(const status of ['문서 대기','반환','취소','기각']){const guide=statusGuide(status);assert.equal(guide.kind,'exception');assert.equal(guide.currentIndex,-1);assert.deepEqual(guide.flow,[]);}
  const report=statusGuide('완료',false,true);assert.equal(report.kind,'afterAction');assert.deepEqual(report.flow,[],'AFTER_ACTION_MUST_NOT_INVENT_PHASES');assert.match(report.summary,/이미 끝낸 작업/);
  assert.equal(statusGuide('알 수 없는 상태').kind,'unknown');
});
test('business preview scope follows the authenticated actor',()=>{
  choosePreviewRole('requester');
  assert.ok(!visibleRequests().some(row=>row.number==='105'));
  assert.throws(()=>readRequest('105'),/NOT_FOUND/);
  choosePreviewRole('admin'); assert.equal(visibleRequests().length,0);
});
test('multi-team request shows each current team its own work status',()=>{
  choosePreviewRole('team-wireless');
  assert.equal(readRequest('101').status,'작업 중');
  assert.equal(readRequest('101').myTeamWorkStatus,'작업 중');
  choosePreviewRole('team-wired');
  assert.equal(readRequest('101').status,'작업 중');
  assert.equal(readRequest('101').myTeamWorkStatus,'배정','TEAM_WORK_STATUS_INDEPENDENT');
  assert.equal(searchRequests(visibleRequests(),{teamId:'유선반'}).some(row=>row.number==='101'),true);
  choosePreviewRole('team-display');
  assert.throws(()=>readRequest('101'),/NOT_FOUND/,'MULTI_TEAM_BOUNDARY');
  assert.equal(visibleRequests().some(row=>row.number==='101'),false);
});

import { initialDraft, requestOptions, validateDraft } from './requestForm.mjs';
import { savePreviewRequest } from './surveyStore.mjs';
test('request form keeps the existing single classification and freeform detail contract',()=>{
  const draft={...initialDraft(),systemType:'인트라넷',resourceType:'전화',workType:'고장',detail:'전화 연결 불가',location:'작업 위치',contact:'000-0000'};
  assert.deepEqual(validateDraft(draft,'requester'),{});
  assert.ok(validateDraft({...draft,systemType:''},'requester').systemType);
  assert.ok(validateDraft({...draft,detail:''},'requester').detail);
  choosePreviewRole('requester');const number=savePreviewRequest(draft);const saved=readRequest(number);
  assert.equal(saved.detail,draft.detail);assert.equal(saved.resourceType,'전화');assert.equal(saved.workType,'고장');
  assert.equal('taskInfo' in saved,false,'NO_EXPANDED_REQUEST_SCHEMA');
  assert.equal('formPolicyVersion' in saved,false,'NO_VERSIONED_FORM_POLICY');
});

import { canManageTeam } from './surveyStore.mjs';

import { searchRequests } from './search.mjs';
test('partial search combines filters, treats wildcard characters literally and deduplicates by request',()=>{
  choosePreviewRole('requester');
  assert.equal(searchRequests(visibleRequests(),{q:'마이크'}).length,1);
  assert.equal(searchRequests(visibleRequests(),{q:'마이크',status:'완료'}).length,0);
  assert.equal(searchRequests(visibleRequests(),{q:'%'}).length,0);
  assert.equal(searchRequests(visibleRequests(),{q:'범위 밖'}).length,0);
  assert.equal(searchRequests([{number:'1',title:'동일',detail:'마이크',registeredAt:'2026-10-22',documents:[{id:'d',name:'문서',status:'ready',blocks:[{text:'마이크'}],metadata:[]}]}],{q:'마이크'}).length,1);
});

import { readDocument, retryDocument } from './surveyStore.mjs';
test('document content and metadata are searchable only in current visible attachments',()=>{
  choosePreviewRole('requester');
  const matches=searchRequests(visibleRequests(),{q:'정기회의'});
  assert.equal(matches.length,2);assert.ok(matches[0].matches.some(match=>match.source.startsWith('문서 정보')));
  assert.equal(readDocument('101','doc1').metadata.find(field=>field.label==='장소').values.length,2);
  assert.throws(()=>retryDocument('101','doc1'),/FORBIDDEN/);
  retryDocument('102','state2');assert.equal(readDocument('102','state2').status,'pending');
  choosePreviewRole('admin');assert.throws(()=>readDocument('101','doc1'),/NOT_FOUND/);
});

import { readTeamManagement, saveTeamManagement } from './surveyStore.mjs';
test('team management uses own team role, never a designated-manager flag',()=>{
  choosePreviewRole('team');assert.equal(canManageTeam('유선반'),false,'TEAM_OWN_ONLY');saveTeamManagement('roster','무선반','',[]);
  assert.throws(()=>saveTeamManagement('roster','유선반','',[]),/FORBIDDEN/);
  choosePreviewRole('bnoc');assert.throws(()=>saveTeamManagement('personnel','무선반','2026-10-22',[]),/FORBIDDEN/);
  choosePreviewRole('requester');assert.throws(()=>readTeamManagement('roster','무선반',''),/FORBIDDEN/);
  choosePreviewRole('admin');assert.throws(()=>saveTeamManagement('roster','무선반','',[]),/FORBIDDEN/);
});

import { draftFromRequest } from './requestForm.mjs';
test('editing preserves the existing detail, classification, preferences and attachments',()=>{
  choosePreviewRole('requester');const draft={...initialDraft(),systemType:'인트라넷',resourceType:'PC',workType:'고장',detail:'화면 오류',location:'위치',contact:'000-0000',preference1Date:'2026-10-23',preference1Period:'AM',preference2Date:'2026-10-24',preference2Period:'PM',documentRef:'문서 참조'};
  const number=savePreviewRequest(draft);const restored=draftFromRequest(readRequest(number));assert.deepEqual(validateDraft(restored,'requester'),{});assert.equal(restored.detail,draft.detail);assert.equal(restored.resourceType,draft.resourceType);assert.equal(restored.preference1Date,draft.preference1Date);assert.equal(restored.preference2Period,draft.preference2Period);savePreviewRequest({...restored,detail:'화면 재점검'},false,number);assert.equal(readRequest(number).detail,'화면 재점검');assert.equal('taskInfo' in readRequest(number),false);
});

test('search uses existing request content and classifications without expanded target data',()=>{
  const row={number:'1',title:'요청',detail:'화면 불량',resourceType:'PC',workType:'고장',registeredAt:'2026-10-22'};
  assert.equal(searchRequests([row],{q:'화면 불량'}).length,1);
  assert.equal(searchRequests([row],{q:'PC'}).length,1);
  assert.equal(searchRequests([{...row,detail:'내용',taskInfo:{items:[{symptom:'화면 불량'}]}}],{q:'화면 불량'}).length,0);
});

test('meeting titles follow category and added attachments retain distinct references',()=>{
  choosePreviewRole('requester');const input={...initialDraft(),category:'회의 지원',meetingType:'일반회의',detail:'음향 지원',location:'회의실',contact:'000-0000',files:[new File(['첫 첨부'],'first.txt',{type:'text/plain'})]};
  const number=savePreviewRequest(input);assert.equal(readRequest(number).title,'일반회의 요청');
  savePreviewRequest({...draftFromRequest(readRequest(number)),files:[new File(['다음 첨부'],'second.txt',{type:'text/plain'})]},false,number);
  const docs=readRequest(number).documents;assert.equal(new Set(docs.map(doc=>doc.id)).size,2);assert.equal(readDocument(number,docs[1].id).name,'second.txt');
});

test('request form preserves existing classification choices',()=>{assert.deepEqual(requestOptions.systemTypes,['인트라넷','인터넷','AFCCS','KJCCS','기타']);});

test('business preview preserves all five authenticated team identities and every department boundary',()=>{
  const canonical=identities.filter(identity=>identity.subject.startsWith('team-'));
  assert.deepEqual(canonical.map(identity=>identity.subject),originalSubjects,'FIVE_ORIGINAL_TEAM_IDENTITIES');
  const ids=[];
  for(const subject of originalSubjects) {
    const actor=choosePreviewRole(subject);ids.push(actor.id);
    for(const teamId of originalTeams) {
      assert.equal(canManageTeam(teamId),teamId===actor.teamId,'AUTHENTICATED_TEAM_BOUNDARY');
      if(teamId===actor.teamId)saveTeamManagement('roster',teamId,'',[]);
      else assert.throws(()=>saveTeamManagement('roster',teamId,'',[]),/FORBIDDEN/);
    }
    const report={...initialDraft(),systemType:'인트라넷',resourceType:'PC',workType:'고장',detail:'화면 오류',location:'위치',contact:'000-0000',actualRequesterText:'요청자',actualStartedAt:'2026-10-22T09:00',reason:'선조치 후 보고',completedAt:'2026-10-22T10:00',completionConfirmed:true};
    const number=savePreviewRequest(report,true);assert.equal(readRequest(number).teamId,actor.teamId);
  }
  assert.equal(new Set(ids).size,5);
});

test('representative documents use genuine HWP with PDF alongside',async()=>{
 const {documentFixtures}=await import('./documentFixtures.mjs');
 const {readFile}=await import('node:fs/promises');
 const documents=documentFixtures('101');assert.equal(documents[0].format,'hwp','PRIMARY_DOCUMENT_IS_HWP');
 assert.match(documents[0].name,/\.hwp$/);assert.ok(documents.some(document=>document.format==='pdf'));
 assert.ok(documentFixtures('102').every(document=>document.name.endsWith('.hwp')));
 const bytes=await readFile(new URL('./fixtures/support.hwp',import.meta.url));
 assert.equal(bytes.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1','HWP_BINARY_NOT_RENAMED_DOCX');
 assert.ok(bytes.includes(Buffer.from('FileHeader','utf16le')));
});
