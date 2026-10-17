import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessPolicy } from './accessPolicy.mjs';
test('SR-DEMO-003,023,025: role and ownership deny foreign action', () => {
  const requester = { role: 'requester', actor: { id: 'a' }, allowedActions: new Set(['cancelRequest']) };
  assert.equal(AccessPolicy.canPerform(requester, 'cancelRequest', { requesterActorId: 'b' }), false);
  assert.equal(AccessPolicy.canPerform(requester, 'cancelRequest', {}), false);
  assert.equal(AccessPolicy.canPerform(requester, 'assignTeams'), false);
});
