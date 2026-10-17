import test from 'node:test';
import assert from 'node:assert/strict';
import { AppStateFactory } from '../bootstrap/appStateFactory.mjs';
import { AfterActionReportCommand } from './afterActionReportCommand.mjs';
test('SR-DEMO-022,040: after-action creates linked completed work atomically', () => {
  const state = AppStateFactory.restoreBaseline();
  const env = { state, accounts: [{ id: 'team-1', role: 'team', teamId: '무선반' }, { id: 'bnoc-1', role: 'bnoc' }], now: () => '2026-09-18T12:00', id: (() => { let i=0; return () => String(++i); })() };
  const result = AfterActionReportCommand.createAfterActionReport({ payload: {
    actualRequesterText: '주무관 배지안 · 기획지원실', category: '회의 지원', subcategories: { meetingType: '화상회의' }, detail: '연결 점검', location: '별관', contact: '912-4110', teamId: '무선반', actualStartedAt: '2026-09-18T10:00', actualCompletedAt: '2026-09-18T11:00', reason: '선조치'
  } }, { activeActorId: 'team-1' }, env);
  assert.equal(result.ok, true);
  assert.equal(result.nextState.requests.at(-1).requestNumber, '109');
  assert.equal(result.nextState.workItems.at(-1).workNumber, '109-1');
  assert.equal(result.nextState.workItems.at(-1).requestId, result.nextState.requests.at(-1).id);
  assert.equal(result.nextState.history.find(entry => entry.targetId === result.nextState.workItems.at(-1).id && entry.field === '실제 시작 시각')?.after, '2026-09-18T10:00');
  assert.equal(state.requests.length + 1, result.nextState.requests.length);
});
