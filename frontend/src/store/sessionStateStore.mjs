import { FixtureCatalog } from '../bootstrap/fixtureCatalog.mjs';
import { AppStateFactory } from '../bootstrap/appStateFactory.mjs';
import { SessionManager } from '../session/sessionManager.mjs';
import { RequestCommands } from '../workflow/requestCommands.mjs';
import { WorkItemCommands } from '../workflow/workItemCommands.mjs';
import { AfterActionReportCommand } from '../workflow/afterActionReportCommand.mjs';

const commands = {
  createRequest: RequestCommands.createRequest,
  updateRequest: RequestCommands.updateRequest,
  cancelRequest: RequestCommands.cancelRequest,
  moveToDocumentWaiting: RequestCommands.moveToDocumentWaiting,
  assignTeams: RequestCommands.assignTeams,
  updateWork: WorkItemCommands.updateWork,
  returnWork: WorkItemCommands.returnWork,
  reassignReturnedWork: WorkItemCommands.reassignReturnedWork,
  updateWorkDetails: WorkItemCommands.updateWorkDetails,
  createAfterActionReport: AfterActionReportCommand.createAfterActionReport
};
const resolveTarget = (state, command) => {
  if (!command.requestNumber) return command;
  const request = state.requests.find(item => item.requestNumber === command.requestNumber);
  const target = command.workNumber
    ? state.workItems.find(item => item.requestId === request?.id && item.workNumber === command.workNumber)
    : request;
  return { ...command, targetId: target?.id };
};
const publicFailure = result => ({
  ok: false, errorCode: result.errorCode,
  ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  ...(result.errorCode === 'CONFLICT' ? { refreshRequired: true } : {})
});
export class SessionStateStore {
  constructor(options = {}) {
    const bundle = FixtureCatalog.load();
    this.accounts = bundle.accounts;
    this.teams = bundle.teams;
    this.state = AppStateFactory.createInitialState(bundle);
    this.session = { activeActorId: bundle.accounts[0].id };
    this.listeners = new Set();
    this.busy = false;
    this.options = options;
  }
  getSnapshot = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getActor = () => this.accounts.find(actor => actor.id === this.session.activeActorId);
  switchActor(actorId) {
    this.session = SessionManager.switchActor(this.session, actorId, this.accounts);
    for (const listener of this.listeners) listener();
  }
  dispatch(command) {
    const state = this.state;
    if (this.busy) return { ok: false, errorCode: 'DUPLICATE_ACTION' };
    if (!command?.operationId || !commands[command.type] || command.targetId !== undefined) return { ok: false, errorCode: 'VALIDATION' };
    const actorId = this.session.activeActorId;
    const fingerprint = JSON.stringify([actorId, command.type, command.requestNumber, command.workNumber, command.expectedRevision, command.payload]);
    const receipt = state.receipts[command.operationId];
    if (receipt) {
      if (receipt.actorId !== actorId || receipt.fingerprint !== fingerprint) return { ok: false, errorCode: 'DUPLICATE_ACTION' };
      return { ok: true, requestNumber: receipt.requestNumber, replayed: true };
    }
    const internalCommand = resolveTarget(state, command);
    if (this.options.conflict?.(internalCommand) && internalCommand.targetId) {
      const next = structuredClone(state);
      const target = [...next.requests, ...next.workItems].find(item => item.id === internalCommand.targetId);
      if (target) {
        target.revision++;
        if ('detail' in target) target.detail = '다른 담당자가 수정한 최신 신청 내용';
        else target.memo = '다른 담당자가 수정한 최신 작업 메모';
        next.history.push({ targetId: target.id, actorId: 'bnoc-1', at: this.options.now?.() ?? new Date().toISOString(), field: '수정', before: null, after: '최신 내용 반영' });
        this.state = next;
        for (const listener of this.listeners) listener();
        return { ok: false, errorCode: 'CONFLICT', refreshRequired: true };
      }
    }
    this.busy = true;
    try {
      const env = {
        state, accounts: this.accounts, teams: this.teams,
        now: this.options.now ?? (() => new Date().toISOString()),
        id: this.options.id ?? (() => crypto.randomUUID()),
        fail: this.options.fail
      };
      const result = commands[command.type](internalCommand, this.session, env);
      if (!result.ok) return publicFailure(result);
      result.nextState.receipts[command.operationId] = { operationId: command.operationId, actorId, fingerprint, changedIds: result.changedIds, requestNumber: result.requestNumber, resultCode: 'OK' };
      this.state = result.nextState;
      for (const listener of this.listeners) listener();
      return { ok: true, requestNumber: result.requestNumber };
    } finally { this.busy = false; }
  }
}
