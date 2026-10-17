export class SessionManager {
  static switchActor(_session, actorId, accounts) {
    if (!accounts.some(actor => actor.id === actorId)) throw new Error('NOT_FOUND');
    return { activeActorId: actorId };
  }
  static resolveRoleContext(session, accounts) {
    const actor = accounts.find(item => item.id === session.activeActorId);
    if (!actor) throw new Error('NOT_FOUND');
    return { actor, role: actor.role, teamId: actor.teamId, allowedActions: new Set(
      actor.role === 'requester' ? ['createRequest','updateRequest','cancelRequest'] :
      actor.role === 'bnoc' ? ['createRequest','updateRequest','moveToDocumentWaiting','assignTeams','reassignReturnedWork'] :
      ['updateWork','returnWork','updateWorkDetails','createAfterActionReport']
    ) };
  }
}
