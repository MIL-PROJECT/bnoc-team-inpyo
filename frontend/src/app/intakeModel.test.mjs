import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeState,chooseIntakeIntent,chooseIntakeSupport,changeIntakeCount,startIntake,answerIntake,updateIntakeField,backIntake,navigateIntake,editIntakeField,splitIntakeItem,cancelIntakeSplit,removeIntakeItem,intakePayload,intakeFromRequest,validGuidedDraft } from './intakeModel.mjs';
// Existing low-level cases exercise legacy drafts without a chosen purpose.
const choose=(kind,count=1)=>{let state={...createIntakeState(),step:'pick'};for(let n=0;n<count;n++)state=changeIntakeCount(state,kind,1);return startIntake(state);};
const answer=(state,field,value)=>answerIntake(state,field,value);
const line=()=>{let state=choose('회선',2);for(const [key,value] of [['workType','신설'],['location','첫 위치'],['systemType','인트라넷'],['detail','두 회선 설치']])state=answer(state,key,value);return state;};
test('required path skips all unknown optional technology and per-target confirmations',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=startIntake(changeIntakeCount(state,'PC',1));
 state=answerIntake(state,'location','사무실');assert.equal(state.step,'symptom','OPTIONAL_TECH_MUST_NOT_BLOCK_REQUIRED_PATH');
 state=answerIntake(state,'symptom','증상을 잘 모르겠어요');assert.equal(state.step,'contact','NO_PER_TARGET_CONFIRMATION');
 assert.equal(intakePayload(state).requestItems[0].systemType,undefined);assert.equal(intakePayload(state).requestItems[0].equipmentId,undefined);
});
test('required answers advance between kinds and known common details return directly to review',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'신설');state=changeIntakeCount(changeIntakeCount(state,'PC',1),'프린터',1);state=startIntake(state);
 state=answerIntake(state,'location','첫 위치','review');state=answerIntake(state,'detail','첫 설치','review');assert.equal(state.step,'location');assert.equal(state.activeId,state.items[1].id);
 state=answerIntake(state,'location','다른 위치','review');state=answerIntake(state,'detail','다른 설치','review');assert.equal(state.step,'review');
 assert.deepEqual(state.items.map(item=>item.location),['첫 위치','다른 위치']);
});
test('one optional edit returns to its original review without touring other optional fields',()=>{
 let state=intakeFromRequest({requestItems:[{kind:'PC',quantity:1,workType:'고장',location:'위치',symptom:'작동이 멈췄어요'}]});state.step='review';
 state=editIntakeField(state,'equipmentId',state.activeId,'review');state=answerIntake(state,'equipmentId','KNOWN-MODEL','review');
 assert.equal(state.step,'review','OPTIONAL_EDIT_MUST_RETURN_TO_ORIGIN');assert.equal(state.items[0].equipmentId,'KNOWN-MODEL');
 state=editIntakeField(state,'symptom',state.activeId,'review');state=answerIntake(state,'symptom','직접 설명할게요','review');assert.equal(state.step,'detail');
 state=answerIntake(state,'detail','필수 직접 설명','review');assert.equal(state.step,'review');
});
test('answered flags cannot skip cleared required values or force legacy optional tours',()=>{
 let state=intakeFromRequest({requestItems:[{kind:'PC',quantity:1,workType:'신설',location:'기존 위치',detail:'기존 내용'}]});
 state=updateIntakeField(state,'location','   ');state=startIntake(state);assert.equal(state.step,'location','CLEARED_REQUIRED_VALUE_MUST_BE_ASKED');
 state=answerIntake(state,'location','정정 위치');state=navigateIntake(state,'systemType');state=answerIntake(state,'systemType','unknown');assert.equal(state.step,'contact');
});
test('explicit extra information opt-in visits remaining active fields only for the current target',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=changeIntakeCount(changeIntakeCount(state,'PC',1),'전화',1);state=startIntake(state);
 state=answerIntake(state,'location','위치');state.returnTo='optional';state=answerIntake(state,'symptom','오류가 표시돼요');assert.equal(state.step,'systemType','EXPLICIT_EXTRAS_MUST_REACH_OPTIONAL_FIELDS');
 state=answerIntake(state,'systemType','인트라넷');assert.equal(state.step,'errorCode');state=answerIntake(state,'errorCode','ERR-KNOWN');assert.equal(state.step,'equipmentId');state=answerIntake(state,'equipmentId','MODEL-KNOWN');
 assert.equal(state.step,'location');assert.equal(state.activeId,state.items[1].id);assert.equal(state.returnTo,null,'EXTRAS_MUST_NOT_PROPAGATE_TO_NEXT_TARGET');
 state=answerIntake(state,'location','전화 위치');state=answerIntake(state,'symptom','작동이 멈췄어요');assert.equal(state.step,'contact');
});
test('opted-in IP phone reveals its network and Back preserves opt-in until completion',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=startIntake(changeIntakeCount(state,'전화',1));state=answerIntake(state,'location','전화 위치');state.returnTo='optional';state=answerIntake(state,'symptom','작동이 멈췄어요');
 assert.equal(state.step,'phoneType');state=answerIntake(state,'phoneType','IP');assert.equal(state.step,'systemType');state=backIntake(state);assert.equal(state.step,'phoneType');assert.equal(state.returnTo,'optional');
 state=answerIntake(state,'phoneType','아날로그');assert.equal(state.step,'contact');assert.equal(state.returnTo,null);assert.equal(intakePayload(state).requestItems[0].systemType,undefined);
});
test('opting into already answered optional fields completes without another tour or loop',()=>{
 let state=intakeFromRequest({requestItems:[{kind:'PC',quantity:1,workType:'고장',location:'위치',symptom:'오류가 표시돼요',systemType:'인트라넷',errorCode:'ERR',equipmentId:'MODEL'}]});state=navigateIntake(state,'symptom');state.returnTo='optional';
 state=answerIntake(state,'symptom','오류가 표시돼요','review');assert.equal(state.step,'review');assert.equal(state.returnTo,null);
});
test('extra information choice survives Back before answering and returning through quantity selection',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=startIntake(changeIntakeCount(state,'PC',1));state=answerIntake(state,'location','위치');
 state.items[0].extraInformation=true;state.returnTo='optional';state=backIntake(state);assert.equal(state.step,'location');assert.equal(state.returnTo,'optional','OPTIN_CHOICE_MUST_SURVIVE_BACK_BEFORE_ANSWER');
 state=backIntake(state);assert.equal(state.step,'pick');state=startIntake(state);assert.equal(state.step,'location');assert.equal(state.returnTo,'optional');assert.equal(state.items[0].extraInformation,true);
 state.items[0].extraInformation=false;state.returnTo=null;state=backIntake(state);assert.equal(state.returnTo,null,'UNCHECKED_OPTIN_MUST_NOT_BE_RESTORED_FROM_OLD_HISTORY');
});
test('a completed required path resumes newly opted-in extras after returning through selection',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=startIntake(changeIntakeCount(state,'PC',1));state=answerIntake(state,'location','위치');state=answerIntake(state,'symptom','작동이 멈췄어요');
 state=backIntake(state);state.items[0].extraInformation=true;state.returnTo='optional';state=backIntake(backIntake(state));assert.equal(state.step,'pick');
 state=startIntake(state);assert.equal(state.step,'location','REENTERING_SELECTION_MUST_REPLAY_REQUIRED_SEQUENCE');assert.equal(state.returnTo,'optional');
 state=answerIntake(state,'location','위치');assert.equal(state.step,'symptom');
 state=answerIntake(state,'symptom','작동이 멈췄어요');assert.equal(state.step,'systemType','PENDING_EXTRAS_MUST_SURVIVE_REENTERING_SELECTION');
});
test('FR056 selection clicks set quantity and decrement keeps zero out of the request',()=>{
 let state=createIntakeState();assert.equal(state.step,'intent');assert.equal(state.items.length,0);
 state=changeIntakeCount(state,'프린터',1);state=changeIntakeCount(state,'프린터',1);state=changeIntakeCount(state,'전화',1);
 assert.deepEqual(state.quantities,{'프린터':2,'전화':1});assert.equal(state.items[0].quantity,2);
 state=changeIntakeCount(state,'프린터',-1);state=changeIntakeCount(state,'프린터',-1);assert.equal(state.items.length,1);assert.equal(state.quantities.프린터,undefined);
});

