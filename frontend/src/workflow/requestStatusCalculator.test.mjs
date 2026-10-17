import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestStatusCalculator } from './requestStatusCalculator.mjs';
test('SR-DEMO-021: unresolved return and all completed precedence', () => {
  const request = { status: '배정' };
  const work = status => ({ status, resolvedByWorkItemIds: [] });
  assert.equal(RequestStatusCalculator.deriveStatus(request, [work('완료'), work('반환')]), '대기');
  assert.equal(RequestStatusCalculator.deriveStatus(request, [work('완료'), work('완료')]), '완료');
  assert.equal(RequestStatusCalculator.deriveStatus(request, [work('작업 중'), work('반환')]), '작업 중');
});
