export class NotificationRules {
  static notificationsFor(event, state, at) {
    const { request, workItems = [] } = event;
    const recipients = event.type === '요청 등록' || event.type === '작업 반환' || event.type === '반환 정정' || event.type === '선조치 후보고'
      ? state.accounts.filter(actor => actor.role === 'bnoc').map(actor => actor.id)
      : event.type === '작업 배정'
        ? workItems.flatMap(work => state.accounts.filter(actor => actor.teamId === work.teamId).map(actor => actor.id))
        : request.requesterActorId ? [request.requesterActorId] : [];
    return [...new Set(recipients)].map(recipientActorId => ({
      recipientActorId, event: event.type, relatedRequestId: request.id,
      ...(workItems.length === 1 ? { relatedWorkItemId: workItems[0].id } : {}),
      at, read: false
    }));
  }
}
