import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPayload, afterActionPayload } from './requestPayload.mjs';
const input = { requesterDisplayText: '요청 부서', category: '장비/체계', systemType: '인터넷', resourceType: 'PC', workType: '지원', phoneType: '', detail: '지원 내용', location: '작업 장소', contact: '연락처', equipmentId: '', preference1Date: '2026-10-13', preference1Period: 'AM', preference2Date: '2026-10-14', preference2Period: 'PM', documentRef: '', differentTarget: false, attachments: [] };
test('requester identity is server-bound and BNOC alone submits requester text; no assignment or actual schedule fields', () => {
  const requester = requestPayload(input, 'requester');
  assert.equal(Object.hasOwn(requester, 'requesterDisplayText'), false, 'REQUESTER_IDENTITY_MUST_BE_SERVER_BOUND');
  assert.deepEqual(requester.schedulePreferences, [{ rank: 1, date: '2026-10-13', period: 'AM' }, { rank: 2, date: '2026-10-14', period: 'PM' }]);
  assert.equal(requestPayload(input, 'bnoc').requesterDisplayText, '요청 부서');
  assert.equal(Object.hasOwn(requester, 'priority'), false);
  assert.equal(Object.hasOwn(requester, 'schedule'), false);
  assert.equal(Object.hasOwn(requester.subcategories, 'phoneType'), false, 'OPTIONAL_PHONE_SUBTYPE_REQUIRED');
  assert.equal(Object.hasOwn(requestPayload({ ...input, phoneType:'IP' },'requester').subcategories,'phoneType'),false,'HIDDEN_PHONE_SUBTYPE_MUST_NOT_BE_SENT');
});
test('after-action transmits explicit completion and actual instants without a new unfinished intake or desired schedule', () => {
  const payload = afterActionPayload(input, { started: '2026-10-13T10:00', completed: '2026-10-13T11:00', reason: '현장 처리', memo: '', done: true });
  assert.equal(payload.completedConfirmed, true, 'AFTER_ACTION_COMPLETED_CONFIRMATION_REQUIRED');
  assert.equal(payload.actualCompletedAt, '2026-10-13T02:00:00.000Z');
  assert.equal(payload.actualRequesterText, input.requesterDisplayText);
  assert.equal(Object.hasOwn(payload, 'requesterDisplayText'), false);
  assert.equal(Object.hasOwn(payload, 'schedulePreferences'), false);
  assert.equal(Object.hasOwn(payload, 'priority'), false, 'AFTER_ACTION_CLASSIFICATION_MUST_REMAIN_UNSET');
});

test('both preference choices are optional and partial fields are preserved for server validation', () => {
  const empty = requestPayload({ ...input, preference1Date: '', preference1Period: '', preference2Date: '', preference2Period: '' }, 'requester');
  assert.equal(Object.hasOwn(empty, 'schedulePreferences'), false);
  const secondOnly = requestPayload({ ...input, preference1Date: '', preference1Period: '', preference2Date: '2026-10-14', preference2Period: 'PM' }, 'requester');
  assert.deepEqual(secondOnly.schedulePreferences, [{ rank: 2, date: '2026-10-14', period: 'PM' }]);
});
