import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlannedWorkInProgressOnDate, isValidPlannedWorkCompletionDate } from './plannedWorkDate.mjs';

test('a planned work carries into each later selected date without duplicate date records', () => {
  const work = { firstWorkDate: '2026-10-19', status: '진행 중' };

  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-18'), false);
  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-19'), true);
  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-20'), true);
  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-21'), true);
});

test('completed work no longer appears in any in-progress date list', () => {
  const work = { firstWorkDate: '2026-10-19', status: '완료', completedDate: '2026-10-21' };

  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-20'), false);
  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-21'), false);
  assert.equal(isPlannedWorkInProgressOnDate(work, '2026-10-22'), false);
});

test('completion date must be between the work date and today', () => {
  const work = { firstWorkDate: '2026-10-19', status: '진행 중' };

  assert.equal(isValidPlannedWorkCompletionDate(work, '2026-10-18', '2026-10-21'), false);
  assert.equal(isValidPlannedWorkCompletionDate(work, '2026-10-19', '2026-10-21'), true);
  assert.equal(isValidPlannedWorkCompletionDate(work, '2026-10-21', '2026-10-21'), true);
  assert.equal(isValidPlannedWorkCompletionDate(work, '2026-10-22', '2026-10-21'), false);
});
