import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationRules } from './notificationRules.mjs';
test('SR-DEMO-031: text requester has no account notification', () => {
  const state = { accounts: [{ id: 'b', role: 'bnoc' }] };
  assert.equal(NotificationRules.notificationsFor({ type: '완료', request: { id: 'r' } }, state, 'now').length, 0);
  assert.equal(NotificationRules.notificationsFor({ type: '요청 등록', request: { id: 'r' } }, state, 'now')[0].recipientActorId, 'b');
});
