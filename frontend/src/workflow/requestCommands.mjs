import { AccessPolicy } from '../session/accessPolicy.mjs';
import { FixtureCatalog } from '../bootstrap/fixtureCatalog.mjs';
import { NotificationRules } from './notificationRules.mjs';

export const failure = (state, errorCode, extra = {}) => ({ ok: false, state, errorCode, ...extra });
export const success = (nextState, changedIds, extra = {}) => ({ ok: true, nextState, changedIds, ...extra });
export const actorFor = (session, env) => env.accounts.find(actor => actor.id === session.activeActorId);
export const roleFor = actor => ({
  actor, role: actor.role, teamId: actor.teamId,
  allowedActions: new Set(actor.role === 'requester'
    ? ['createRequest','updateRequest','cancelRequest']
    : actor.role === 'bnoc'
      ? ['createRequest','updateRequest','moveToDocumentWaiting','assignTeams','reassignReturnedWork']
      : ['updateWork','returnWork','updateWorkDetails','createAfterActionReport'])
});
export const permitted = (session, env, action, target) => {
  const actor = actorFor(session, env);
  return actor && AccessPolicy.canPerform(roleFor(actor), action, target);
};
export const targetFor = (state, kind, cmd) => {
  const item = state[kind].find(row => row.id === cmd.targetId);
  if (!item) return failure(state, 'NOT_FOUND');
  if (!Number.isInteger(cmd.expectedRevision)) return failure(state, 'VALIDATION', { fieldErrors: { expectedRevision: '버전이 필요합니다.' } });
  if (item.revision !== cmd.expectedRevision) return failure(state, 'CONFLICT', { latestValue: structuredClone(item) });
  return item;
};
export const addHistory = (state, targetId, actorId, at, field, before, after) => {
  state.history.push({ targetId, actorId, at, field, before, after });
};
export const addNotifications = (state, type, request, workItems, env) => {
  state.notifications.push(...NotificationRules.notificationsFor({ type, request, workItems }, { accounts: env.accounts }, env.now()));
};
export const validateRequest = payload => {
  const errors = {};
  for (const field of ['category','detail','location','contact']) if (!String(payload?.[field] ?? '').trim()) errors[field] = '필수 입력입니다.';
  if (!['장비/체계','회의 지원'].includes(payload?.category)) errors.category = '요청 유형을 선택하세요.';
  const sub = payload?.subcategories ?? {};
  const required = payload?.category === '장비/체계' ? ['systemType','resourceType','workType'] : ['meetingType'];
  for (const field of required) {
    if (!String(sub[field] ?? '').trim()) errors[field] = '필수 입력입니다.';
  }
  const allowed = {
    systemType: ['인트라넷','인터넷','AFCCS','KJCCS','기타'],
    resourceType: ['회선','전화','PC','기타'],
    workType: ['신설','고장','지원','이전','기타'],
    meetingType: ['화상회의','일반회의','기타']
  };
  for (const field of required) if (sub[field] && !allowed[field].includes(sub[field])) errors[field] = '허용된 값을 선택하세요.';
  if (payload?.maintenanceTarget) for (const field of ['department','rank','name','phone']) {
    if (!String(payload.maintenanceTarget[field] ?? '').trim()) errors[`maintenanceTarget.${field}`] = '필수 입력입니다.';
  }
  if (payload?.attachments?.some(file => !file.fileName || !Number.isFinite(file.size) || !file.type)) errors.attachments = '첨부 정보를 확인하세요.';
  return errors;
};
const requestFields = ['detail','location','contact','scheduledAt','documentRef','attachments'];
const nowId = env => env.id?.() ?? crypto.randomUUID();
export const nextRequestNumber = state => String(Math.max(100, ...state.requests.map(request => Number(request.requestNumber) || 0)) + 1);
export const nextWorkNumbers = (state, request, count = 1) => {
  const max = Math.max(0, ...state.workItems.filter(work => work.requestId === request.id).map(work => Number(work.workNumber?.split('-').at(-1)) || 0));
  return Array.from({ length: count }, (_, index) => `${request.requestNumber}-${max + index + 1}`);
};

