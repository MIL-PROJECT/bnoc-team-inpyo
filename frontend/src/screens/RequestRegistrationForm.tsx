import {PhoneInput} from '../ui/PhoneInput';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor, ViewCommandResult, GuidedDraft } from '../types';
import { AttachmentPicker, type UploadAttachment } from './AttachmentPicker';
import { requestPayload } from '../api/requestPayload.mjs';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { focusFormError, requestFieldErrors, saveFailureMessage, guidedRequestErrorStep } from '../app/formFeedback.mjs';
import { jumpIntake } from '../app/intakeModel.mjs';
import { requestDetailGuidance, requestLocationGuidance } from '../app/requestGuidance.mjs';
import { displayTime } from '../app/dateTime.mjs';
import {useRequestDraft,type RequestDraftApi} from '../app/useRequestDraft';
import {Button} from '../ui/Button';
import {ActionGroup} from '../ui/ActionGroup';
import {GuidedRequestFields,prepareGuidedInput} from './GuidedRequestFields';

export type CommandTarget = { requestNumber: string; workNumber?: string };
export type RunCommand = (type: string, payload: Record<string, unknown>, target?: CommandTarget, expectedRevision?: number, operationId?: string) => Promise<ViewCommandResult>;
export type RequesterChoice = { requesterRef: string; displayName: string; department: string };
type Props = { actor: Actor; run: RunCommand; upload: UploadAttachment; getRequesters: () => Promise<{ items: RequesterChoice[] }>; draftApi:RequestDraftApi; onSaved: (id: string, message?: string) => void; initialDraft?: RequestInput | null; sourceRequestNumber?: string; onBrowsePrevious?:()=>void; onDraftChange?: (input: RequestInput) => void };
export type RequestInput = {
  guidedDraft: GuidedDraft | null;
  requesterDisplayText: string; requesterRef: string; category: string; systemType: string; resourceType: string; workType: string; meetingType: string; videoPlatform: string; phoneType: string;
  detail: string; location: string; contact: string; personalContact: string; equipmentId: string; preference1Date: string; preference1Period: string; preference2Date: string; preference2Period: string; documentRef: string;
  differentTarget: boolean; targetDepartment: string; targetRank: string; targetName: string; targetPhone: string;
  attachments: { id: string; fileName: string; size: number; type: string }[]
};
export const initialInput = (actor: Actor): RequestInput => ({
  guidedDraft:null,
  requesterDisplayText: '', requesterRef: '', category: '장비/체계', systemType: '', resourceType: '', workType: '', meetingType: '', videoPlatform: '', phoneType: '',
  detail: '', location: '', contact: '', personalContact: '',
  equipmentId: '', preference1Date: '', preference1Period: '', preference2Date: '', preference2Period: '', documentRef: '', differentTarget: false,
  targetDepartment: '', targetRank: '', targetName: '', targetPhone: '', attachments: []
});
export const toPayload = (input: RequestInput, actor: Actor) => requestPayload(input, actor.role);
export function RequestFields({ actor, input, setInput, errors, upload, onUploading, requesters = [], afterAction = false }: {
  actor: Actor; input: RequestInput; setInput: (value: RequestInput) => void; errors: Record<string,string>; upload: UploadAttachment; onUploading?: (value: boolean) => void; requesters?: RequesterChoice[]; afterAction?: boolean
}) {
  errors = requestFieldErrors(input, errors);
  const update = (field: keyof RequestInput, value: unknown) => setInput({ ...input, [field]: value });
  const errorId = (key: string) => `${afterAction ? 'after-action' : 'request'}-${key}-error`;
  const field = (label: string, key: keyof RequestInput, type = 'text') => {
    const errorKey = key.startsWith('target') ? 'maintenanceTarget.' + key.slice('target'.length).toLowerCase() : afterAction && key === 'requesterDisplayText' ? 'actualRequesterText' : key;
    const error = errors[errorKey] ?? (key.startsWith('target') ? errors[key.slice('target'.length).toLowerCase()] ?? errors.maintenanceTarget : undefined);
    const optional = ['equipmentId','documentRef','personalContact'].includes(key);
    const hint=key==='location'?requestLocationGuidance:key==='equipmentId'?'예: 장비명이나 알고 있는 식별정보. 모르면 비워도 됩니다.':key==='documentRef'?'예: 관련 공문 제목이나 문서번호. 없으면 비워도 됩니다.':key==='personalContact'?'개인전화로도 연락받을 수 있으면 입력하세요.':undefined;
    const placeholder=key==='location'?requestLocationGuidance:undefined;
    const showHint=Boolean(hint)&&key!=='location';
    const describedBy=[error?errorId(key):undefined,showHint?`${errorId(key)}-hint`:undefined].filter(Boolean).join(' ') || undefined;
    const Input=['contact','personalContact','targetPhone'].includes(key)?PhoneInput:'input';
    return <label className="field"><span>{label}<small className="field-hint" aria-hidden="true">{optional ? '선택' : '필수'}</small></span><Input type={key==='personalContact'?'tel':type} autoComplete={key==='personalContact'?'tel':undefined} value={input[key] as string} placeholder={placeholder} aria-label={label} aria-required={!optional} aria-invalid={!!error} aria-describedby={describedBy} onChange={event => update(key, event.target.value)} />{showHint && <small id={`${errorId(key)}-hint`} className="field-hint">{hint}</small>}{error && <small id={errorId(key)} className="field-error">{error}</small>}</label>;
  };
  const choice = (label: string, key: keyof RequestInput, values: string[]) => (
    <label className="field"><span>{label}<small className="field-hint" aria-hidden="true">{key === 'phoneType' ? '선택' : '필수'}</small></span><select value={input[key] as string} aria-label={label} aria-required={key !== 'phoneType'} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? errorId(key) : undefined} onChange={event => update(key, event.target.value)}><option value="">선택</option>{values.map(value => <option key={value}>{value}</option>)}</select>{errors[key] && <small id={errorId(key)} className="field-error">{errors[key]}</small>}</label>
  );
  const meetingFormRequired = !afterAction && input.category === '회의 지원' && ['화상회의','일반회의'].includes(input.meetingType);
  const attachmentLabel = meetingFormRequired ? `${input.meetingType} 지원 의뢰서` : '첨부파일';
  return <div className="form-body request-fields">
    {actor.role === 'requester' ? <p className="summary-strip">요청자 {actor.displayName} · {actor.department}</p> : (actor.role === 'bnoc' && !afterAction) || afterAction ? <label className="field"><span>{afterAction ? '실제 요청자 계정' : '요청자 계정'}<small className="field-hint" aria-hidden="true">필수</small></span><select name="requesterRef" value={input.requesterRef} aria-label={afterAction ? '실제 요청자 계정' : '요청자 계정'} aria-required="true" aria-invalid={!!errors.requesterRef} aria-describedby={errors.requesterRef ? errorId('requesterRef') : undefined} onChange={event => update('requesterRef',event.target.value)}><option value="">요청자 선택</option>{requesters.map(item => <option key={item.requesterRef} value={item.requesterRef}>{[item.displayName,item.department].filter(Boolean).join(' · ')}</option>)}</select>{errors.requesterRef && <small id={errorId('requesterRef')} className="field-error">{errors.requesterRef}</small>}</label> : field('실제 요청자', 'requesterDisplayText')}
    <div className="request-kind">{choice('요청 유형', 'category', ['장비/체계','회의 지원'])}
    {input.category === '장비/체계' ? <div className="form-grid request-kind-fields">
      {choice('체계 종류', 'systemType', ['인트라넷','인터넷','AFCCS','KJCCS','기타'])}
      <label className="field"><span>자원 유형<small className="field-hint" aria-hidden="true">필수</small></span><select value={input.resourceType} aria-label="자원 유형" aria-required="true" aria-invalid={!!errors.resourceType} aria-describedby={errors.resourceType ? errorId('resourceType') : undefined} onChange={event => update('resourceType', event.target.value)}><option value="">선택</option>{[['PC','컴퓨터'],['프린터','프린터'],['회선','회선'],['전화','전화기'],['기타','기타']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>{errors.resourceType && <small id={errorId('resourceType')} className="field-error">{errors.resourceType}</small>}</label>
      {choice('작업 유형', 'workType', ['신설','고장','지원','대여','점검','이전','기타'])}
      {input.resourceType === '전화' && choice('전화기 종류 (선택)', 'phoneType', ['IP','아날로그','인터컴','비상벨'])}
    </div> : <div className="form-grid request-kind-fields request-kind-fields--meeting">{choice('회의 유형', 'meetingType', ['화상회의','일반회의','기타'])}{!afterAction && input.meetingType === '화상회의' && choice('화상회의 방식', 'videoPlatform', ['KJCCS','AFCCS','웹미팅'])}</div>}</div>
    <label className="field"><span>요청 내용·증상<small className="field-hint" aria-hidden="true">필수</small></span><textarea rows={4} value={input.detail} placeholder={requestDetailGuidance(input)} aria-label="요청 내용·증상" aria-required="true" aria-invalid={!!errors.detail} aria-describedby={errors.detail ? errorId('detail') : undefined} onChange={event => update('detail', event.target.value)} />{errors.detail && <small id={errorId('detail')} className="field-error">{errors.detail}</small>}</label>
    <div className="form-grid request-contact-fields">{field('작업 위치', 'location')}{field('요청자 군내전화번호', 'contact')}{!afterAction && field('요청자 개인전화번호', 'personalContact')}</div>
    <label className="check"><input type="checkbox" checked={input.differentTarget} onChange={event => update('differentTarget', event.target.checked)} />정비대상자가 요청자와 다름</label>
    {input.differentTarget && <div className="form-grid">
      {field('정비대상자 소속', 'targetDepartment')}{field('정비대상자 계급', 'targetRank')}
      {field('정비대상자 이름', 'targetName')}{field('정비대상자 군내전화번호', 'targetPhone')}
    </div>}
    <details className="optional-fields"><summary>선택 정보</summary><div className="form-grid">
      {!afterAction && <fieldset className="preference-fields form-grid" aria-invalid={!!errors.schedulePreferences} tabIndex={errors.schedulePreferences ? -1 : undefined} aria-describedby={errors.schedulePreferences ? errorId('schedulePreferences') : undefined}>
        <legend>희망 일정 <small className="field-hint" aria-hidden="true">선택</small></legend>
        {[1, 2].map(rank => <div className="preference-choice" key={rank}>
          <strong>{rank}지망</strong>
          <label className="field"><span>날짜</span><input type="date" value={input[`preference${rank}Date` as keyof RequestInput] as string} aria-label={`${rank}지망 날짜`} aria-invalid={rank===1 && !!errors.schedulePreferences} aria-describedby={rank===1 && errors.schedulePreferences ? errorId('schedulePreferences') : undefined} onChange={event => update(`preference${rank}Date` as keyof RequestInput,event.target.value)} /></label>
          <label className="field"><span>오전·오후</span><select value={input[`preference${rank}Period` as keyof RequestInput] as string} aria-label={`${rank}지망 오전·오후`} onChange={event => update(`preference${rank}Period` as keyof RequestInput,event.target.value)}><option value="">선택</option><option value="AM">오전</option><option value="PM">오후</option></select></label>
        </div>)}
        {errors.schedulePreferences && <small id={errorId('schedulePreferences')} className="field-error">{errors.schedulePreferences}</small>}
      </fieldset>}
      {input.category === '장비/체계' && field('장비·체계 식별정보', 'equipmentId')}
      {field('문서 참조정보', 'documentRef')}
    </div></details>
    <div aria-invalid={!!errors.attachments} tabIndex={errors.attachments ? -1 : undefined} aria-describedby={errors.attachments ? errorId('attachments') : undefined}>
      <AttachmentPicker files={input.attachments} onChange={files => update('attachments', files)} upload={upload} onBusyChange={onUploading} label={attachmentLabel} required={meetingFormRequired} />
      {errors.attachments && <small id={errorId('attachments')} className="field-error">{errors.attachments}</small>}
    </div>
  </div>;
}
export function RequestRegistrationForm({ actor, run, upload, getRequesters, draftApi, onSaved, initialDraft, sourceRequestNumber, onBrowsePrevious, onDraftChange }: Props) {
  const [input, setInput] = useState(() => prepareGuidedInput(initialDraft ?? initialInput(actor)));
  const [errors, setErrors] = useState<Record<string,string>>({});
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [requesters,setRequesters]=useState<RequesterChoice[]>([]),[requesterLoading,setRequesterLoading]=useState(false),[requesterLoadError,setRequesterLoadError]=useState('');
  const [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false);
  const [formalUncertain,setFormalUncertain]=useState(false);
  const operationId = useRef(crypto.randomUUID());
  const [showReuseNotice,setShowReuseNotice]=useState(Boolean(sourceRequestNumber));
  const persisted=useRequestDraft({actor,input,empty:prepareGuidedInput(initialInput(actor)),api:draftApi,
    onRestore:value=>{const next=prepareGuidedInput(value);setInput(next);onDraftChange?.(next);operationId.current=crypto.randomUUID();setShowReuseNotice(false);setErrors({});setMessage('');setFailed(false);},
    onSaved:()=>{operationId.current=crypto.randomUUID();setShowReuseNotice(false);setErrors({});setMessage('');setFailed(false);}});
  const formRef = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (failed) focusFormError(formRef.current, feedbackRef.current); }, [errors, message, failed]);
  const refreshRequesters=useCallback(async()=>{
    setRequesterLoading(true);setRequesterLoadError('');
    try {
      const result=await getRequesters();
      if(!Array.isArray(result.items)) throw new Error('invalid requester list');
      setRequesters(result.items);
      setInput(current=>current.requesterRef && result.items.some(item=>item.requesterRef===current.requesterRef)?current:{...current,requesterRef:''});
    } catch { setRequesters([]);setRequesterLoadError('요청자 목록을 불러오지 못했습니다.'); }
    finally { setRequesterLoading(false); }
  },[getRequesters]);
  useEffect(()=>{if(actor.role==='bnoc')void refreshRequesters();},[actor.id,actor.role,refreshRequesters]);
  const inputDirty=JSON.stringify(input)!==(persisted.baseline??JSON.stringify(prepareGuidedInput(initialInput(actor))));
  useUnsavedChanges(inputDirty||Boolean(persisted.uncertain)||formalUncertain);
  const change = (value: RequestInput) => { setInput(value); onDraftChange?.(value); operationId.current = crypto.randomUUID(); persisted.clearFeedback();setErrors({}); setMessage(''); setFailed(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || uploading || persisted.busy || persisted.uncertain) return;
    if(actor.role==='bnoc' && requesterLoading) return;
    if(actor.role==='bnoc' && requesterLoadError) { setMessage(requesterLoadError);setFailed(true);return; }
    if(actor.role==='bnoc' && !input.requesterRef) { setErrors({requesterRef:'요청자 계정을 선택하세요.'});setMessage('실제 요청자를 선택하세요.');setFailed(true);return; }
    if(input.guidedDraft?.step!=='review')return;
    const payload=toPayload(input,actor);
    if (payload.category === '회의 지원' && ['화상회의','일반회의'].includes(('meetingType' in payload.subcategories?payload.subcategories.meetingType:'')??'') && payload.attachments.length === 0) {
      setErrors({ attachments:'회의 지원 의뢰서를 1개 이상 첨부하세요.' }); setMessage('필수 회의 지원 의뢰서를 첨부하세요.'); setFailed(true); return;
    }
    setSaving(true); setMessage(''); setFailed(false);
    const result = await run('createRequest', {...payload,...(persisted.reference?{draftRef:persisted.reference}:{})}, undefined, undefined, operationId.current);
    setSaving(false);
    if (result.ok) { setFormalUncertain(false);setErrors({}); if (result.requestNumber) { const success = `요청 ${result.requestNumber}을 등록했습니다.`; setMessage(success); onSaved(result.requestNumber, success); } return; }
    const uncertain=['NETWORK','INVALID_RESPONSE','PROCESSING','SAVE_FAILED'].includes(result.errorCode??'');
    if(uncertain)setFormalUncertain(true);
    else if(!['UNAUTHENTICATED','FORBIDDEN'].includes(result.errorCode??''))setFormalUncertain(false);
    const fieldErrors=result.fieldErrors??{};
    const errorStep=result.errorCode==='VALIDATION'?guidedRequestErrorStep(fieldErrors):null;
    if(errorStep)setInput(current=>({...current,guidedDraft:jumpIntake(current.guidedDraft!,errorStep)}));
    setErrors(fieldErrors); setMessage(saveFailureMessage(result)); setFailed(true);
  };
  const draftDisabled=saving||uploading||persisted.busy||formalUncertain;
  return <section className="card request-editor guided-request-editor"><div className="page-head"><h1>{actor.role === 'bnoc' ? '대리 등록' : '작업 신청'}</h1>
    {actor.role==='requester'&&onBrowsePrevious&&<Button disabled={draftDisabled||!!persisted.uncertain} onClick={onBrowsePrevious}>이전 신청 불러오기</Button>}</div>
    {showReuseNotice&&sourceRequestNumber&&<p className="notice" role="status">요청 {sourceRequestNumber}을 불러온 새 신청 초안입니다. 희망 일정과 첨부파일은 이번 요청에 맞게 새로 입력하세요.</p>}
    <section className="request-draft-panel intake-draft-toolbar" aria-label="신청서 임시저장"><p className="field-hint">임시저장은 정식 접수가 아닙니다.<span className="intake-draft-hint">업로드 완료 후 임시저장한 첨부파일만 함께 보관됩니다.</span></p>
      {!persisted.ready&&!persisted.error&&<p role="status">임시저장 상태를 확인하는 중…</p>}
      {persisted.state.draft&&<p className="notice request-draft-summary" role="status">임시저장한 신청서가 있습니다. 마지막 저장 {displayTime(persisted.state.draft.savedAt)}</p>}
      <ActionGroup><Button disabled={draftDisabled||!persisted.ready||Boolean(persisted.uncertain&&persisted.uncertain!=='save')||(!inputDirty&&Boolean(persisted.reference)&&!persisted.uncertain)} onClick={()=>void persisted.save()}>{persisted.busy?'처리 중…':'임시저장'}</Button>
        <Button variant="plain" disabled={draftDisabled||!persisted.ready||(!persisted.state.draft&&!persisted.uncertain)} onClick={()=>void persisted.restore()}>임시저장 불러오기</Button>
        <Button variant="danger" disabled={draftDisabled||!persisted.state.draft||Boolean(persisted.uncertain&&persisted.uncertain!=='delete')} onClick={()=>void persisted.remove()}>임시저장 삭제</Button>
        {!persisted.ready&&persisted.error&&<Button disabled={draftDisabled} onClick={()=>void persisted.refresh()}>임시저장 상태 다시 확인</Button>}</ActionGroup>
      {persisted.error&&<p className="error" role="alert">{persisted.error}</p>}{persisted.notice&&<p className="notice request-draft-feedback" role="status">{persisted.notice}</p>}
      {persisted.uncertain&&<p className="notice" role="status">임시저장 결과를 확인할 때까지 입력과 신청 등록을 잠시 멈춥니다. 같은 작업으로 다시 시도하거나 저장본을 불러오세요.</p>}
      {formalUncertain&&<p className="notice" role="status">신청 등록 결과를 먼저 확인해야 합니다. 입력과 임시저장을 유지한 채 같은 신청 등록으로 다시 확인하세요.</p>}
    </section>
    {actor.role==='bnoc'&&requesterLoadError&&<p className="error" role="alert">{requesterLoadError} <Button onClick={()=>void refreshRequesters()}>다시 불러오기</Button></p>}
    <form ref={formRef} onSubmit={submit}><GuidedRequestFields disabled={saving||formalUncertain||persisted.busy||Boolean(persisted.uncertain)||(actor.role==='bnoc'&&requesterLoading)} submitAction={input.guidedDraft?.step==='review'?<ActionGroup className="intake-submit-row"><Button variant="primary" type="submit" disabled={saving||uploading||persisted.busy||Boolean(persisted.uncertain)||(actor.role==='bnoc'&&(requesterLoading||!!requesterLoadError||requesters.length===0))}>{saving?'저장 중…':'신청 등록'}</Button></ActionGroup>:undefined} actor={actor} input={input} setInput={change} errors={errors} upload={upload} onUploading={setUploading} uploading={uploading} requesters={requesters}/>
      {actor.role==='bnoc'&&requesterLoading&&<p role="status">요청자 목록을 불러오는 중…</p>}
      {message&&<p ref={feedbackRef} tabIndex={-1} role={failed?'alert':'status'} className={failed?'error':'notice'}>{message}</p>}
      {inputDirty&&!message&&<p className="draft-status intake-save-state" role="status">{persisted.baseline?'임시저장 후 변경한 입력이 있습니다. 다시 임시저장하세요.':'저장하지 않은 입력이 있습니다.'}</p>}

    </form></section>;
}
