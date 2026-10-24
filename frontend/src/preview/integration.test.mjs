import test from 'node:test';
import assert from 'node:assert/strict';
import {initialDraft,draftFromRequest,validateDraft} from './requestForm.mjs';
import {bindPreviewContext,savePreviewRequest,readRequest} from './surveyStore.mjs';
const teams=['무선반','유선반','전장반(전산장비)','정체반','암호반'];
const draft=()=>({...initialDraft(),systemType:'인트라넷',resourceType:'PC',workType:'고장',detail:'화면 점검',location:'작업 위치',contact:'000-0000'});
test('preview preserves main schedule preferences through edit and memory save',()=>{
 const preferences=[{rank:1,date:'2026-10-25',period:'AM'},{rank:2,date:'2026-10-26',period:'PM'}];
 const original={...draft(),category:'장비/체계',schedulePreferences:preferences};
 const input=draftFromRequest(original);assert.equal(input.preference2Period,'PM','SECOND_PREFERENCE_MUST_SURVIVE');
 bindPreviewContext({id:'requester',role:'requester',displayName:'요청자'},teams);
 const number=savePreviewRequest(input);assert.deepEqual(readRequest(number).schedulePreferences,preferences);
});
test('preview preserves optional preferences and rejects partial or second-only entries',()=>{
 assert.deepEqual(validateDraft(draft(),'requester'),{});
 const second={...draft(),preference2Date:'2026-10-25',preference2Period:'AM'};
 assert.ok(validateDraft(second,'requester').preference1Date,'SECOND_PREFERENCE_REQUIRES_FIRST');
 assert.ok(validateDraft({...draft(),preference1Date:'2026-10-25'},'requester').preference1Period);
});
test('preview after-action retains actual start completion and reason without desired dates',()=>{
 bindPreviewContext({id:'team-wired',role:'team',teamId:'유선반'},teams);
 const input={...draft(),actualRequesterText:'요청자',actualStartedAt:'2026-10-23T09:15',completedAt:'2026-10-23T10:30',reason:'선조치 후 보고',completionConfirmed:true,preference1Date:'2026-10-25',preference1Period:'AM'};
 assert.deepEqual(validateDraft(input,'team',true),{});
 assert.ok(validateDraft({...input,actualStartedAt:''},'team',true).actualStartedAt,'AFTER_ACTION_START_REQUIRED');
 assert.ok(validateDraft({...input,reason:''},'team',true).reason,'AFTER_ACTION_REASON_REQUIRED');
 assert.ok(validateDraft({...input,actualStartedAt:'2026-10-23T11:00'},'team',true).completedAt,'COMPLETION_MUST_FOLLOW_ACTUAL_START');
 const record=readRequest(savePreviewRequest(input,true));assert.equal(record.actualStartedAt,'2026-10-23T00:15:00.000Z');assert.equal(record.actualCompletedAt,'2026-10-23T01:30:00.000Z');assert.equal(record.reason,input.reason);assert.deepEqual(record.schedulePreferences,[]);
});
