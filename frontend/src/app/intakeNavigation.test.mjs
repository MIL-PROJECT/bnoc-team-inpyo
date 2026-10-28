import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeState, chooseIntakeIntent, changeIntakeCount, startIntake, answerIntake, backIntake, navigateIntake, jumpIntake, updateIntakeField, canBackIntake } from './intakeModel.mjs';

const equipment = () => startIntake(changeIntakeCount(chooseIntakeIntent(createIntakeState(), '고장'), 'PC', 1));
test('answered required questions stay in order after repeated Back and forward', () => {
  let state = equipment();
  state = answerIntake(state, 'location', '한 곳');
  state = answerIntake(state, 'symptom', '작동이 멈췄어요');
  assert.equal(state.step, 'contact');
  state = backIntake(backIntake(state));
  assert.equal(state.step, 'location');
  state = answerIntake(state, 'location', '정정한 곳');
  assert.equal(state.step, 'symptom', 'ANSWERED_NEXT_QUESTION_MUST_NOT_BE_SKIPPED');
  state = backIntake(state);
  assert.equal(state.step, 'location');
  state = answerIntake(state, 'location', '정정한 곳');
  assert.equal(state.step, 'symptom');
  state = answerIntake(state, 'symptom', '작동이 멈췄어요');
  assert.equal(state.step, 'contact');
});
test('returning through quantities starts the first question and preserves later target answers', () => {
  let state = equipment();
  state = answerIntake(state, 'location', '한 곳');
  state = answerIntake(state, 'symptom', '작동이 멈췄어요');
  state = navigateIntake(state, 'pick');
  state = startIntake(state);
  assert.equal(state.step, 'location', 'QUANTITY_FORWARD_MUST_REPLAY_TARGET_SEQUENCE');
  assert.equal(state.items[0].symptom, '작동이 멈췄어요');
  assert.equal(state.quantities.PC, 1);
});
test('forward after Back visits an already answered next target', () => {
  let state = changeIntakeCount(chooseIntakeIntent(createIntakeState(), '신설'), 'PC', 1);
  state = startIntake(changeIntakeCount(state, '프린터', 1));
  for (const value of ['첫 위치', '첫 내용', '둘째 위치', '둘째 내용']) state = answerIntake(state, state.step, value);
  state = backIntake(backIntake(backIntake(state)));
  assert.equal(state.step, 'detail');
  state = answerIntake(state, 'detail', '첫 내용 정정');
  assert.equal(state.step, 'location', 'ANSWERED_TARGET_MUST_NOT_BE_SKIPPED');
  assert.equal(state.activeId, state.items[1].id);
  assert.equal(state.items[1].location, '둘째 위치');
});

test('jumping to final then Back and forward retains the attachment target',()=>{
 let state=equipment();state=answerIntake(state,'location','한 곳');state=answerIntake(state,'symptom','작동이 멈췄어요');
 state=jumpIntake(state,'review');state=backIntake(state);assert.equal(state.step,'contact');
 state=navigateIntake(state,'review');state=updateIntakeField(state,'attachmentIds',['uploaded-file']);
 assert.deepEqual(state.items[0].attachmentIds,['uploaded-file'],'COMMON_NAVIGATION_MUST_RETAIN_ATTACHMENT_TARGET');
});

test('restored or reused questions with no history can still go back in sequence',()=>{
 let state=equipment();state=answerIntake(state,'location','한 곳');state=answerIntake(state,'symptom','작동이 멈췄어요');state.history=[];
 state=backIntake(state);assert.equal(state.step,'symptom','EMPTY_HISTORY_MUST_NOT_TRAP_A_RESTORED_QUESTION');
 state=backIntake(state);assert.equal(state.step,'location');state=answerIntake(state,'location','한 곳');assert.equal(state.step,'symptom');
});

test('legacy optional and split screens retain a usable Back route without stored frames',()=>{
 let state=equipment();state=answerIntake(state,'location','한 곳');state=answerIntake(state,'symptom','작동이 멈췄어요');state.history=[];state.step='systemType';state.returnTo='optional';delete state.items[0].extraInformation;
 assert.equal(canBackIntake(state),true,'LEGACY_OPTIONAL_BACK_REQUIRED');state=backIntake(state);assert.equal(state.step,'symptom');assert.equal(state.items[0].extraInformation,true);
 for(const step of ['splitCount','difference']){const split={...state,step,history:[],returnTo:'itemReview'};assert.equal(canBackIntake(split),true);assert.equal(backIntake(split).step,'itemReview');}
});
