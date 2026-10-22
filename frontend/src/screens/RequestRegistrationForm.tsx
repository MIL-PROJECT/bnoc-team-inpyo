import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor, ViewCommandResult } from '../types';
import { AttachmentPicker, type UploadAttachment } from './AttachmentPicker';
import { requestPayload } from '../api/requestPayload.mjs';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { focusFormError, requestFieldErrors, saveFailureMessage } from '../app/formFeedback.mjs';
import { requestDetailGuidance, requestLocationGuidance } from '../app/requestGuidance.mjs';

export type CommandTarget = { requestNumber: string; workNumber?: string };
export type RunCommand = (type: string, payload: Record<string, unknown>, target?: CommandTarget, expectedRevision?: number, operationId?: string) => Promise<ViewCommandResult>;
type Props = { actor: Actor; run: RunCommand; upload: UploadAttachment; onSaved: (id: string, message?: string) => void; initialDraft?: RequestInput | null; onDraftChange?: (input: RequestInput) => void };
export type RequestInput = {
  requesterDisplayText: string; category: string; systemType: string; resourceType: string; workType: string; meetingType: string; phoneType: string;
  detail: string; location: string; contact: string; equipmentId: string; preference1Date: string; preference1Period: string; preference2Date: string; preference2Period: string; documentRef: string;
  differentTarget: boolean; targetDepartment: string; targetRank: string; targetName: string; targetPhone: string;
  attachments: { id: string; fileName: string; size: number; type: string }[]
};
export const initialInput = (actor: Actor): RequestInput => ({
  requesterDisplayText: '', category: '장비/체계', systemType: '', resourceType: '', workType: '', meetingType: '', phoneType: '',
  detail: '', location: '', contact: '',
  equipmentId: '', preference1Date: '', preference1Period: '', preference2Date: '', preference2Period: '', documentRef: '', differentTarget: false,
  targetDepartment: '', targetRank: '', targetName: '', targetPhone: '', attachments: []
});
export const toPayload = (input: RequestInput, actor: Actor) => requestPayload(input, actor.role);
export function RequestFields({ actor, input, setInput, errors, upload, onUploading, afterAction = false }: {
  actor: Actor; input: RequestInput; setInput: (value: RequestInput) => void; errors: Record<string,string>; upload: UploadAttachment; onUploading?: (value: boolean) => void; afterAction?: boolean
}) {
  errors = requestFieldErrors(input, errors);
  const update = (field: keyof RequestInput, value: unknown) => setInput({ ...input, [field]: value });
  const errorId = (key: string) => `${afterAction ? 'after-action' : 'request'}-${key}-error`;
  const field = (label: string, key: keyof RequestInput, type = 'text') => {
    const errorKey = key.startsWith('target') ? 'maintenanceTarget.' + key.slice('target'.length).toLowerCase() : afterAction && key === 'requesterDisplayText' ? 'actualRequesterText' : key;
    const error = errors[errorKey] ?? (key.startsWith('target') ? errors[key.slice('target'.length).toLowerCase()] ?? errors.maintenanceTarget : undefined);
    const optional = ['equipmentId','documentRef'].includes(key);
    const hint=key==='location'?requestLocationGuidance:key==='equipmentId'?'예: 장비명이나 알고 있는 식별정보. 모르면 비워도 됩니다.':key==='documentRef'?'예: 관련 공문 제목이나 문서번호. 없으면 비워도 됩니다.':undefined;
    const placeholder=key==='location'?requestLocationGuidance:undefined;
    const showHint=Boolean(hint)&&key!=='location';
    const describedBy=[error?errorId(key):undefined,showHint?`${errorId(key)}-hint`:undefined].filter(Boolean).join(' ') || undefined;
    return <label className="field"><span>{label}<small className="field-hint" aria-hidden="true">{optional ? '선택' : '필수'}</small></span><input type={type} value={input[key] as string} placeholder={placeholder} aria-label={label} aria-required={!optional} aria-invalid={!!error} aria-describedby={describedBy} onChange={event => update(key, event.target.value)} />{showHint && <small id={`${errorId(key)}-hint`} className="field-hint">{hint}</small>}{error && <small id={errorId(key)} className="field-error">{error}</small>}</label>;
  };
  const choice = (label: string, key: keyof RequestInput, values: string[]) => (
    <label className="field"><span>{label}<small className="field-hint" aria-hidden="true">{key === 'phoneType' ? '선택' : '필수'}</small></span><select value={input[key] as string} aria-label={label} aria-required={key !== 'phoneType'} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? errorId(key) : undefined} onChange={event => update(key, event.target.value)}><option value="">선택</option>{values.map(value => <option key={value}>{value}</option>)}</select>{errors[key] && <small id={errorId(key)} className="field-error">{errors[key]}</small>}</label>
  );
  return <div className="form-body">
    {actor.role === 'requester' ? <p className="summary-strip">요청자 {actor.displayName} · {actor.department}</p> : field('실제 요청자', 'requesterDisplayText')}
    {choice('요청 유형', 'category', ['장비/체계','회의 지원'])}
    {input.category === '장비/체계' ? <div className="form-grid">
      {choice('체계 종류', 'systemType', ['인트라넷','인터넷','AFCCS','KJCCS','기타'])}
      <label className="field"><span>자원 유형<small className="field-hint" aria-hidden="true">필수</small></span><select value={input.resourceType} aria-label="자원 유형" aria-required="true" aria-invalid={!!errors.resourceType} aria-describedby={errors.resourceType ? errorId('resourceType') : undefined} onChange={event => update('resourceType', event.target.value)}><option value="">선택</option>{[['PC','컴퓨터'],['프린터','프린터'],['회선','회선'],['전화','전화기'],['기타','기타']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>{errors.resourceType && <small id={errorId('resourceType')} className="field-error">{errors.resourceType}</small>}</label>
      {choice('작업 유형', 'workType', ['신설','고장','지원','대여','점검','이전','기타'])}
      {input.resourceType === '전화' && choice('전화기 종류 (선택)', 'phoneType', ['IP','아날로그','인터컴','비상벨'])}
    </div> : choice('회의 유형', 'meetingType', ['화상회의','일반회의','기타'])}
    <label className="field"><span>요청 내용·증상<small className="field-hint" aria-hidden="true">필수</small></span><textarea rows={4} value={input.detail} placeholder={requestDetailGuidance(input)} aria-label="요청 내용·증상" aria-required="true" aria-invalid={!!errors.detail} aria-describedby={errors.detail ? errorId('detail') : undefined} onChange={event => update('detail', event.target.value)} />{errors.detail && <small id={errorId('detail')} className="field-error">{errors.detail}</small>}</label>
    <div className="form-grid">{field('작업 위치', 'location')}{field('요청자 군내전화번호', 'contact')}</div>
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
      <AttachmentPicker files={input.attachments} onChange={files => update('attachments', files)} upload={upload} onBusyChange={onUploading} />
      {errors.attachments && <small id={errorId('attachments')} className="field-error">{errors.attachments}</small>}
    </div>
  </div>;
}
export function RequestRegistrationForm({ actor, run, upload, onSaved, initialDraft, onDraftChange }: Props) {
  const [input, setInput] = useState(() => initialDraft ?? initialInput(actor));
  const [errors, setErrors] = useState<Record<string,string>>({});
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false);
  const operationId = useRef(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (failed) focusFormError(formRef.current, feedbackRef.current); }, [errors, message, failed]);
  const dirty = JSON.stringify(input) !== JSON.stringify(initialInput(actor));
  useUnsavedChanges(dirty);
  const change = (value: RequestInput) => { setInput(value); onDraftChange?.(value); operationId.current = crypto.randomUUID(); setErrors({}); setMessage(''); setFailed(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || uploading) return;
    setSaving(true); setMessage(''); setFailed(false);
    const result = await run('createRequest', toPayload(input, actor), undefined, undefined, operationId.current);
    setSaving(false);
    if (result.ok) { setErrors({}); if (result.requestNumber) { const success = `요청 ${result.requestNumber}을 등록했습니다.`; setMessage(success); onSaved(result.requestNumber, success); } return; }
    setErrors(result.fieldErrors ?? {}); setMessage(saveFailureMessage(result)); setFailed(true);
  };
  return <section className="card"><h1>{actor.role === 'bnoc' ? '대리 등록' : '작업 신청'}</h1><form ref={formRef} onSubmit={submit}><fieldset disabled={saving}><RequestFields actor={actor} input={input} setInput={change} errors={errors} upload={upload} onUploading={setUploading} /></fieldset>{message && <p ref={feedbackRef} tabIndex={-1} role={failed ? 'alert' : 'status'} className={failed ? 'error' : 'notice'}>{message}</p>}{dirty && !message && <p className="draft-status" role="status">저장하지 않은 입력이 있습니다.</p>}<div className="actions"><button className="primary" type="submit" disabled={saving || uploading}>{saving ? '저장 중…' : '신청 등록'}</button></div></form></section>;
}
