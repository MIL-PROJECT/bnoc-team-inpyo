import { FixtureCatalog } from '../bootstrap/fixtureCatalog.mjs';
import { RequestStatusCalculator } from './requestStatusCalculator.mjs';
import { actorFor, permitted, targetFor, failure, success, addHistory, addNotifications, nextWorkNumbers } from './requestCommands.mjs';

const requestFor = (state, work) => state.requests.find(request => request.id === work.requestId);
const recalculate = (next, requestId, actorId, env) => {
  const request = next.requests.find(row => row.id === requestId);
  const before = request.status;
  const status = RequestStatusCalculator.deriveStatus(request, next.workItems.filter(work => work.requestId === requestId));
  if (status !== before) {
    request.status = status;
    request.revision++;
    addHistory(next, request.id, actorId, env.now(), '상태', before, status);
    if (['배정','작업 중','완료'].includes(status)) addNotifications(next, status, request, [], env);
  }
};
const checkWork = (cmd, session, env, action) => {
  const work = targetFor(env.state, 'workItems', cmd);
  if (work.ok === false) return work;
  if (!permitted(session, env, action, work)) return failure(env.state, 'FORBIDDEN');
  if (requestFor(env.state, work)?.status === '취소') return failure(env.state, 'INVALID_STATE');
  return work;
};
export class WorkItemCommands {
  static updateWork(cmd, session, env) {
    const work = checkWork(cmd, session, env, 'updateWork');
    if (work.ok === false) return work;
    const nextStatus = cmd.payload?.nextStatus;
    if (!['배정','작업 중','완료','반환'].includes(nextStatus)) return failure(env.state, 'VALIDATION', { fieldErrors: { nextStatus: '작업 상태를 선택하세요.' } });
    if (work.resolvedByWorkItemIds.length || work.origin === 'after-action') return failure(env.state, 'INVALID_STATE');
    const returnReason = String(cmd.payload?.returnReason ?? work.returnReason ?? '').trim();
    const completionMemo = String(cmd.payload?.completionMemo ?? work.completion?.memo ?? '').trim();
    if (nextStatus === '반환' && !returnReason) return failure(env.state, 'VALIDATION', { fieldErrors: { returnReason: '반환 사유를 입력하세요.' } });
    const next = structuredClone(env.state), edited = next.workItems.find(row => row.id === work.id);
    let changed = false;
    if (nextStatus !== work.status) {
      changed = true;
      edited.status = nextStatus;
      addHistory(next, work.id, session.activeActorId, env.now(), '상태', work.status, nextStatus);
      if (work.status === '완료') delete edited.completion;
      if (nextStatus === '완료') edited.completion = { completedBy: session.activeActorId, completedAt: env.now(), ...(completionMemo ? { memo: completionMemo } : {}) };
    } else if (nextStatus === '완료' && completionMemo !== (edited.completion?.memo ?? '')) {
      changed = true;
      addHistory(next, work.id, session.activeActorId, env.now(), '완료 메모', edited.completion?.memo ?? null, completionMemo || null);
      if (completionMemo) edited.completion.memo = completionMemo; else delete edited.completion.memo;
    }
    if (nextStatus === '반환') {
      if (edited.returnReason !== returnReason) {
        changed = true;
        addHistory(next, work.id, session.activeActorId, env.now(), '반환 사유', edited.returnReason ?? null, returnReason);
        edited.returnReason = returnReason;
      }
    } else if (edited.returnReason !== undefined) {
      changed = true;
      addHistory(next, work.id, session.activeActorId, env.now(), '반환 사유', edited.returnReason, null);
      delete edited.returnReason;
    }
    for (const field of ['schedule','memo']) if (cmd.payload[field] !== undefined) {
      const value = cmd.payload[field] === '' ? undefined : cmd.payload[field];
      if (value !== edited[field]) {
        changed = true;
        addHistory(next, work.id, session.activeActorId, env.now(), field, edited[field] ?? null, value ?? null);
        if (value === undefined) delete edited[field]; else edited[field] = value;
      }
    }
    if (!changed) return success(next, []);
    edited.revision++;
    recalculate(next, work.requestId, session.activeActorId, env);
    if (work.status !== '반환' && nextStatus === '반환') addNotifications(next, '작업 반환', requestFor(next, edited), [edited], env);
    else if (work.status === '반환' && nextStatus !== '반환') addNotifications(next, '반환 정정', requestFor(next, edited), [edited], env);
    return success(next, [work.id, work.requestId]);
  }
  static returnWork(cmd, session, env) {
    return WorkItemCommands.updateWork({ ...cmd, payload: { ...cmd.payload, returnReason: cmd.payload?.returnReason ?? cmd.payload?.reason, nextStatus: '반환' } }, session, env);
  }
  static reassignReturnedWork(cmd, session, env) {
    const { state } = env;
    const work = targetFor(state, 'workItems', cmd);
    if (work.ok === false) return work;
    if (!permitted(session, env, 'reassignReturnedWork')) return failure(state, 'FORBIDDEN');
    if (work.status !== '반환' || work.resolvedByWorkItemIds.length || requestFor(state, work)?.status === '취소') return failure(state, 'INVALID_STATE');
    const teamIds = cmd.payload?.teamIds ?? [], teams = env.teams ?? FixtureCatalog.load().teams;
    if (!teamIds.length || new Set(teamIds).size !== teamIds.length || teamIds.some(id => !teams.includes(id) || id === work.teamId)) return failure(state, 'VALIDATION', { fieldErrors: { teamIds: '다른 작업반을 선택하세요.' } });
    if (env.fail?.('reassignReturnedWork')) return failure(state, 'SAVE_FAILED');
    const next = structuredClone(state), old = next.workItems.find(row => row.id === work.id), request = requestFor(state, work);
    const workNumbers = nextWorkNumbers(state, request, teamIds.length);
    const created = teamIds.map((teamId, index) => ({ id: env.id?.() ?? crypto.randomUUID(), requestId: work.requestId, workNumber: workNumbers[index], teamId, status: '배정', origin: 'assigned', replacesWorkItemId: old.id, resolvedByWorkItemIds: [], revision: 1 }));
    old.resolvedByWorkItemIds = created.map(item => item.id); old.revision++;
    next.workItems.push(...created);
    addHistory(next, old.id, session.activeActorId, env.now(), '재배정', null, teamIds.join(', '));
    for (const item of created) addHistory(next, item.id, session.activeActorId, env.now(), '배정', null, item.teamId);
    recalculate(next, work.requestId, session.activeActorId, env);
    addNotifications(next, '작업 배정', requestFor(next, old), created, env);
    return success(next, [old.id, ...created.map(item => item.id), work.requestId]);
  }
  static updateWorkDetails(cmd, session, env) {
    const work = checkWork(cmd, session, env, 'updateWorkDetails');
    if (work.ok === false) return work;
    if (!['배정','작업 중'].includes(work.status)) return failure(env.state, 'INVALID_STATE');
    const payload = cmd.payload ?? {};
    if (!Object.keys(payload).length || Object.keys(payload).some(field => !['schedule','memo'].includes(field))) return failure(env.state, 'VALIDATION');
    const next = structuredClone(env.state), edited = next.workItems.find(row => row.id === work.id);
    let changed = false;
    for (const field of Object.keys(payload)) {
      const value = payload[field] === '' ? undefined : payload[field];
      if (edited[field] === value) continue;
      changed = true;
      addHistory(next, work.id, session.activeActorId, env.now(), field, edited[field], value);
      if (value === undefined) delete edited[field]; else edited[field] = value;
    }
    if (changed) edited.revision++;
    return success(next, changed ? [work.id] : []);
  }
}
