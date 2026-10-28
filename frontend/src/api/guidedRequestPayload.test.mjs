import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPayload,afterActionPayload} from './requestPayload.mjs';
import {createIntakeState,chooseIntakeIntent,chooseIntakeSupport,changeIntakeCount,intakeFromRequest} from '../app/intakeModel.mjs';
import {requestReuseFields} from '../app/requestReuse.mjs';
const base={category:'장비/체계',systemType:'OLD',resourceType:'PC',workType:'고장',detail:'OLD',location:'OLD',contact:'1234',equipmentId:'OLD-MODEL',attachments:[]};
test('switching purpose preserves both branches but submits only the active branch and files',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=changeIntakeCount(state,'PC',1);
 Object.assign(state.items[0],{location:'장비 위치',symptom:'작동이 멈췄어요',attachmentIds:['device-file']});
 state=chooseIntakeSupport(chooseIntakeIntent(state,'지원'),'회의 지원');
 state.meeting={meetingType:'화상회의',videoPlatform:'KJCCS',detail:'회의 지원 내용',location:'회의 장소',attachmentIds:['meeting-file']};
 const input={...base,attachments:[{id:'device-file'},{id:'meeting-file'}]};
 const meeting=requestPayload({...input,guidedDraft:state},'requester');
 assert.equal(meeting.category,'회의 지원');assert.equal(meeting.requestItems,undefined,'MEETING_MUST_EXCLUDE_HIDDEN_EQUIPMENT');assert.equal(meeting.itemQuantities,undefined);assert.deepEqual(meeting.attachments,[{id:'meeting-file'}],'MEETING_MUST_EXCLUDE_HIDDEN_FILES');
 state=chooseIntakeIntent(state,'고장');const equipment=requestPayload({...input,guidedDraft:state},'requester');
 assert.equal(equipment.category,'장비/체계');assert.deepEqual(equipment.attachments,[{id:'device-file'}],'EQUIPMENT_MUST_EXCLUDE_HIDDEN_FILES');assert.equal(equipment.subcategories.meetingType,undefined);assert.ok(!JSON.stringify(equipment).includes('회의 지원 내용'));
});
test('new installation serializes only active items, model and unrelated files are excluded',()=>{
 const guidedDraft=changeIntakeCount(createIntakeState(),'프린터',1);Object.assign(guidedDraft.items[0],{workType:'신설',location:'설치 장소',detail:'새 설치',equipmentId:'HIDDEN-MODEL',symptom:'OLD-FAULT',attachmentIds:['selected']});
 const payload=requestPayload({...base,guidedDraft,attachments:[{id:'selected'},{id:'unselected'}]},'requester');
 assert.equal(payload.intakeVersion,1);assert.equal(payload.requestItems.length,1);assert.equal(payload.requestItems[0].equipmentId,undefined);assert.equal(payload.requestItems[0].symptom,undefined);assert.equal(payload.equipmentId,undefined);assert.deepEqual(payload.attachments,[{id:'selected'}]);assert.ok(!JSON.stringify(payload).includes('OLD'));assert.ok(!JSON.stringify(payload).includes('HIDDEN'));
});
test('reuse gives every target a new id and strips files while editing can retain references',()=>{
 const source={category:'장비/체계',requestItems:[{id:'original',kind:'회선',quantity:2,workType:'신설',location:'기존 위치',detail:'연결',attachmentIds:['old-file']}],attachments:[{id:'old-file'}]};
 const copy=requestReuseFields(source);assert.notEqual(copy.guidedDraft.items[0].id,'original');assert.deepEqual(copy.guidedDraft.items[0].attachmentIds,[]);assert.equal(copy.attachments,undefined);assert.equal(copy.schedulePreferences,undefined);assert.equal(copy.requesterRef,undefined);
 const edit=intakeFromRequest(source,{keepAttachments:true});assert.equal(edit.items[0].id,'original');assert.deepEqual(edit.items[0].attachmentIds,['old-file']);
});
