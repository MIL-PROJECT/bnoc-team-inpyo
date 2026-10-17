import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor } from '../types';
import { RequestFields, initialInput, type RequestInput, type RunCommand } from './RequestRegistrationForm';
import type { UploadAttachment } from './AttachmentPicker';
import { afterActionPayload } from '../api/requestPayload.mjs';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { focusFormError, saveFailureMessage } from '../app/formFeedback.mjs';
export function AfterActionReportForm({ actor, run, upload, onSaved, onDraftChange }: { actor: Actor; run: RunCommand; upload: UploadAttachment; onSaved: (id: string, message?: string) => void; onDraftChange?: (input: RequestInput) => void }) {
  const [input, setInput] = useState<RequestInput>(() => initialInput(actor));
  const [started, setStarted] = useState(''), [completed, setCompleted] = useState('');
  const [reason, setReason] = useState(''), [memo, setMemo] = useState('');
  const [done, setDone] = useState(false), [errors, setErrors] = useState<Record<string,string>>({});
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const { saving, submit: save } = useSubmission(run), [uploading, setUploading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (failed) focusFormError(formRef.current, feedbackRef.current); }, [errors, message, failed]);
  const dirty = JSON.stringify(input) !== JSON.stringify(initialInput(actor)) || !!started || !!completed || !!reason || !!memo || done;
  useUnsavedChanges(dirty);
  const clearFeedback = () => { setErrors({}); setMessage(''); setFailed(false); };
  const change = (value: RequestInput) => { setInput(value); onDraftChange?.(value); clearFeedback(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || uploading) return;
    if (!done) { setErrors({ completedConfirmed:'작업 완료를 확인하세요.' }); setMessage('작업을 완료한 뒤 보고할 수 있습니다. 입력 내용은 유지됩니다.'); setFailed(true); return; }
    setMessage(''); setFailed(false);
    const result = await save('createAfterActionReport', afterActionPayload(input, { started, completed, reason, memo, done }));
    if (!result) return;
    if (result.ok) { setErrors({}); if (result.requestNumber) { const success = `요청 ${result.requestNumber}의 완료 후보고를 등록했습니다.`; setMessage(success); onSaved(result.requestNumber, success); } return; }
    setErrors(result.fieldErrors ?? {}); setMessage(saveFailureMessage(result)); setFailed(true);
  };
  return <section className="card"><h1>선조치 후보고</h1><form ref={formRef} onSubmit={submit}>
    <fieldset disabled={saving}><RequestFields actor={actor} input={input} setInput={change} errors={errors} upload={upload} onUploading={setUploading} afterAction />
    <div className="form-grid"><label className="field"><span>실제 시작 시각<small className="field-hint" aria-hidden="true">필수</small></span><input type="datetime-local" value={started} aria-label="실제 시작 시각" aria-required="true" aria-invalid={!!errors.actualStartedAt} aria-describedby={errors.actualStartedAt ? 'actual-start-error' : undefined} onChange={e => { setStarted(e.target.value); clearFeedback(); }} />{errors.actualStartedAt && <small id="actual-start-error" className="field-error">{errors.actualStartedAt}</small>}</label>
    <label className="field"><span>실제 완료 시각<small className="field-hint" aria-hidden="true">필수</small></span><input type="datetime-local" value={completed} aria-label="실제 완료 시각" aria-required="true" aria-invalid={!!errors.actualCompletedAt} aria-describedby={errors.actualCompletedAt ? 'actual-complete-error' : undefined} onChange={e => { setCompleted(e.target.value); clearFeedback(); }} />{errors.actualCompletedAt && <small id="actual-complete-error" className="field-error">{errors.actualCompletedAt}</small>}</label></div>
    <label className="field"><span>선조치 사유<small className="field-hint" aria-hidden="true">필수</small></span><textarea value={reason} aria-label="선조치 사유" aria-required="true" aria-invalid={!!errors.reason} aria-describedby={errors.reason ? 'after-action-reason-error' : undefined} onChange={e => { setReason(e.target.value); clearFeedback(); }} />{errors.reason && <small id="after-action-reason-error" className="field-error">{errors.reason}</small>}</label>
    <label className="field"><span>완료 메모<small className="field-hint" aria-hidden="true">선택</small></span><input value={memo} aria-label="완료 메모" aria-invalid={!!errors.completionMemo} aria-describedby={errors.completionMemo ? 'after-action-memo-error' : undefined} onChange={e => { setMemo(e.target.value); clearFeedback(); }} />{errors.completionMemo && <small id="after-action-memo-error" className="field-error">{errors.completionMemo}</small>}</label>
    <label className="check"><input type="checkbox" checked={done} aria-label="작업 완료 확인" aria-required="true" aria-invalid={!!errors.completedConfirmed} aria-describedby={errors.completedConfirmed ? 'after-action-done-error' : undefined} onChange={e => { setDone(e.target.checked); clearFeedback(); }} />작업 완료 확인</label>{errors.completedConfirmed && <small id="after-action-done-error" className="field-error">{errors.completedConfirmed}</small>}</fieldset>
    {message && <p ref={feedbackRef} tabIndex={-1} role={failed ? 'alert' : 'status'} className={failed ? 'error' : 'notice'}>{message}</p>}
    {dirty && !message && <p className="draft-status" role="status">저장하지 않은 입력이 있습니다.</p>}
    <button className="primary" type="submit" disabled={saving || uploading}>{saving ? '저장 중…' : '후보고 등록'}</button>
  </form></section>;
}
