import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureCatalog } from '../bootstrap/fixtureCatalog.mjs';
import { SessionManager } from './sessionManager.mjs';
test('SR-DEMO-003,004: actor switch preserves business state and resolves role', () => {
  const accounts = FixtureCatalog.load().accounts;
  const session = SessionManager.switchActor({ activeActorId: 'requester-1' }, 'team-2', accounts);
  assert.equal(SessionManager.resolveRoleContext(session, accounts).teamId, '유선반');
  assert.throws(() => SessionManager.switchActor(session, 'unknown', accounts), /NOT_FOUND/);
});