test('intent comes first and supplies the work once for every new equipment target',()=>{
 for(const intent of ['고장','신설','기타']){
  let state=chooseIntakeIntent(createIntakeState(),intent);assert.equal(state.step,'pick');
  state=changeIntakeCount(state,'PC',1);state=changeIntakeCount(state,'전화',1);
  assert.deepEqual(state.items.map(item=>item.workType),[intent,intent]);
  state=startIntake(state);assert.equal(state.step,'location','INTENT_WORK_MUST_NOT_BE_ASKED_AGAIN');
  assert.ok(validGuidedDraft(state));
 }
 let state=chooseIntakeIntent(createIntakeState(),'지원');assert.equal(state.step,'supportKind');assert.equal(state.items.length,0);
 for(const work of ['지원','대여','점검','이전']){
  let equipment=chooseIntakeSupport(state,work);equipment=changeIntakeCount(equipment,'전화',1);equipment=startIntake(equipment);
  assert.equal(equipment.step,'location');assert.equal(equipment.items[0].workType,work);
 }
 const meeting=chooseIntakeSupport(state,'회의 지원');assert.equal(meeting.mode,'meeting');assert.equal(meeting.step,'meetingType');assert.deepEqual(meeting.items,[]);
 assert.equal(backIntake(meeting).step,'supportKind');assert.equal(backIntake(meeting).mode,'meeting');assert.equal(backIntake(backIntake(meeting)).step,'intent');
});

