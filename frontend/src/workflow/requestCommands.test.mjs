import test from 'node:test';
import assert from 'node:assert/strict';
import { AppStateFactory } from '../bootstrap/appStateFactory.mjs';
import { RequestCommands } from './requestCommands.mjs';
const state = AppStateFactory.restoreBaseline();
const env = { state, accounts: [{ id: 'requester-1', role: 'requester' }, { id: 'bnoc-1', role: 'bnoc' }, { id: 'team-1', role: 'team', teamId: '무선반' }], now: () => 'now', id: () => 'NEW' };
test('SR-DEMO-009,010,011: required subtype and target bundle validated', () => {
  const payload = { requesterDisplayText: '한서준', category: '장비/체계', detail: '점검', location: '별관', contact: '912-4101' };
  const fail = RequestCommands.createRequest({ payload }, { activeActorId: 'requester-1' }, env);
  assert.equal(fail.errorCode, 'VALIDATION');
  const ok = RequestCommands.createRequest({ payload: { ...payload, subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '고장' } } }, { activeActorId: 'requester-1' }, env);
  assert.equal(ok.ok, true);
  assert.equal(ok.nextState.requests.at(-1).requestNumber, '109');
  assert.equal(ok.nextState.requests.at(-1).status, '대기');
  assert.equal(state.requests.length + 1, ok.nextState.requests.length);
  const invalidChoice = RequestCommands.createRequest({ payload: { ...payload, subcategories: { systemType: '임의값', resourceType: 'PC', workType: '고장' } } }, { activeActorId: 'requester-1' }, env);
  assert.equal(invalidChoice.errorCode, 'VALIDATION');
});

test('SR-DEMO-011,016: assignment creates request-scoped public work numbers', () => {
  const result = RequestCommands.assignTeams({ targetId: 'REQ-101', expectedRevision: 1, payload: { teamIds: ['무선반','유선반'] } }, { activeActorId: 'bnoc-1' }, env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.nextState.workItems.slice(-2).map(work => work.workNumber), ['101-1','101-2']);
});
test('SR-DEMO-016,040: assignment failure leaves all state untouched', () => {
  const result = RequestCommands.assignTeams({ targetId: 'REQ-101', expectedRevision: 1, payload: { teamIds: ['무선반','invalid'] } }, { activeActorId: 'bnoc-1' }, env);
  assert.equal(result.ok, false);
  assert.strictEqual(result.state, state);
});
test('SR-DEMO-025: requester cannot edit a text-only proxy request', () => {
  const result = RequestCommands.updateRequest({ targetId: 'REQ-108', expectedRevision: 1, payload: { detail: '변조' } }, { activeActorId: 'requester-1' }, env);
  assert.equal(result.errorCode, 'FORBIDDEN');
});
test('SR-DEMO-027: unchanged optional request fields make no false history', () => {
  const request = state.requests.find(row => row.id === 'REQ-101');
  const result = RequestCommands.updateRequest({ targetId: request.id, expectedRevision: request.revision, payload: {
    detail: request.detail, location: request.location, contact: request.contact, scheduledAt: '', documentRef: ''
  } }, { activeActorId: 'bnoc-1' }, env);
  assert.equal(result.ok, true);
  assert.equal(result.nextState.history.length, state.history.length);
  assert.equal(result.nextState.requests.find(row => row.id === request.id).revision, request.revision);
});
