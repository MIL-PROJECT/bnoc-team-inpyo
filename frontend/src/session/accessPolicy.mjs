export class AccessPolicy {
  static canPerform(role, action, target) {
    const allowed = role.allowedActions?.has(action) ?? false;
    if (!allowed) return false;
    if (role.role === 'requester' && target && target.requesterActorId !== role.actor.id) return false;
    if (role.role === 'team' && target?.teamId && target.teamId !== role.teamId) return false;
    return true;
  }
}