test('purpose and branch changes retain partial answers and files while clearing inactive fields',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=changeIntakeCount(state,'프린터',1);state=startIntake(state);
 for(const [key,value] of [['location','작성 중 위치'],['equipmentId','OLD-MODEL'],['symptom','오류가 표시돼요'],['errorCode','OLD-ERROR'],['attachmentIds',['device-file']]])state=updateIntakeField(state,key,value);
 state=chooseIntakeSupport(chooseIntakeIntent(navigateIntake(state,'intent'),'지원'),'회의 지원');
 state.meeting.detail='작성 중 회의 내용';state.meeting.attachmentIds=['meeting-file'];
 state=chooseIntakeIntent(navigateIntake(state,'intent'),'신설');
 assert.equal(state.items[0].workType,'신설');assert.equal(state.items[0].location,'작성 중 위치');assert.deepEqual(state.quantities,{'프린터':1});
 assert.deepEqual(state.items[0].attachmentIds,['device-file']);assert.equal(state.items[0].equipmentId,'');assert.equal(state.items[0].symptom,'');assert.equal(state.items[0].errorCode,'');
 state=chooseIntakeSupport(chooseIntakeIntent(navigateIntake(state,'intent'),'지원'),'회의 지원');
 assert.equal(state.meeting.detail,'작성 중 회의 내용');assert.deepEqual(state.meeting.attachmentIds,['meeting-file']);
 assert.equal(state.items[0].location,'작성 중 위치');
});

test('same purpose and changed defaults never overwrite independent or reused work types',()=>{
 let state=chooseIntakeIntent(createIntakeState(),'고장');state=changeIntakeCount(state,'PC',1);state=changeIntakeCount(state,'회선',1);
 state.activeId=state.items[1].id;state=answerIntake(state,'workType','이전');
 state=chooseIntakeIntent(navigateIntake(state,'intent'),'고장');assert.deepEqual(state.items.map(item=>item.workType),['고장','이전']);
 state=chooseIntakeIntent(navigateIntake(state,'intent'),'신설');assert.deepEqual(state.items.map(item=>item.workType),['신설','이전']);
 state=chooseIntakeSupport(chooseIntakeIntent(navigateIntake(state,'intent'),'지원'),'이전');assert.deepEqual(state.items.map(item=>item.workType),['이전','이전']);
 state=chooseIntakeIntent(navigateIntake(state,'intent'),'신설');assert.deepEqual(state.items.map(item=>item.workType),['신설','이전'],'EXPLICIT_WORK_MUST_SURVIVE_CONVERGING_DEFAULTS');
 const reused=intakeFromRequest({requestItems:state.items});const next=chooseIntakeIntent(navigateIntake(reused,'intent'),'기타');
 assert.deepEqual(next.items.map(item=>item.workType),['신설','이전']);
});

