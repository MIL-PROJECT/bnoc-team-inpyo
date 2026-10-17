import { actorFor, permitted, failure, success, validateRequest, addHistory, addNotifications, nextRequestNumber } from './requestCommands.mjs';
export class AfterActionReportCommand {
  static createAfterActionReport(cmd, session, env) {
    const { state } = env, payload = cmd.payload ?? {};
    if (!permitted(session, env, 'createAfterActionReport')) return failure(state, 'FORBIDDEN');
    const actor = actorFor(session, env), errors = validateRequest(payload);
    for (const field of ['actualRequesterText','actualStartedAt','actualCompletedAt','reason']) if (!String(payload[field] ?? '').trim()) errors[field] = '필수 입력입니다.';
    if (payload.teamId !== actor.teamId) errors.teamId = '소속 작업반만 처리할 수 있습니다.';
    if (payload.actualCompletedAt && payload.actualStartedAt && payload.actualCompletedAt < payload.actualStartedAt) errors.actualCompletedAt = '완료 시각을 확인하세요.';
    if (Object.keys(errors).length) return failure(state, 'VALIDATION', { fieldErrors: errors });
    if (env.fail?.('createAfterActionReport')) return failure(state, 'SAVE_FAILED');
    const next = structuredClone(state), at = env.now();
    const requestId = env.id?.() ?? crypto.randomUUID(), workId = env.id?.() ?? crypto.randomUUID();
    const requestNumber = nextRequestNumber(state);
    const request = {
      id: requestId, requestNumber, registeredBy: actor.id, requesterDisplayText: payload.actualRequesterText.trim(),
      category: payload.category, subcategories: structuredClone(payload.subcategories),
      detail: payload.detail.trim(), location: payload.location.trim(), contact: payload.contact.trim(),
      ...(payload.equipmentId ? { equipmentId: payload.equipmentId } : {}),
      ...(payload.maintenanceTarget ? { maintenanceTarget: structuredClone(payload.maintenanceTarget) } : {}),
      attachments: structuredClone(payload.attachments ?? []), status: '완료', registeredAt: at, revision: 1
    };
    const work = {
      id: workId, requestId, workNumber: `${requestNumber}-1`, teamId: actor.teamId, status: '완료', origin: 'after-action', revision: 1,
      resolvedByWorkItemIds: [], completion: { completedBy: actor.id, completedAt: payload.actualCompletedAt, ...(payload.completionMemo ? { memo: payload.completionMemo } : {}) }
    };
    next.requests.push(request); next.workItems.push(work);
    addHistory(next, requestId, actor.id, at, '선조치 후보고', null, payload.reason.trim());
    addHistory(next, workId, actor.id, at, '실제 시작 시각', null, payload.actualStartedAt);
    addHistory(next, workId, actor.id, at, '상태', null, '완료');
    addNotifications(next, '선조치 후보고', request, [work], env);
    return success(next, [requestId, workId], { requestNumber });
  }
}