export class RequestCommands {
  static createRequest(cmd, session, env) {
    const { state } = env;
    if (!permitted(session, env, 'createRequest')) return failure(state, 'FORBIDDEN');
    const actor = actorFor(session, env), payload = cmd.payload ?? {};
    const fieldErrors = validateRequest(payload);
    if (actor.role === 'bnoc' && !String(payload.requesterDisplayText ?? '').trim()) fieldErrors.requesterDisplayText = '실제 요청자를 입력하세요.';
    if (Object.keys(fieldErrors).length) return failure(state, 'VALIDATION', { fieldErrors });
    if (env.fail?.('createRequest')) return failure(state, 'SAVE_FAILED');
    const next = structuredClone(state), id = nowId(env), requestNumber = nextRequestNumber(state), at = env.now();
    const request = {
      id, requestNumber, registeredBy: actor.id,
      ...(actor.role === 'requester' ? { requesterActorId: actor.id } : {}),
      requesterDisplayText: actor.role === 'requester' ? `${actor.rank ?? ''} ${actor.displayName ?? actor.id} · ${actor.department ?? ''}`.trim() : payload.requesterDisplayText.trim(),
      category: payload.category, subcategories: structuredClone(payload.subcategories),
      detail: payload.detail.trim(), location: payload.location.trim(), contact: payload.contact.trim(),
      ...(payload.equipmentId ? { equipmentId: payload.equipmentId } : {}),
      ...(payload.maintenanceTarget ? { maintenanceTarget: structuredClone(payload.maintenanceTarget) } : {}),
      ...(payload.scheduledAt ? { scheduledAt: payload.scheduledAt } : {}),
      ...(payload.documentRef ? { documentRef: payload.documentRef } : {}),
      attachments: structuredClone(payload.attachments ?? []),
      status: '대기', registeredAt: at, revision: 1
    };
    next.requests.push(request);
    addHistory(next, id, actor.id, at, '등록', null, '대기');
    addNotifications(next, '요청 등록', request, [], env);
    return success(next, [id], { requestNumber });
  }
  static updateRequest(cmd, session, env) {
    const { state } = env;
    const request = targetFor(state, 'requests', cmd);
    if (request.ok === false) return request;
    if (!permitted(session, env, 'updateRequest', request)) return failure(state, 'FORBIDDEN');
    if (request.status === '취소' || (actorFor(session, env).role === 'requester' && state.workItems.some(work => work.requestId === request.id && ['작업 중','완료'].includes(work.status)))) return failure(state, 'INVALID_STATE');
    const payload = cmd.payload ?? {};
    if (!Object.keys(payload).length || Object.keys(payload).some(key => !requestFields.includes(key))) return failure(state, 'VALIDATION');
    const next = structuredClone(state), edited = next.requests.find(row => row.id === request.id);
    let changed = false;
    for (const field of Object.keys(payload)) {
      const value = ['scheduledAt','documentRef'].includes(field) && payload[field] === '' ? undefined : payload[field];
      if (['detail','location','contact'].includes(field) && !String(value ?? '').trim()) return failure(state, 'VALIDATION', { fieldErrors: { [field]: '필수 입력입니다.' } });
      if (field === 'attachments' && (!Array.isArray(payload.attachments) || payload.attachments.some(file => !file.fileName || !Number.isFinite(file.size) || !file.type))) return failure(state, 'VALIDATION', { fieldErrors: { attachments: '첨부 정보를 확인하세요.' } });
      if (JSON.stringify(edited[field]) === JSON.stringify(value)) continue;
      changed = true;
      addHistory(next, request.id, session.activeActorId, env.now(), field,
        field === 'attachments' ? edited.attachments.map(file => file.fileName).join(', ') : edited[field],
        field === 'attachments' ? payload.attachments.map(file => file.fileName).join(', ') : value);
      if (value === undefined) delete edited[field]; else edited[field] = structuredClone(value);
    }
    if (changed) edited.revision++;
    return success(next, changed ? [request.id] : []);
  }
  static cancelRequest(cmd, session, env) {
    const { state } = env;
    const request = targetFor(state, 'requests', cmd);
    if (request.ok === false) return request;
    if (!permitted(session, env, 'cancelRequest', request) || !request.requesterActorId) return failure(state, 'FORBIDDEN');
    if (request.status === '취소') return failure(state, 'INVALID_STATE');
    const next = structuredClone(state), edited = next.requests.find(row => row.id === request.id);
    edited.status = '취소'; edited.revision++;
    addHistory(next, request.id, session.activeActorId, env.now(), '상태', request.status, '취소');
    addNotifications(next, '취소', edited, [], env);
    return success(next, [request.id]);
  }
  static moveToDocumentWaiting(cmd, session, env) {
    const { state } = env;
    const request = targetFor(state, 'requests', cmd);
    if (request.ok === false) return request;
    if (!permitted(session, env, 'moveToDocumentWaiting', request)) return failure(state, 'FORBIDDEN');
    if (request.status !== '대기' || state.workItems.some(work => work.requestId === request.id)) return failure(state, 'INVALID_STATE');
    const next = structuredClone(state), edited = next.requests.find(row => row.id === request.id);
    edited.status = '문서 대기'; edited.revision++;
    addHistory(next, request.id, session.activeActorId, env.now(), '상태', request.status, edited.status);
    addNotifications(next, '문서 대기', edited, [], env);
    return success(next, [request.id]);
  }
  static assignTeams(cmd, session, env) {
    const { state } = env;
    const request = targetFor(state, 'requests', cmd);
    if (request.ok === false) return request;
    if (!permitted(session, env, 'assignTeams', request)) return failure(state, 'FORBIDDEN');
    if (!['대기','문서 대기'].includes(request.status) || state.workItems.some(work => work.requestId === request.id)) return failure(state, 'INVALID_STATE');
    const teamIds = cmd.payload?.teamIds ?? [], teams = env.teams ?? FixtureCatalog.load().teams;
    if (!teamIds.length || new Set(teamIds).size !== teamIds.length || teamIds.some(id => !teams.includes(id))) return failure(state, 'VALIDATION', { fieldErrors: { teamIds: '작업반을 확인하세요.' } });
    if (env.fail?.('assignTeams')) return failure(state, 'SAVE_FAILED');
    const next = structuredClone(state), edited = next.requests.find(row => row.id === request.id);
    const workNumbers = nextWorkNumbers(state, request, teamIds.length);
    const workItems = teamIds.map((teamId, index) => ({ id: nowId(env), requestId: request.id, workNumber: workNumbers[index], teamId, status: '배정', origin: 'assigned', resolvedByWorkItemIds: [], revision: 1 }));
    next.workItems.push(...workItems); edited.status = '배정'; edited.revision++;
    addHistory(next, request.id, session.activeActorId, env.now(), '상태', request.status, '배정');
    for (const work of workItems) addHistory(next, work.id, session.activeActorId, env.now(), '배정', null, work.teamId);
    addNotifications(next, '작업 배정', edited, workItems, env);
    addNotifications(next, '배정', edited, [], env);
    return success(next, [request.id, ...workItems.map(work => work.id)]);
  }
}
