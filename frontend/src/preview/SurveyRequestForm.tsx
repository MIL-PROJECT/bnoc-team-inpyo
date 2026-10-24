import { useRef, useState } from 'react';
import type { Actor } from '../types';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/DateInput';
import { ActionGroup } from '../ui/ActionGroup';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { requestDetailGuidance, requestLocationGuidance } from '../app/requestGuidance.mjs';
import { draftFromRequest, initialDraft, requestOptions, validateDraft } from './requestForm.mjs';
import { savePreviewRequest } from './surveyStore.mjs';

type Draft = ReturnType<typeof initialDraft>;

export function SurveyRequestForm({ actor, onSaved, afterAction = false, existing }: { actor: Actor; onSaved: (number: string) => void; afterAction?: boolean; existing?: any }) {
  const initial = useRef<Draft>(draftFromRequest(existing));
  const [input, setInput] = useState(initial.current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useUnsavedChanges(JSON.stringify(input) !== JSON.stringify(initial.current));
  const set = (key: string, value: any) => setInput(previous => ({ ...previous, [key]: value }));
  const field = (label: string, key: string, value: string, update: (value: string) => void, required = true, type = 'text', hint?: string, choices?: string[], disabled = false) => {
    const id = `survey-field-${key}`;
    const error = errors[key];
    return <label className="field" key={key}>
      <span>{label}<small className="field-hint">{required ? '필수' : '선택'}</small></span>
      {choices
        ? <select name={key} value={value} disabled={disabled} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => update(event.target.value)}><option value="">선택</option>{choices.map(choice => <option key={choice}>{choice}</option>)}</select>
        : <input name={key} type={type} value={value} maxLength={type === 'number' ? undefined : 1000} aria-required={required} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} placeholder={hint} disabled={disabled} onChange={event => update(event.target.value)} />}
      {error && <small id={`${id}-error`} className="field-error">{error}</small>}
    </label>;
  };
  const submit = () => {
    const failures = validateDraft(input, actor.role, afterAction);
    setErrors(failures as unknown as Record<string, string>);
    if (Object.keys(failures).length) {
      setMessage('입력하지 않은 필수 항목을 확인하세요.');
      requestAnimationFrame(() => {
        const element = form.current?.elements.namedItem(Object.keys(failures)[0]);
        if (element instanceof HTMLElement) {
          const details = element.closest('details');
          if (details) details.open = true;
          element.focus();
        }
      });
      return;
    }
    try {
      const number = savePreviewRequest(input, afterAction, existing?.number);
      onSaved(number);
    } catch {
      setMessage('현재 역할로 저장할 수 없습니다. 입력은 유지됩니다.');
    }
  };

  return <>
    <div className="page-head"><div><small>{existing ? '요청 내용 수정' : afterAction ? '끝낸 작업 기록' : '새 작업 신청'}</small><h1>{existing ? '신청 수정' : afterAction ? '선조치 후보고' : '작업 신청'}</h1></div></div>
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); submit(); }} className="survey-form">
      {message && <p role="alert" className="error">{message}</p>}
      <section className="card">
        <h2>요청 정보</h2>
        <div className="form-grid">
          {actor.role === 'bnoc' && field('실제 요청자', 'requesterDisplayText', input.requesterDisplayText, value => set('requesterDisplayText', value))}
          {field('요청 유형', 'category', input.category, value => set('category', value), true, 'text', undefined, requestOptions.categories, Boolean(existing))}
          {input.category === '장비/체계' && <>
            {field('체계 종류', 'systemType', input.systemType, value => set('systemType', value), true, 'text', undefined, requestOptions.systemTypes, Boolean(existing))}
            {field('자원 유형', 'resourceType', input.resourceType, value => set('resourceType', value), true, 'text', undefined, requestOptions.resourceTypes, Boolean(existing))}
            {field('작업 유형', 'workType', input.workType, value => set('workType', value), true, 'text', undefined, requestOptions.workTypes, Boolean(existing))}
            {input.resourceType === '전화' && field('전화기 종류', 'phoneType', input.phoneType, value => set('phoneType', value), false, 'text', undefined, requestOptions.phoneTypes, Boolean(existing))}
          </>}
          {input.category === '회의 지원' && field('회의 유형', 'meetingType', input.meetingType, value => set('meetingType', value), true, 'text', undefined, requestOptions.meetingTypes, Boolean(existing))}
        </div>
        <label className="field section-gap"><span>요청 내용·증상<small className="field-hint">필수</small></span><textarea name="detail" rows={4} value={input.detail} placeholder={requestDetailGuidance(input)} aria-required="true" aria-invalid={Boolean(errors.detail)} aria-describedby={errors.detail ? 'survey-field-detail-error' : undefined} onChange={event => set('detail', event.target.value)} />{errors.detail && <small id="survey-field-detail-error" className="field-error">{errors.detail}</small>}</label>
      </section>
      <section className="card section-gap">
        <h2>위치와 연락처</h2>
        <div className="form-grid">{field('작업 위치', 'location', input.location, value => set('location', value), true, 'text', requestLocationGuidance)}{field('요청자 군내전화번호', 'contact', input.contact, value => set('contact', value))}</div>
        <label className="check"><input type="checkbox" checked={input.differentTarget} onChange={event => set('differentTarget', event.target.checked)} />정비대상자가 요청자와 다름</label>
        {input.differentTarget && <div className="form-grid">{[['targetDepartment', '정비대상자 소속'], ['targetRank', '정비대상자 계급'], ['targetName', '정비대상자 이름'], ['targetPhone', '정비대상자 군내전화번호']].map(([key, label]) => field(label, key, (input as any)[key], value => set(key, value)))}</div>}
      </section>
      <details className="card section-gap">
        <summary>선택 정보</summary>
        <div className="form-grid">
          {!afterAction && [1, 2].map(rank => <fieldset key={rank}><legend>희망 일정 {rank}지망</legend><div className="form-grid">
            <label className="field"><span>날짜</span><DateInput name={`preference${rank}Date`} aria-label={`${rank}지망 날짜`} aria-invalid={Boolean(errors[`preference${rank}Date`])} aria-describedby={errors[`preference${rank}Date`] ? `preference${rank}-date-error` : undefined} value={(input as any)[`preference${rank}Date`]} onChange={event => set(`preference${rank}Date`, event.target.value)} />{errors[`preference${rank}Date`] && <small id={`preference${rank}-date-error`} className="field-error">{errors[`preference${rank}Date`]}</small>}</label>
            <label className="field"><span>오전·오후</span><select name={`preference${rank}Period`} aria-label={`${rank}지망 오전·오후`} aria-invalid={Boolean(errors[`preference${rank}Period`])} aria-describedby={errors[`preference${rank}Period`] ? `preference${rank}-period-error` : undefined} value={(input as any)[`preference${rank}Period`]} onChange={event => set(`preference${rank}Period`, event.target.value)}><option value="">선택</option><option value="AM">오전</option><option value="PM">오후</option></select>{errors[`preference${rank}Period`] && <small id={`preference${rank}-period-error`} className="field-error">{errors[`preference${rank}Period`]}</small>}</label>
          </div></fieldset>)}
          {input.category === '장비/체계' && field('장비·체계 식별정보', 'equipmentId', input.equipmentId, value => set('equipmentId', value), false)}
          {field('문서 참조정보', 'documentRef', input.documentRef, value => set('documentRef', value), false)}
        </div>
        <label className="field"><span>첨부파일 (선택)</span><input name="files" type="file" multiple accept=".pdf,.doc,.docx,.hwp,.hwpx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg" onChange={event => set('files', Array.from(event.target.files ?? []))} />{errors.files && <small className="field-error">{errors.files}</small>}</label>
      </details>
      {afterAction && <section className="card section-gap"><h2>완료 기록</h2><div className="form-grid">
        {field('실제 요청자', 'actualRequesterText', input.actualRequesterText, value => set('actualRequesterText', value))}
        {field('실제 시작 시각', 'actualStartedAt', input.actualStartedAt, value => set('actualStartedAt', value), true, 'datetime-local')}
        {field('실제 완료 시각', 'completedAt', input.completedAt, value => set('completedAt', value), true, 'datetime-local')}
        {field('선조치 사유', 'reason', input.reason, value => set('reason', value))}
        {field('완료 메모', 'completionMemo', input.completionMemo, value => set('completionMemo', value), false)}
      </div><label className="check"><input name="completionConfirmed" type="checkbox" checked={input.completionConfirmed} onChange={event => set('completionConfirmed', event.target.checked)} />이미 완료한 작업입니다.</label>{errors.completionConfirmed && <p className="field-error">{errors.completionConfirmed}</p>}</section>}
      <ActionGroup className="section-gap"><Button variant="primary" type="submit">{existing ? '변경 저장' : afterAction ? '완료 후보고 등록' : '신청 등록'}</Button></ActionGroup>
    </form>
  </>;
}
