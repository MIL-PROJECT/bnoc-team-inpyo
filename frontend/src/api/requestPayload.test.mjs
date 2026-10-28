import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPayload, afterActionPayload } from './requestPayload.mjs';
const input = { requesterDisplayText: '요청 부서', requesterRef: 'requester-public-ref', category: '장비/체계', systemType: '인터넷', resourceType: 'PC', workType: '지원', phoneType: '', detail: '지원 내용', location: '작업 장소', contact: '연락처', equipmentId: '', preference1Date: '2026-10-13', preference1Period: 'AM', preference2Date: '2026-10-14', preference2Period: 'PM', documentRef: '', differentTarget: false, attachments: [] };
test('requester identity is server-bound and BNOC submits only a selected public requester reference', () => {
  const requester = requestPayload(input, 'requester');
  assert.equal(Object.hasOwn(requester, 'requesterDisplayText'), false, 'REQUESTER_IDENTITY_MUST_BE_SERVER_BOUND');
  assert.deepEqual(requester.schedulePreferences, [{ rank: 1, date: '2026-10-13', period: 'AM' }, { rank: 2, date: '2026-10-14', period: 'PM' }]);
  assert.equal(requestPayload(input, 'bnoc').requesterRef, 'requester-public-ref');
  assert.equal(Object.hasOwn(requestPayload(input, 'bnoc'), 'requesterDisplayText'), false, 'BNOC_MUST_NOT_SEND_FORGED_DISPLAY_TEXT');
  assert.equal(Object.hasOwn(requester, 'priority'), false);
  assert.equal(Object.hasOwn(requester, 'schedule'), false);
  assert.equal(Object.hasOwn(requester.subcategories, 'phoneType'), false, 'OPTIONAL_PHONE_SUBTYPE_REQUIRED');
  assert.equal(Object.hasOwn(requestPayload({ ...input, phoneType:'IP' },'requester').subcategories,'phoneType'),false,'HIDDEN_PHONE_SUBTYPE_MUST_NOT_BE_SENT');
});
test('personal phone is optional, trimmed, and omitted from after-action reports', () => {
  assert.equal(Object.hasOwn(requestPayload(input, 'requester'), 'personalContact'), false);
  assert.equal(requestPayload({ ...input, personalContact:' 010-0000-0000 ' }, 'requester').personalContact, '010-0000-0000');
  const report = afterActionPayload({ ...input, personalContact:'010-0000-0000' }, { startedDate: '2026-10-13', startedTime: '10:00', completedDate: '2026-10-13', completedTime: '11:00', reason: '현장 처리', memo: '', done: true });
  assert.equal(Object.hasOwn(report, 'personalContact'), false, 'AFTER_ACTION_MUST_NOT_COLLECT_OPTIONAL_PERSONAL_CONTACT');
});
test('after-action transmits explicit completion and actual instants without a new unfinished intake or desired schedule', () => {
  const payload = afterActionPayload(input, { startedDate: '2026-10-13', startedTime: '10:00', completedDate: '2026-10-13', completedTime: '11:00', reason: '현장 처리', memo: '', done: true });
  assert.equal(payload.completedConfirmed, true, 'AFTER_ACTION_COMPLETED_CONFIRMATION_REQUIRED');
  assert.equal(payload.actualStartedAt, '2026-10-13T01:00:00.000Z');
  assert.equal(payload.actualCompletedAt, '2026-10-13T02:00:00.000Z');
  assert.equal(payload.requesterRef, input.requesterRef);
  assert.equal(Object.hasOwn(payload, 'actualRequesterText'), false);
  assert.equal(Object.hasOwn(payload, 'requesterDisplayText'), false);
  assert.equal(Object.hasOwn(payload, 'schedulePreferences'), false);
  assert.equal(Object.hasOwn(payload, 'priority'), false, 'AFTER_ACTION_CLASSIFICATION_MUST_REMAIN_UNSET');
});

test('after-action payload rejects malformed 24-hour date/time values before transmission', () => {
  const invalid = afterActionPayload(input, { startedDate: '2026-10-13', startedTime: '24:00', completedDate: '2026-10-13', completedTime: '00:00', reason: '현장 처리', memo: '', done: true });
  assert.equal(invalid.actualStartedAt, undefined);
  assert.equal(invalid.actualCompletedAt, '2026-10-12T15:00:00.000Z');
});

test('both preference choices are optional and partial fields are preserved for server validation', () => {
  const empty = requestPayload({ ...input, preference1Date: '', preference1Period: '', preference2Date: '', preference2Period: '' }, 'requester');
  assert.equal(Object.hasOwn(empty, 'schedulePreferences'), false);
  const secondOnly = requestPayload({ ...input, preference1Date: '', preference1Period: '', preference2Date: '2026-10-14', preference2Period: 'PM' }, 'requester');
  assert.deepEqual(secondOnly.schedulePreferences, [{ rank: 2, date: '2026-10-14', period: 'PM' }]);
});

test('meeting submission sends its video platform only for video meetings', () => {
  const video = requestPayload({ ...input, category:'회의 지원', meetingType:'화상회의', videoPlatform:'KJCCS' }, 'requester');
  assert.deepEqual(video.subcategories, { meetingType:'화상회의', videoPlatform:'KJCCS' });
  const general = requestPayload({ ...input, category:'회의 지원', meetingType:'일반회의', videoPlatform:'KJCCS' }, 'requester');
  assert.deepEqual(general.subcategories, { meetingType:'일반회의' }, 'HIDDEN_PLATFORM_MUST_NOT_BE_SENT');
});