test('legacy drafts keep their question and new navigation metadata rejects invalid values',()=>{
 const legacy=createIntakeState();delete legacy.intent;delete legacy.defaultWorkType;legacy.step='pick';assert.ok(validGuidedDraft(legacy));
 assert.equal(startIntake(changeIntakeCount(legacy,'PC',1)).step,'workType');
 const invalidItem=changeIntakeCount(legacy,'PC',1);invalidItem.items[0].inheritedWorkType='true';assert.equal(validGuidedDraft(invalidItem),false);
 assert.equal(validGuidedDraft({...legacy,intent:'unapproved'}),false);assert.equal(validGuidedDraft({...legacy,defaultWorkType:'unapproved'}),false);
});
test('a new request shows only the relevant next question and never asks selected quantity again',()=>{
 let state=choose('프린터',3);assert.equal(state.step,'workType');state=answer(state,'workType','신설');assert.equal(state.step,'location');
 state=answer(state,'location','사무실');assert.equal(state.step,'detail');
 state=answer(state,'detail','설치 요청');assert.equal(state.step,'contact');assert.equal(state.items[0].quantity,3);assert.equal(intakePayload(state).requestItems[0].equipmentId,undefined);
});
test('back retains selected values and unconfirmed input without rolling back quantity',()=>{
 let state=choose('프린터',3);state=answer(state,'workType','고장');state=updateIntakeField(state,'location','아직 계속을 누르지 않은 위치');
 state=backIntake(state);assert.equal(state.step,'workType');assert.equal(state.items[0].location,'아직 계속을 누르지 않은 위치');
 state=answer(state,'workType','고장');assert.equal(state.step,'location');assert.equal(state.items[0].location,'아직 계속을 누르지 않은 위치');
 state=backIntake(backIntake(state));assert.equal(state.step,'pick');assert.equal(state.quantities.프린터,3);state=startIntake(state);assert.equal(state.items.length,1);
});
test('different networks split the original two lines without duplicating or losing a quantity',()=>{
 let state=line();const source=state.activeId;state=splitIntakeItem(state,1);assert.equal(state.step,'difference');assert.equal(state.items.length,2);
 state=answer(state,'systemType','인터넷');assert.equal(state.step,'itemReview');const payload=intakePayload(state);
 assert.deepEqual(payload.itemQuantities,{'회선':2});assert.deepEqual(payload.requestItems.map(item=>[item.systemType,item.quantity]),[['인트라넷',1],['인터넷',1]]);
 state=backIntake(state);assert.equal(state.items.reduce((sum,item)=>sum+item.quantity,0),2);assert.ok(state.items.some(item=>item.id===source));
});
test('explicit split cancellation restores the source quantity and deleted references do not trap navigation',()=>{
 let state=splitIntakeItem(line(),1);state=cancelIntakeSplit(state);assert.equal(state.items.length,1);assert.equal(state.items[0].quantity,2);
 state=splitIntakeItem(state,1);const deleted=state.activeId;state=removeIntakeItem(state,deleted);assert.equal(state.items.length,1);assert.equal(state.items[0].quantity,1);
 assert.ok(state.history.every(frame=>frame.activeId!==deleted));assert.equal(state.quantities.회선,1);
});
test('analog and IP phones keep independent fields and installation drops hidden model and fault values',()=>{
 let state=choose('전화',2);for(const [key,value]of[['workType','고장'],['phoneType','아날로그'],['location','사무실'],['symptom','발신이 안 돼요']])state=answer(state,key,value);
 state=splitIntakeItem(state,1);state=answer(state,'phoneType','IP');state=answer(state,'systemType','unknown');
 assert.deepEqual(intakePayload(state).requestItems.map(item=>[item.phoneType,item.quantity]),[['아날로그',1],['IP',1]]);
 state=choose('프린터');state=updateIntakeField(state,'equipmentId','OLD-MODEL');state=updateIntakeField(state,'errorCode','OLD-ERROR');state=answer(state,'workType','신설');
 for(const [key,value]of[['location','위치'],['systemType','unknown'],['detail','설치']])state=answer(state,key,value);
 const item=intakePayload(state).requestItems[0];assert.equal(item.equipmentId,undefined);assert.equal(item.errorCode,undefined);assert.equal(item.symptom,undefined);
});
test('reuse copies every allowed item with new references and no attachments or workflow metadata',()=>{
 const state=intakeFromRequest({category:'장비/체계',intakeVersion:1,itemQuantities:{'회선':2},requestItems:[{id:'old-a',kind:'회선',workType:'신설',quantity:1,location:'A',systemType:'인트라넷',detail:'연결',attachmentIds:['private']},{id:'old-b',kind:'회선',workType:'신설',quantity:1,location:'B',systemType:'인터넷',detail:'연결',attachmentIds:[]}],attachments:[{id:'private'}],schedulePreferences:[{rank:1,date:'2026-10-28',period:'AM'}],priority:'urgent'});
 assert.equal(state.items.length,2);assert.ok(state.items.every(item=>!['old-a','old-b'].includes(item.id)&&item.attachmentIds.length===0));assert.equal(state.priority,undefined);
 assert.deepEqual(intakePayload(state).requestItems.map(item=>item.location),['A','B']);
});

