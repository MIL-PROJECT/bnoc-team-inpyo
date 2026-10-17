import test from 'node:test';
import assert from 'node:assert/strict';
import { AppStateFactory } from '../bootstrap/appStateFactory.mjs';
import { WorkItemCommands } from './workItemCommands.mjs';
test('SR-DEMO-018,019,020: assigned work can move directly to any selected state', () => {
  const state = AppStateFactory.restoreBaseline();
  const session = { activeActorId: 'team-1' };
  const env = { state, accounts: [{ id: 'team-1', role: 'team', teamId: '무선반' }], now: () => 'now' };
  const cmd = { targetId: 'WORK-103-A', expectedRevision: 1, payload: { nextStatus: '완료' } };
  assert.equal(WorkItemCommands.updateWork(cmd, session, env).ok, true);
  const started = WorkItemCommands.updateWork({ ...cmd, payload: { nextStatus: '작업 중' } }, session, env);
  assert.equal(started.ok, true);
  assert.equal(state.workItems.find(w => w.id === cmd.targetId).status, '배정');
});

test('SR-DEMO-018~021: all four work states can be corrected in either direction', () => {
  const statuses = ['배정','작업 중','완료','반환'];
  for (const from of statuses) for (const nextStatus of statuses) {
    const state = AppStateFactory.restoreBaseline();
    const work = state.workItems.find(row => row.id === 'WORK-103-A');
    work.status = from;
    work.origin = 'assigned';
    work.resolvedByWorkItemIds = [];
    if (from === '완료') work.completion = { completedBy: 'team-1', completedAt: 'before' }; else delete work.completion;
    if (from === '반환') work.returnReason = '기존 반환'; else delete work.returnReason;
    const result = WorkItemCommands.updateWork({ targetId: work.id, expectedRevision: work.revision, payload: { nextStatus, returnReason: nextStatus === '반환' ? '정정 반환' : undefined, memo: '작업 메모', completionMemo: '완료 메모' } }, { activeActorId: 'team-1' }, {
      state, accounts: [{ id: 'team-1', role: 'team', teamId: '무선반' }, { id: 'bnoc-1', role: 'bnoc' }], now: () => 'after'
    });
    assert.equal(result.ok, true, `${from} -> ${nextStatus}`);
    const edited = result.nextState.workItems.find(row => row.id === work.id);
    assert.equal(edited.status, nextStatus);
    assert.equal(!!edited.completion, nextStatus === '완료');
    assert.equal(!!edited.returnReason, nextStatus === '반환');
    assert.equal(edited.memo, '작업 메모');
    if (nextStatus === '완료') assert.equal(edited.completion.memo, '완료 메모');
  }
});

test('SR-DEMO-031: editing a returned work item does not repeat the return notification', () => {
  const state = AppStateFactory.restoreBaseline();
  const work = state.workItems.find(row => row.id === 'WORK-103-A');
  work.status = '반환';
  work.returnReason = '기존 반환';
  const before = state.notifications.filter(row => row.event === '작업 반환').length;
  const result = WorkItemCommands.updateWork({ targetId: work.id, expectedRevision: work.revision, payload: {
    nextStatus: '반환', returnReason: '기존 반환', schedule: '2026-10-01T09:00', memo: '일정만 정정'
  } }, { activeActorId: 'team-1' }, {
    state, accounts: [{ id: 'team-1', role: 'team', teamId: '무선반' }, { id: 'bnoc-1', role: 'bnoc' }], now: () => 'after'
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextState.notifications.filter(row => row.event === '작업 반환').length, before);
});

test('SR-DEMO-020,042: resolved returns and after-action records stay locked', () => {
  const state = AppStateFactory.restoreBaseline();
  const env = { state, accounts: [{ id: 'team-1', role: 'team', teamId: '무선반' }, { id: 'team-3', role: 'team', teamId: '전장반(전산장비)' }], now: () => 'now' };
  assert.equal(WorkItemCommands.updateWork({ targetId: 'WORK-107-OLD', expectedRevision: 1, payload: { nextStatus: '배정' } }, { activeActorId: 'team-3' }, env).errorCode, 'INVALID_STATE');
  assert.equal(WorkItemCommands.updateWork({ targetId: 'WORK-108', expectedRevision: 1, payload: { nextStatus: '배정' } }, { activeActorId: 'team-1' }, env).errorCode, 'INVALID_STATE');
});

test('SR-DEMO-011,017: reassignment uses the next public work number', () => {
  const state = AppStateFactory.restoreBaseline();
  const work = state.workItems.find(row => row.id === 'WORK-107-OLD');
  work.resolvedByWorkItemIds = [];
  state.requests.find(row => row.id === work.requestId).status = '대기';
  const result = WorkItemCommands.reassignReturnedWork({ targetId: work.id, expectedRevision: 1, payload: { teamIds: ['암호반'] } }, { activeActorId: 'bnoc-1' }, {
    state, accounts: [{ id: 'bnoc-1', role: 'bnoc' }], teams: ['무선반','유선반','전장반(전산장비)','정체반','암호반'], id: () => 'new-internal-id', now: () => 'now'
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextState.workItems.at(-1).workNumber, '107-3');
});
test('SR-DEMO-027: unchanged optional work fields make no false history', () => {
  const state = AppStateFactory.restoreBaseline();
  const result = WorkItemCommands.updateWorkDetails({ targetId: 'WORK-103-B', expectedRevision: 1, payload: { schedule: '', memo: '' } }, { activeActorId: 'team-2' }, {
    state, accounts: [{ id: 'team-2', role: 'team', teamId: '유선반' }], now: () => 'now'
  });
  assert.equal(result.ok, true);
  assert.equal(result.nextState.history.length, state.history.length);
});
