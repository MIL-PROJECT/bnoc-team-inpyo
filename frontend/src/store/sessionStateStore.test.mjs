import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from './sessionStateStore.mjs';
test('SR-DEMO-040,041,042: replay, different actor, conflict and atomic state', () => {
  const store = new SessionStateStore({ id: (() => { let i=0; return () => 'NEW-'+ ++i; })(), now: () => 'now' });
  const command = { type: 'assignTeams', operationId: 'one', requestNumber: '101', expectedRevision: 1, payload: { teamIds: ['무선반','유선반'] } };
  store.switchActor('bnoc-1');
  const before = store.getSnapshot();
  const first = store.dispatch(command);
  assert.equal(first.ok, true);
  const afterFirst = store.getSnapshot();
  assert.equal(afterFirst.workItems.length, before.workItems.length + 2);
  assert.deepEqual(first, { ok: true, requestNumber: undefined });
  const replay = store.dispatch(command);
  assert.equal(replay.replayed, true);
  assert.strictEqual(store.getSnapshot(), afterFirst);
  store.switchActor('team-1');
  assert.equal(store.dispatch(command).errorCode, 'DUPLICATE_ACTION');
  store.switchActor('bnoc-1');
  assert.equal(store.dispatch({ ...command, operationId: 'two' }).errorCode, 'CONFLICT');
});

test('ARCH-008,009: public dispatch rejects an internal target id', () => {
  const store = new SessionStateStore();
  store.switchActor('team-1');
  const before = store.getSnapshot();
  const result = store.dispatch({
    type: 'updateWork', operationId: 'internal-target-bypass', requestNumber: '999', workNumber: '999-1', targetId: 'WORK-103-A', expectedRevision: 1, payload: { nextStatus: '완료' }
  });
  assert.deepEqual(result, { ok: false, errorCode: 'VALIDATION' });
  assert.strictEqual(store.getSnapshot(), before);
});

test('SR-DEMO-011: store resolves public request number and returns it after create', () => {
  const store = new SessionStateStore({ id: () => 'internal-uuid', now: () => 'now' });
  store.switchActor('bnoc-1');
  const moved = store.dispatch({ type: 'moveToDocumentWaiting', operationId: 'public-target', requestNumber: '101', expectedRevision: 1, payload: {} });
  assert.equal(moved.ok, true);
  store.switchActor('requester-1');
  const created = store.dispatch({ type: 'createRequest', operationId: 'public-create', payload: {
    category: '장비/체계', subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '고장' }, detail: '점검', location: '별관', contact: '912-4101'
  } });
  assert.equal(created.ok, true);
  assert.equal(created.requestNumber, '109');
  assert.equal('changedIds' in created, false);
  assert.equal('nextState' in created, false);
  assert.equal(JSON.stringify(created).includes('internal-uuid'), false);
  const replayed = store.dispatch({ type: 'createRequest', operationId: 'public-create', payload: {
    category: '장비/체계', subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '고장' }, detail: '점검', location: '별관', contact: '912-4101'
  } });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.requestNumber, '109');
});
