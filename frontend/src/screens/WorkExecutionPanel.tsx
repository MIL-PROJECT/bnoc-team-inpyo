import { useEffect, useRef, useState } from 'react';
import type { WorkItemView, RequestStatus, Roster } from '../types';
import type { RunCommand } from './RequestRegistrationForm';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { displayTime, localInputToUtc, utcToLocalInput } from '../app/dateTime.mjs';
import { ResourceStatus } from './ResourceStatus';
import { focusFormError, saveFailureMessage } from '../app/formFeedback.mjs';
const workInput = (work: WorkItemView) => ({ nextStatus: work.status, schedule: utcToLocalInput(work.schedule), memo: work.memo ?? '', returnReason: work.returnReason ?? '', completionMemo: work.completion?.memo ?? '', assignedPersonRefs: work.assignedPersonRefs ?? work.assignedPersons?.map(person => person.personRef) ?? [], reusePreviousSchedule:false });
export function WorkExecutionPanel({ requestNumber, work, requestStatus, api, run, onRefresh }: { requestNumber: string; work: WorkItemView; requestStatus: RequestStatus; api: ApiClient; run: RunCommand; onRefresh: () => void }) {
  const [input, setInput] = useState(() => workInput(work));
  const [original, setOriginal] = useState(() => JSON.stringify(workInput(work))), [baseRevision, setBaseRevision] = useState(work.revision);
  const [message, setMessage] = useState(''), [errors, setErrors] = useState<Record<string,string>>({}), [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLElement>(null), feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (failed) focusFormError(panelRef.current, feedbackRef.current); }, [errors, message, failed]);
  const { saving, submit } = useSubmission(run);
  const dirty = JSON.stringify(input) !== original;
  useUnsavedChanges(dirty);
  const roster = useResource<Roster>(signal => api.getRoster(work.teamId, signal), [api, work.teamId]);
  const reset = () => { const next = workInput(work); setInput(next); setOriginal(JSON.stringify(next)); setBaseRevision(work.revision); setErrors({}); setConflict(false); setFailed(false); };
  const change = (next: typeof input) => { setInput(next); setErrors({}); setMessage(''); setFailed(false); };
  const errorId = (field: string) => `work-${work.workNumber}-${field}-error`;
  useEffect(() => { if (work.revision !== baseRevision) { if (dirty) setConflict(true); else reset(); } }, [work.revision]);
  const save = async () => {
    setMessage(''); setFailed(false);
    const payload:Record<string,unknown>={...input,schedule:localInputToUtc(input.schedule) ?? ''};
    if(work.status==='반환' && input.nextStatus!=='반환') payload.reusePreviousSchedule=input.reusePreviousSchedule;
    else delete payload.reusePreviousSchedule;
    const result = await submit('updateWork', payload, { requestNumber, workNumber: work.workNumber }, baseRevision);
    if (!result) return;
    if (result.ok) { setOriginal(JSON.stringify(input)); setBaseRevision(result.revision ?? baseRevision); setErrors({}); setConflict(false); setMessage(`작업 ${work.workNumber}의 상태·일정·담당 인원을 저장했습니다. 저장 상태: ${input.nextStatus}.`); onRefresh(); }
    else { setErrors(result.fieldErrors ?? {}); setConflict(result.errorCode === 'CONFLICT'); setMessage(saveFailureMessage(result)); setFailed(true); }
  };
  const people = [...(roster.data?.entries ?? []).filter(person => person.active !== false), ...(work.assignedPersons ?? []).filter(person => !(roster.data?.entries ?? []).some(entry => entry.personRef === person.personRef && entry.active !== false))];
  return <article ref={panelRef} className="work-card"><div className="row-head"><h3>{work.teamId} · 작업 {work.workNumber}</h3><span className={`badge status-${work.status.replace(' ','-')}`}>{work.status}</span></div>
    <p>작업 일정: {displayTime(work.schedule)}</p>{work.assignedAt && <small>배정 시각(접수 시간): {displayTime(work.assignedAt)}</small>}{work.status==='반환' && work.previousSchedule && <p className="muted">반환 전 일정: {displayTime(work.previousSchedule)}</p>}
    {work.returnReason && <p>반환 사유: {work.returnReason}</p>}{work.resolved && <p className="muted">{work.resolutionKind==='withdrawn'?'반환된 부서 배정이 해제된 과거 작업입니다.':'재배정된 이전 작업입니다.'}</p>}
    {work.completion && <p>완료: {displayTime(work.completion.completedAt)} · {work.completion.completedBy} · {work.completion.memo || '메모 없음'}</p>}
    {requestStatus !== '취소' && work.editable && <fieldset disabled={saving}>
      <label className="field"><span>작업 상태</span><select value={input.nextStatus} aria-label="작업 상태" aria-invalid={!!errors.nextStatus} aria-describedby={errors.nextStatus ? errorId('nextStatus') : undefined} onChange={e => change({ ...input, nextStatus: e.target.value as WorkItemView['status'] })}>{['배정','작업 중','완료','반환'].map(status => <option key={status}>{status}</option>)}</select>{errors.nextStatus && <small id={errorId('nextStatus')} className="field-error">{errors.nextStatus}</small>}</label>
      {work.status==='반환' && input.nextStatus!=='반환' && work.previousSchedule && <label className="check"><input type="checkbox" checked={input.reusePreviousSchedule} onChange={e=>change({...input,reusePreviousSchedule:e.target.checked,schedule:''})}/>반환 전 일정 재사용 ({displayTime(work.previousSchedule)})</label>}
      <fieldset aria-invalid={!!errors.assignedPersonRefs} tabIndex={errors.assignedPersonRefs ? -1 : undefined} aria-describedby={errors.assignedPersonRefs ? errorId('assignedPersonRefs') : undefined}><legend>담당 인원 (선택)</legend><ResourceStatus loading={roster.loading} error={roster.error} retry={roster.reload} />{people.length ? people.map(person => <label className="check" key={person.personRef}><input type="checkbox" checked={input.assignedPersonRefs.includes(person.personRef)} onChange={e => change({ ...input, assignedPersonRefs: e.target.checked ? [...input.assignedPersonRefs, person.personRef] : input.assignedPersonRefs.filter(ref => ref !== person.personRef) })} />{person.displayName}{person.active === false ? ' · 비활성' : ''}</label>) : !roster.loading && !roster.error && <p className="muted">등록된 명부가 없습니다. 담당 인원을 선택하지 않고 저장할 수 있습니다.</p>}{errors.assignedPersonRefs && <p id={errorId('assignedPersonRefs')} className="field-error">{errors.assignedPersonRefs}</p>}</fieldset>
      <div className="form-grid"><label className="field"><span>일정<small className="field-hint" aria-hidden="true">선택</small></span><input type="datetime-local" value={input.schedule} disabled={input.reusePreviousSchedule} aria-label="일정" aria-invalid={!!errors.schedule} aria-describedby={errors.schedule ? errorId('schedule') : undefined} onChange={e => change({ ...input, schedule: e.target.value })} />{errors.schedule && <small id={errorId('schedule')} className="field-error">{errors.schedule}</small>}</label><label className="field"><span>작업 메모<small className="field-hint" aria-hidden="true">선택</small></span><input maxLength={2000} value={input.memo} aria-label="작업 메모" aria-invalid={!!errors.memo} aria-describedby={errors.memo ? errorId('memo') : undefined} onChange={e => change({ ...input, memo: e.target.value })} />{errors.memo && <small id={errorId('memo')} className="field-error">{errors.memo}</small>}</label></div>
      {input.nextStatus === '완료' && <label className="field"><span>완료 메모<small className="field-hint" aria-hidden="true">선택</small></span><input maxLength={2000} value={input.completionMemo} aria-label="완료 메모" aria-invalid={!!errors.completionMemo} aria-describedby={errors.completionMemo ? errorId('completionMemo') : undefined} onChange={e => change({ ...input, completionMemo: e.target.value })} />{errors.completionMemo && <small id={errorId('completionMemo')} className="field-error">{errors.completionMemo}</small>}</label>}
      {input.nextStatus === '반환' && <label className="field"><span>반환 사유<small className="field-hint" aria-hidden="true">필수</small></span><input maxLength={2000} value={input.returnReason} aria-label="반환 사유" aria-required="true" aria-invalid={!!errors.returnReason} aria-describedby={errors.returnReason ? errorId('returnReason') : undefined} onChange={e => change({ ...input, returnReason: e.target.value })} />{errors.returnReason && <small id={errorId('returnReason')} className="field-error">{errors.returnReason}</small>}{work.schedule && <small className="field-hint">반환하면 현재 일정은 해제되며 이력으로 보존됩니다.</small>}</label>}
      <button className="primary" onClick={() => void save()} disabled={saving || conflict}>{saving ? '저장 중…' : '상태 저장'}</button>
    </fieldset>}
    {message && <p ref={feedbackRef} tabIndex={-1} role={failed ? 'alert' : 'status'} className={failed ? 'error' : 'notice'}>{message}</p>}
    {dirty && !message && <p className="draft-status" role="status">작업 {work.workNumber}에 저장하지 않은 변경이 있습니다.</p>}
    {conflict && <div className="notice" role="alert"><p>다른 변경이 반영됐습니다. 입력 내용은 유지됩니다.</p><button onClick={onRefresh}>최신 작업 조회</button><button onClick={() => { reset(); setMessage('현재 조회된 내용을 불러왔습니다. 다시 선택하세요.'); }}>조회한 내용으로 다시 선택</button></div>}
  </article>;
}
