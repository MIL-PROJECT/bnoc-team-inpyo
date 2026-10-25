import { useEffect, useRef, useState } from 'react';
import type { Actor, AttachmentMeta, RequestDetail } from '../types';
import { priorityLabel } from '../types';
import type { RunCommand } from './RequestRegistrationForm';
import { ApiClient } from '../api/apiClient.mjs';
import { errorMessage, useResource } from '../app/useResource';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { displayTime } from '../app/dateTime.mjs';
import { schedulePreferenceInput, schedulePreferencesFromInput } from '../api/schedulePreferences.mjs';
import { displayInterval } from '../app/scheduleIntervals.mjs';
import { WorkExecutionPanel } from './WorkExecutionPanel';
import { HistoryPanel } from './HistoryPanel';
import { ResourceStatus } from './ResourceStatus';
import { AttachmentPicker, type UploadAttachment } from './AttachmentPicker';
import { focusFormError, saveFailureMessage } from '../app/formFeedback.mjs';
import { requestDetailGuidance, requestLocationGuidance } from '../app/requestGuidance.mjs';
import { StatusBadge, StatusProcess } from '../ui/WorkflowStatus';
import { AttachmentDocumentDialog } from './AttachmentDocumentDialog';
import { Button } from '../ui/Button';
type DetailDraft = { detail: string; location: string; contact: string; personalContact: string; preference1Date: string; preference1Period: string; preference2Date: string; preference2Period: string; documentRef: string; attachments: AttachmentMeta[] };
const editingInput = (detail: RequestDetail): DetailDraft => ({ detail: detail.detail, location: detail.location, contact: detail.contact ?? '', personalContact: detail.personalContact ?? '', ...schedulePreferenceInput(detail.schedulePreferences), documentRef: detail.documentRef ?? '', attachments: detail.attachments });
export function RequestDetailWorkspace({ actor, requestNumber, api, teams, run, upload, revision = 0, onBack, onAssigned, initialMessage = '', initialAttachmentId, initialAttachmentSearchTerm, initialAttachmentBlockIndex, initialAttachmentMetadataIndex, onAttachmentOpened, onReuseRequest }: { actor: Actor; requestNumber: string; api: ApiClient; teams: string[]; run: RunCommand; upload: UploadAttachment; revision?: number; onBack: () => void; onAssigned?: (message: string) => void; initialMessage?: string; initialAttachmentId?: string; initialAttachmentSearchTerm?: string; initialAttachmentBlockIndex?: number; initialAttachmentMetadataIndex?: number; onAttachmentOpened?: () => void; onReuseRequest?: (number:string)=>Promise<void> }) {
  const result = useResource<RequestDetail>(signal => api.getRequestDetail(requestNumber, signal), [api, actor.id, requestNumber, revision]);
  const detail = result.data;
  const [reusing,setReusing]=useState(false);
  const [selected, setSelected] = useState<string[]>([]), [reassignment, setReassignment] = useState<Record<string,string[]>>({}), [addingTeams,setAddingTeams]=useState<string[]>([]);
  const [priorityDraft, setPriorityDraft] = useState<string|null>(null), [editingPriority,setEditingPriority]=useState(false), [editing, setEditing] = useState(false), [draft, setDraft] = useState<DetailDraft | null>(null), [draftRevision, setDraftRevision] = useState(0);
  const [assignmentRevision,setAssignmentRevision] = useState<number | null>(null), [priorityRevision,setPriorityRevision] = useState<number | null>(null), [reassignmentRevisions,setReassignmentRevisions] = useState<Record<string,number>>({});
  const [rejectionReason,setRejectionReason] = useState('');
  const [selectedAttachment,setSelectedAttachment] = useState<string|null>(null);
  const [selectedAttachmentSearch,setSelectedAttachmentSearch] = useState<{term?:string;blockIndex?:number;metadataIndex?:number}>({});
  const openedInitialAttachment=useRef<string|null>(null);
  const [message, setMessage] = useState(initialMessage), [errors, setErrors] = useState<Record<string,string>>({}), [conflict, setConflict] = useState(false), [uploading, setUploading] = useState(false);
  const [failed,setFailed] = useState(false), [errorAction,setErrorAction] = useState('');
  const feedbackRef = useRef<HTMLParagraphElement>(null), formRef = useRef<HTMLElement | null>(null);
  useEffect(()=>{if(!detail || !initialAttachmentId || openedInitialAttachment.current===initialAttachmentId)return;openedInitialAttachment.current=initialAttachmentId;setSelectedAttachmentSearch({term:initialAttachmentSearchTerm,blockIndex:initialAttachmentBlockIndex,metadataIndex:initialAttachmentMetadataIndex});setSelectedAttachment(initialAttachmentId);onAttachmentOpened?.();},[detail?.requestNumber,initialAttachmentId,initialAttachmentSearchTerm,initialAttachmentBlockIndex,initialAttachmentMetadataIndex,onAttachmentOpened]);
  useEffect(() => { if (failed) focusFormError(formRef.current, feedbackRef.current); }, [errors, message, failed]);
  const { saving, submit } = useSubmission(run);
  const dirty = (editing && !!draft && !!detail && JSON.stringify(draft) !== JSON.stringify(editingInput(detail))) || selected.length > 0 || addingTeams.length>0 || Object.values(reassignment).some(items => items.length > 0) || (!!priorityDraft && priorityDraft!==detail?.priority) || !!rejectionReason.trim();
  useUnsavedChanges(dirty);
  const clearFeedback = () => { setErrors({}); setMessage(''); setFailed(false); };
  const reuse=async()=>{
    if(!detail || !onReuseRequest || reusing)return;
    setReusing(true);clearFeedback();
    try{await onReuseRequest(detail.requestNumber);}
    catch(error){setMessage(errorMessage(error instanceof Error?error:new Error('이전 요청을 불러오지 못했습니다.')));setFailed(true);}
    finally{setReusing(false);}
  };
  const changeDraft = (next: DetailDraft) => { setDraft(next); clearFeedback(); };
  const act = async (type: string, payload: Record<string,unknown>, workNumber?: string, expectedRevision = detail?.revision, form?: HTMLElement) => {
    if (!detail) return;
    formRef.current = form ?? null; setErrorAction(type + (workNumber ? ':' + workNumber : '')); setMessage(''); setFailed(false);
    const response = await submit(type, payload, { requestNumber: detail.requestNumber, ...(workNumber ? { workNumber } : {}) }, expectedRevision);
    if (!response) return;
    if (response.ok) {
      const successes: Record<string,string> = {
        updateRequest:`요청 ${detail.requestNumber} 내용을 저장했습니다.`,
        cancelRequest:`요청 ${detail.requestNumber}을 취소했습니다.`,
        rejectRequest:`요청 ${detail.requestNumber}을 기각했습니다.`,
        moveToDocumentWaiting:`요청 ${detail.requestNumber}을 문서 대기로 변경했습니다.`,
        assignTeams:`요청 ${detail.requestNumber}을 ${(payload.teamIds as string[] | undefined)?.join(', ')}에 배정했습니다.`,
        changePriority:`요청 ${detail.requestNumber}의 일반·긴급을 ${priorityLabel(payload.priority as string)}으로 저장했습니다.`,
        reassignAssignedWork:`작업 ${workNumber}의 배정을 ${(payload.teamIds as string[] | undefined)?.join(', ')}으로 변경했습니다.`,
        reassignReturnedWork:`작업 ${workNumber}을 ${(payload.teamIds as string[] | undefined)?.join(', ')}에 재배정했습니다.`,
        addTeams:`요청 ${detail.requestNumber}에 ${(payload.teamIds as string[] | undefined)?.join(', ')}을 추가 배정했습니다.`,
        withdrawReturnedWork:`작업 ${workNumber}의 부서 배정을 해제했습니다.`
      };
      const success = successes[type] ?? `요청 ${detail.requestNumber}의 변경을 저장했습니다.`;
      setSelected([]);setAddingTeams([]); setReassignment({}); setPriorityDraft(null);setEditingPriority(false); setAssignmentRevision(null);setPriorityRevision(null);setReassignmentRevisions({});setRejectionReason('');setEditing(false); setDraft(null); setConflict(false); setErrors({}); setMessage(success);
      if(type==='assignTeams'&&onAssigned)onAssigned(success);else result.reload();
    }
    else { setConflict(response.errorCode === 'CONFLICT'); setErrors(response.fieldErrors ?? {}); setMessage(saveFailureMessage(response)); setFailed(true); }
  };
  const beginEdit = () => { if (!detail) return; setEditing(true); setDraft(editingInput(detail)); setDraftRevision(detail.revision); clearFeedback(); };
  const reloadLatest = async () => { try { const latest = await api.getRequestDetail(requestNumber) as RequestDetail; if (editing) { setDraft(editingInput(latest)); setDraftRevision(latest.revision); } setSelected([]);setAddingTeams([]); setReassignment({}); setPriorityDraft(null);setEditingPriority(false);setAssignmentRevision(null);setPriorityRevision(null);setReassignmentRevisions({});setConflict(false); setErrors({}); setFailed(false); setMessage('최신 내용을 불러왔습니다. 다시 선택하세요.'); result.reload(); } catch (error) { setMessage(errorMessage(error instanceof Error ? error : new Error('최신 내용을 조회하지 못했습니다. 입력은 유지됩니다.'))); setFailed(true); } };
  const toggle = (values: string[], team: string) => values.includes(team) ? values.filter(item => item !== team) : [...values, team];
  const editErrors: Record<string,string> = errorAction === 'updateRequest' ? errors : {};
  const priorityErrors: Record<string,string> = errorAction === 'changePriority' ? errors : {};
  const assignmentErrors: Record<string,string> = errorAction === 'assignTeams' ? errors : {};
  const rejectionErrors: Record<string,string> = errorAction === 'rejectRequest' ? errors : {};
  const editField = (key: 'detail'|'location'|'contact'|'personalContact'|'documentRef') => {
    if (!draft) return null;
    const label = { detail:'내용',location:'위치',contact:'연락처',personalContact:'개인전화번호',documentRef:'문서 참조정보' }[key];
    const optional = key === 'documentRef' || key === 'personalContact';
    const errorId = `request-edit-${key}-error`;
    const hint=key==='documentRef'?'예: 관련 공문 제목이나 문서번호. 없으면 비워도 됩니다.':key==='personalContact'?'개인전화로도 연락받을 수 있으면 입력하세요.':undefined;
    const placeholder=key==='detail'&&detail?requestDetailGuidance({category:detail.category,...detail.subcategories}):key==='location'?requestLocationGuidance:undefined;
    const showHint=Boolean(hint);
    return <label className="field" key={key}><span>{label}<small className="field-hint" aria-hidden="true">{optional ? '선택' : '필수'}</small></span>{key === 'detail' ? <textarea rows={4} maxLength={10000} value={draft[key]} placeholder={placeholder} aria-label={label} aria-required="true" aria-invalid={!!editErrors[key]} aria-describedby={editErrors[key]?errorId:undefined} onChange={e => changeDraft({ ...draft, [key]:e.target.value })} /> : <input type={key==='personalContact'?'tel':'text'} autoComplete={key==='personalContact'?'tel':undefined} value={draft[key]} placeholder={placeholder} aria-label={label} aria-required={!optional} aria-invalid={!!editErrors[key]} aria-describedby={editErrors[key]?errorId:undefined} onChange={e => changeDraft({ ...draft, [key]:e.target.value })} />}{showHint && <small id={`${errorId}-hint`} className="field-hint">{hint}</small>}{editErrors[key] && <small id={errorId} className="field-error">{editErrors[key]}</small>}</label>;
  };
  return <><button className="back" onClick={onBack}>신청 목록</button><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {detail && <><div className="page-head"><div><small>요청 번호 {detail.requestNumber} · 등록 {displayTime(detail.registeredAt)}</small><h1>신청 상세</h1></div><StatusBadge status={detail.status} afterAction={detail.workItems.length>0&&detail.workItems.every(work=>work.origin==='after-action')} departments={detail.teamIds} /></div>
    <StatusProcess status={detail.status} afterAction={detail.workItems.length>0&&detail.workItems.every(work=>work.origin==='after-action')} />
    {actor.role==='requester'&&detail.canReuse&&onReuseRequest&&<div className="actions"><Button disabled={reusing||result.loading} onClick={()=>void reuse()}>{reusing?'불러오는 중…':'새 요청으로 불러오기'}</Button></div>}
    {actor.role==='team'&&detail.workItems.filter(work=>work.teamId===actor.teamId&&!work.resolved).map(work=><StatusProcess key={work.workNumber} status={work.status} work afterAction={work.origin==='after-action'} />)}
    {message && <p ref={feedbackRef} tabIndex={-1} role={failed ? 'alert' : 'status'} className={failed ? 'error' : 'notice'}>{message}</p>}
    {dirty && !message && <p className="draft-status" role="status">요청 {detail.requestNumber}에 저장하지 않은 변경이 있습니다.</p>}
    {conflict && <div className="notice" role="alert"><p>다른 변경이 반영됐습니다. 입력은 유지됩니다. 최신 내용을 불러오면 현재 입력을 교체합니다.</p><button onClick={() => void reloadLatest()}>최신 내용 다시 불러오기</button></div>}
    <div className="detail-grid" onChangeCapture={clearFeedback}><section className="card"><h2>신청 내용</h2><dl>
      <dt>요청자</dt><dd>{detail.requesterDisplayText}</dd><dt>유형</dt><dd>{detail.category}</dd><dt>일반·긴급</dt><dd>{priorityLabel(detail.priority)}</dd>
      <dt>위치</dt><dd>{detail.location}</dd>{typeof detail.contact === 'string' && <><dt>연락처</dt><dd>{detail.contact || '없음'}</dd></>}{typeof detail.personalContact === 'string' && detail.personalContact && <><dt>개인전화번호</dt><dd>{detail.personalContact}</dd></>}
      <dt>희망 일정</dt><dd>{detail.schedulePreferences.length ? detail.schedulePreferences.map(preference => <span className="preference-summary" key={preference.rank}>{preference.rank}지망 {preference.date} {preference.period==='AM'?'오전':'오후'}</span>) : '없음'}</dd><dt>문서</dt><dd>{detail.documentRef || '없음'}</dd>
      {detail.assignedAt && <><dt>배정 시각</dt><dd>{displayTime(detail.assignedAt)}<small>접수 시간</small></dd></>}
    </dl><p className="pre">{detail.detail}</p><p>{Object.values(detail.subcategories ?? {}).filter(Boolean).map(value => value === 'PC' ? '컴퓨터' : value === '전화' ? '전화기' : value).join(' · ')}</p>
    {detail.status==='기각' && detail.rejectionReason && <div className="notice section-gap"><strong>기각 사유</strong><p>{detail.rejectionReason}</p>{detail.rejectedAt && <small>{displayTime(detail.rejectedAt)}</small>}</div>}
    {detail.equipmentId && <p>장비 식별정보: {detail.equipmentId}</p>}{detail.maintenanceTarget && <p>정비대상자: {Object.values(detail.maintenanceTarget).filter(Boolean).join(' · ')}</p>}
    {detail.attachments.length ? <div><h3>첨부문서</h3>{detail.attachments.map(file => <p key={file.id}><a href={api.attachmentUrl(file.id)} download>{file.fileName}</a> · {Math.ceil(file.size/1024)} KB <button type="button" onClick={()=>setSelectedAttachment(file.id)}>문서 보기</button></p>)}</div> : <p className="muted">첨부 없음</p>}
    {detail.canEdit && <><button onClick={() => { if (editing && draft && JSON.stringify(draft) !== JSON.stringify(editingInput(detail)) && !window.confirm('저장하지 않은 수정이 있습니다. 입력을 버리고 닫을까요?')) return; if (editing) { setEditing(false); clearFeedback(); } else beginEdit(); }}>{editing ? '수정 닫기' : '내용 수정'}</button>{editing && draft && <form className="section-gap" onSubmit={event => { event.preventDefault(); if (uploading) return; void act('updateRequest', { detail:draft.detail, location:draft.location, contact:draft.contact, personalContact:draft.personalContact, schedulePreferences:schedulePreferencesFromInput(draft), documentRef:draft.documentRef, attachments:draft.attachments }, undefined, draftRevision, event.currentTarget); }}><fieldset disabled={saving}>
      {(['detail','location','contact'] as const).map(editField)}
      <details className="optional-fields"><summary>선택 정보</summary><fieldset className="preference-fields form-grid" aria-invalid={!!editErrors.schedulePreferences} tabIndex={editErrors.schedulePreferences ? -1 : undefined} aria-describedby={editErrors.schedulePreferences ? 'request-edit-schedulePreferences-error' : undefined}><legend>희망 일정 <small className="field-hint" aria-hidden="true">선택</small></legend>{[1,2].map(rank => <div className="preference-choice" key={rank}><strong>{rank}지망</strong><label className="field"><span>날짜</span><input type="date" value={draft[`preference${rank}Date` as keyof DetailDraft] as string} aria-label={`${rank}지망 날짜`} aria-invalid={rank===1 && !!editErrors.schedulePreferences} aria-describedby={rank===1 && editErrors.schedulePreferences ? 'request-edit-schedulePreferences-error' : undefined} onChange={e => changeDraft({ ...draft,[`preference${rank}Date`]:e.target.value })} /></label><label className="field"><span>오전·오후</span><select value={draft[`preference${rank}Period` as keyof DetailDraft] as string} aria-label={`${rank}지망 오전·오후`} onChange={e => changeDraft({ ...draft,[`preference${rank}Period`]:e.target.value })}><option value="">선택</option><option value="AM">오전</option><option value="PM">오후</option></select></label></div>)}{editErrors.schedulePreferences && <small id="request-edit-schedulePreferences-error" className="field-error">{editErrors.schedulePreferences}</small>}</fieldset><div className="form-grid">{editField('personalContact')}{editField('documentRef')}</div></details>
      <div aria-invalid={!!editErrors.attachments} tabIndex={editErrors.attachments ? -1 : undefined} aria-describedby={editErrors.attachments ? 'request-edit-attachments-error' : undefined}><AttachmentPicker files={draft.attachments} onChange={attachments => changeDraft({ ...draft, attachments })} upload={upload} onBusyChange={setUploading} label={detail.category==='회의 지원' && ['화상회의','일반회의'].includes(detail.subcategories.meetingType ?? '') && detail.attachments.length>0 ? `${detail.subcategories.meetingType} 지원 의뢰서 수정` : '첨부파일 수정'} required={detail.category==='회의 지원' && ['화상회의','일반회의'].includes(detail.subcategories.meetingType ?? '') && detail.attachments.length>0} />{editErrors.attachments && <p id="request-edit-attachments-error" className="field-error">{editErrors.attachments}</p>}</div>
      <button className="primary" type="submit" disabled={uploading || saving || conflict}>{saving ? '저장 중…' : '수정 저장'}</button></fieldset></form>}</>}
    {detail.canCancel && <button className="section-gap" disabled={saving} onClick={() => { if (window.confirm('이 신청을 취소할까요? 취소한 신청은 다시 시작할 수 없습니다.')) void act('cancelRequest', {}); }}>신청 취소</button>}
    </section><section><h2>작업반별 진행</h2>
      {detail.progress?.currentDepartments ? <p className="progress-summary">{detail.progress.completedDepartments}/{detail.progress.currentDepartments}개 부서 완료 · {detail.progress.totalWorks-detail.progress.completedWorks}개 작업 남음</p> : null}
      {detail.workItems.length ? detail.workItems.map(work => actor.role === 'team' && actor.teamId === work.teamId
        ? <WorkExecutionPanel key={work.workNumber} requestNumber={detail.requestNumber} work={work} requestStatus={detail.status} api={api} run={run} onRefresh={result.reload} />
        : <article className="work-card" key={work.workNumber}><div className="row-head"><h3>{work.teamId} · 작업 {work.workNumber}</h3><StatusBadge status={work.status} work afterAction={work.origin==='after-action'} department={work.teamId} /></div><p>작업 일정: {work.scheduleIntervals.length ? work.scheduleIntervals.map(displayInterval).join(' · ') : '미정'}</p>{work.assignedAt && <small>배정 시각(접수 시간): {displayTime(work.assignedAt)}</small>}{work.resolved && <p className="muted">{work.resolutionKind==='withdrawn'?'반환된 부서 배정 해제 · 해당 부서 작업 불필요':'재배정된 과거 작업'+(work.replacementWorkNumbers?.length?` · 새 작업 ${work.replacementWorkNumbers.join(', ')}`:'')}</p>}{work.previousScheduleIntervals.length>0 && work.status==='반환' && <p className="muted">반환 전 일정: {work.previousScheduleIntervals.map(displayInterval).join(' · ')}</p>}{work.assignedPersons?.length && actor.role === 'bnoc' ? <p>담당 인원: {work.assignedPersons.map(person => person.displayName).join(', ')}</p> : null}{actor.role === 'bnoc' && work.returnReason && <p>반환 사유: {work.returnReason}</p>}{work.completion && <p>완료: {displayTime(work.completion.completedAt)}{actor.role === 'bnoc' ? ' · ' + work.completion.completedBy : ''}</p>}</article>) : <p className="empty">배정된 작업이 없습니다.</p>}
    {actor.role === 'bnoc' && !['취소','기각'].includes(detail.status) && <>
      {detail.workItems.length > 0 && <section className="card section-gap"><h3>일반·긴급 분류</h3><p>현재 분류: <strong>{priorityLabel(detail.priority)}</strong></p>{!editingPriority ? <button onClick={()=>{setPriorityDraft(detail.priority==='urgent'?'urgent':'general');setPriorityRevision(detail.revision);setEditingPriority(true);clearFeedback();}}>분류 변경</button> : <form onSubmit={e => {e.preventDefault();void act('changePriority',{priority:priorityDraft},undefined,priorityRevision ?? detail.revision,e.currentTarget);}}><p className="muted">작업 상태와 일정은 유지됩니다.</p><label className="field"><span>일반·긴급</span><select value={priorityDraft ?? detail.priority ?? 'general'} disabled={saving} aria-label="일반·긴급" aria-invalid={!!priorityErrors.priority} aria-describedby={priorityErrors.priority ? 'classification-priority-error' : undefined} onChange={e=>{setPriorityRevision(value=>value ?? detail.revision);setPriorityDraft(e.target.value);clearFeedback();}}><option value="general">일반</option><option value="urgent">긴급</option></select>{priorityErrors.priority && <small id="classification-priority-error" className="field-error">{priorityErrors.priority}</small>}</label><div className="actions"><button type="submit" className="primary" disabled={saving || conflict || priorityDraft===detail.priority}>분류 저장</button><button type="button" onClick={()=>{setEditingPriority(false);setPriorityDraft(null);clearFeedback();}}>취소</button></div></form>}</section>}
      {detail.status === '대기' && !detail.workItems.length && <button disabled={saving} onClick={() => void act('moveToDocumentWaiting', {})}>문서 대기</button>}
      {detail.canReject && <form className="card section-gap" onSubmit={e=>{e.preventDefault();void act('rejectRequest',{reason:rejectionReason},undefined,detail.revision,e.currentTarget);}}><h3>요청 기각</h3><p className="muted">우리 부대가 담당하지 않는 요청을 사유와 함께 종결합니다.</p><label className="field"><span>기각 사유<small className="field-hint" aria-hidden="true">필수</small></span><textarea rows={3} maxLength={2000} value={rejectionReason} aria-label="기각 사유" aria-required="true" aria-invalid={!!rejectionErrors.reason} aria-describedby={rejectionErrors.reason?'request-rejection-reason-error':undefined} onChange={e=>{setRejectionReason(e.target.value);clearFeedback();}} />{rejectionErrors.reason && <small id="request-rejection-reason-error" className="field-error">{rejectionErrors.reason}</small>}</label><button className="primary" type="submit" disabled={saving || conflict || !rejectionReason.trim()}>요청 기각</button></form>}
      {detail.canAssign && <form className="card section-gap" onSubmit={e => { e.preventDefault(); void act('assignTeams', { teamIds:selected, priority:priorityDraft ?? detail.priority ?? 'general' },undefined,assignmentRevision ?? detail.revision,e.currentTarget); }}><h3>작업반 배정</h3><fieldset disabled={saving}><label className="field"><span>일반·긴급</span><select value={priorityDraft ?? 'general'} aria-label="일반·긴급" aria-invalid={!!assignmentErrors.priority} aria-describedby={assignmentErrors.priority ? 'assignment-priority-error' : undefined} onChange={e=>{setAssignmentRevision(value=>value ?? detail.revision);setPriorityDraft(e.target.value);clearFeedback();}}><option value="general">일반</option><option value="urgent">긴급</option></select>{assignmentErrors.priority && <small id="assignment-priority-error" className="field-error">{assignmentErrors.priority}</small>}</label>{teams.map(team => <label className="check" key={team}><input type="checkbox" checked={selected.includes(team)} aria-invalid={!!assignmentErrors.teamIds} aria-describedby={assignmentErrors.teamIds ? 'assignment-teams-error' : undefined} onChange={() => { setAssignmentRevision(value => value ?? detail.revision);setSelected(toggle(selected, team));clearFeedback(); }} />{team}</label>)}{assignmentErrors.teamIds && <p id="assignment-teams-error" className="field-error">{assignmentErrors.teamIds}</p>}<button className="primary" type="submit" disabled={saving || conflict}>선택 작업반 배정</button></fieldset></form>}
      {detail.canAddTeams && <form className="card section-gap" onSubmit={e=>{e.preventDefault();void act('addTeams',{teamIds:addingTeams},undefined,assignmentRevision ?? detail.revision,e.currentTarget);}}><h3>작업 부서 추가</h3><p className="muted">기존 분류는 유지하고 새 작업 일정은 미정으로 등록합니다.</p><fieldset disabled={saving}>{teams.filter(team=>!detail.teamIds.includes(team)).map(team=><label className="check" key={team}><input type="checkbox" checked={addingTeams.includes(team)} onChange={()=>{setAssignmentRevision(value=>value ?? detail.revision);setAddingTeams(toggle(addingTeams,team));clearFeedback();}}/>{team}</label>)}<button className="primary" type="submit" disabled={saving || conflict || addingTeams.length===0}>선택 부서 추가</button></fieldset></form>}
      {detail.workItems.filter(work => (work.status === '반환' || (work.status === '배정' && work.origin !== 'after-action')) && !work.resolved).map(work => {
        const direct = work.status === '배정';
        const command = direct ? 'reassignAssignedWork' : 'reassignReturnedWork';
        const reassignmentErrors: Record<string,string> = errorAction === command + ':' + work.workNumber ? errors : {};
        const candidates=teams.filter(team=>team!==work.teamId && !detail.teamIds.includes(team));
        return <form className="card section-gap" key={work.workNumber} onSubmit={e => { e.preventDefault(); void act(command, { teamIds: reassignment[work.workNumber] ?? [] }, work.workNumber, reassignmentRevisions[work.workNumber] ?? work.revision,e.currentTarget); }}><h3>{work.teamId} {direct ? '배정 변경' : '반환 작업'}</h3>{direct ? <p className="muted">반환 없이 다른 부서로 변경합니다. 기존 기록은 보존하고 새 작업 일정은 미정으로 등록합니다. 작업 준비·완료 상태에서는 변경할 수 없습니다.</p> : <p>{work.returnReason}</p>}{work.previousScheduleIntervals.length>0 && <p className="muted">기존 일정은 보존됐습니다: {work.previousScheduleIntervals.map(displayInterval).join(' · ')}</p>}<small>일반·긴급 분류 유지</small><fieldset disabled={saving}>{candidates.map(team => <label className="check" key={team}><input type="checkbox" checked={(reassignment[work.workNumber] ?? []).includes(team)} aria-invalid={!!reassignmentErrors.teamIds} aria-describedby={reassignmentErrors.teamIds ? `reassign-${work.workNumber}-teams-error` : undefined} onChange={() => { setReassignmentRevisions(values => ({ ...values,[work.workNumber]:values[work.workNumber] ?? work.revision }));setReassignment({ ...reassignment, [work.workNumber]: toggle(reassignment[work.workNumber] ?? [], team) });clearFeedback(); }} />{team}</label>)}{reassignmentErrors.teamIds && <p id={`reassign-${work.workNumber}-teams-error`} className="field-error">{reassignmentErrors.teamIds}</p>}<div className="actions">{candidates.length>0 && <button className="primary" type="submit" disabled={saving || conflict || !(reassignment[work.workNumber]?.length)}>{direct ? '배정 변경 저장' : '재배정'}</button>}{!direct && <button type="button" disabled={saving || conflict} onClick={()=>{if(window.confirm(`${work.teamId}의 반환 배정을 해제할까요?`))void act('withdrawReturnedWork',{},work.workNumber,work.revision);}}>이 부서 배정 해제</button>}</div></fieldset></form>;
      })}
    </>}
    </section></div><HistoryPanel actor={actor} requestId={detail.requestNumber} query={api} revision={detail.revision} onViewAttachment={id=>{setSelectedAttachmentSearch({});setSelectedAttachment(id);}} /></>}
    {selectedAttachment&&<AttachmentDocumentDialog api={api} attachmentId={selectedAttachment} searchTerm={selectedAttachmentSearch.term} targetBlockIndex={selectedAttachmentSearch.blockIndex} targetMetadataIndex={selectedAttachmentSearch.metadataIndex} onClose={()=>setSelectedAttachment(null)}/>}
  </>;
}