test('direct fault explanation advances without returning to the first question',()=>{
  let state=startIntake(changeIntakeCount(createIntakeState(),'PC',1));
  state=answerIntake(state,'workType','고장');state=answerIntake(state,'location','한 곳');state=answerIntake(state,'systemType','unknown');
  state=answerIntake(state,'symptom','직접 설명할게요');assert.equal(state.step,'detail');
  state=answerIntake(state,'detail','간헐적으로 멈춤');assert.equal(state.step,'contact');
});
test('nested split cancellation reconnects remaining children to a live source',()=>{
 let state=line();state.items[0].quantity=4;state.quantities.회선=4;
 state=splitIntakeItem(state,2);const middle=state.activeId;state=splitIntakeItem(state,1);const last=state.activeId;
 state.activeId=middle;state=cancelIntakeSplit(state);state.activeId=last;state=cancelIntakeSplit(state);
 assert.equal(state.items.length,1);assert.equal(state.items[0].quantity,4);assert.deepEqual(state.quantities,{'회선':4});
});
test('legacy telephone subtypes reuse as dedicated targets without invalid phone variants',()=>{
 for(const kind of ['인터컴','비상벨']){const value=intakeFromRequest({category:'장비/체계',subcategories:{resourceType:'전화',phoneType:kind,workType:'고장'},location:'기존 위치',detail:'기존 증상'});const payload=intakePayload(value);assert.equal(payload.requestItems[0].kind,kind);assert.equal(payload.requestItems[0].phoneType,undefined);}
});
test('removing an active kind with the initial counter never leaves a stale draft reference',()=>{
 let state=changeIntakeCount(createIntakeState(),'PC',1);state=changeIntakeCount(state,'프린터',1);state.activeId=state.items[0].id;state.step='pick';
 state=changeIntakeCount(state,'PC',-1);assert.ok(state.items.some(item=>item.id===state.activeId),'COUNTER_REMOVAL_MUST_SELECT_A_LIVE_ITEM');
 state=changeIntakeCount(state,'프린터',-1);assert.equal(state.activeId,null,'EMPTY_SELECTION_MUST_CLEAR_ACTIVE_DRAFT_REFERENCE');assert.deepEqual(state.quantities,{});assert.equal(state.items.length,0);
});
