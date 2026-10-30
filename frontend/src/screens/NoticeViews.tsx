import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Actor, Notice, AttachmentMeta, NoticeBodyDocument } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { displayDate, displayTime } from '../app/dateTime.mjs';
import type { RunCommand } from './RequestRegistrationForm';
import { ResourceStatus } from './ResourceStatus';
import { AttachmentPicker } from './AttachmentPicker';
import { focusFormError, saveFailureMessage } from '../app/formFeedback.mjs';
import { NoticeBodyContent, NoticeBodyEditor, plainNoticeDocument, plainNoticeText } from './NoticeBodyEditor';
import './noticeFeedback.css';
export function NoticeList({ actor, api, revision, onOpen, onNew }: { actor: Actor; api: ApiClient; revision: number; onOpen: (ref: string) => void; onNew: () => void }) {
  const [page, setPage] = useState(0);
  const result = useResource<{ items: Notice[]; total?: number }>(signal => api.getNotices({ page, size:20 }, signal), [api, revision, page]);
  return <><div className="page-head"><div><h1>공지게시판</h1>{result.data && <p className="muted notice-list-count">전체 {result.data.total ?? result.data.items.length}건</p>}</div>{actor.role === 'bnoc' && <button className="primary" onClick={onNew}>공지 작성</button>}</div><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {result.data && <>{result.data.items.length ? <section className="notice-list" aria-label="공지 목록"><div className="notice-list-head" aria-hidden="true"><span>제목·내용</span><span>수정일</span></div>{result.data.items.map(notice => <button className="queue-row notice-list-row" key={notice.noticeRef} aria-label={notice.title} onClick={() => onOpen(notice.noticeRef)}><span className="notice-list-copy"><strong>{notice.title}</strong><span className="notice-list-preview">{(notice.body ?? '').replace(/\s+/g,' ').trim()}</span><small>{notice.createdBy || 'BNOC'}{notice.attachments.length > 0 && ` · 첨부 ${notice.attachments.length}개`}</small></span><time dateTime={notice.updatedAt}>{displayDate(notice.updatedAt)}</time></button>)}</section> : <p className="empty">등록된 공지가 없습니다.</p>}{result.data.total !== undefined && <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{page + 1}페이지</span><button disabled={(page + 1) * 20 >= result.data.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>}</>}
  </>;
}
export function NoticeEditor({ api, run, notice, onSaved, onBack }: { api: ApiClient; run: RunCommand; notice?: Notice; onSaved: (ref?: string, message?: string) => void; onBack: () => void }) {
  const [title,setTitle] = useState(notice?.title ?? ''), [bodyDocument,setBodyDocument] = useState<NoticeBodyDocument>(()=>notice?.bodyDocument ?? plainNoticeDocument(notice?.body ?? '')), [attachments,setAttachments] = useState<AttachmentMeta[]>(notice?.attachments ?? []),[editorReset,setEditorReset]=useState(0);
  const [editRevision,setEditRevision] = useState(notice?.revision);
  const [message,setMessage] = useState(''), [errors,setErrors] = useState<Record<string,string>>({}), [conflict,setConflict] = useState(false), [uploading,setUploading] = useState(false);
  const [failed,setFailed] = useState(false);
  const formRef = useRef<HTMLFormElement>(null), feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (failed) focusFormError(formRef.current, feedbackRef.current); }, [errors, message, failed]);
  const { saving,submit } = useSubmission(run);
  const body=plainNoticeText(bodyDocument);
  const initialDocument=notice?.bodyDocument ?? plainNoticeDocument(notice?.body ?? '');
  const dirty = title !== (notice?.title ?? '') || JSON.stringify(bodyDocument) !== JSON.stringify(initialDocument) || JSON.stringify(attachments) !== JSON.stringify(notice?.attachments ?? []);
  useUnsavedChanges(dirty);
  const clearFeedback = () => { setMessage(''); setErrors({}); setFailed(false); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (uploading) return;
    setMessage(''); setFailed(false);
    const response = await submit(notice ? 'updateDirective' : 'createDirective', { ...(notice ? { noticeRef:notice.noticeRef } : {}), title,body,bodyDocument,attachmentRefs:attachments.map(file => file.id) }, undefined, editRevision);
    if (!response) return;
    if (response.ok) { setErrors({}); const success = `공지 「${title}」를 ${notice ? '수정해 저장' : '게시'}했습니다.`; setMessage(success); onSaved(response.publicRef ?? notice?.noticeRef,success); }
    else { setMessage(saveFailureMessage(response)); setErrors(response.fieldErrors ?? {}); setConflict(response.errorCode === 'CONFLICT'); setFailed(true); }
  };
  const reloadLatest = async () => {
    if (!notice || saving || uploading) return;
    try { const latest = await api.getNotice(notice.noticeRef) as Notice; setTitle(latest.title);setBodyDocument(latest.bodyDocument ?? plainNoticeDocument(latest.body));setEditorReset(value=>value+1);setAttachments(latest.attachments);setEditRevision(latest.revision);setErrors({});setConflict(false);setFailed(false);setMessage('최신 내용을 불러왔습니다. 다시 수정한 뒤 저장하세요.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '최신 내용을 조회하지 못했습니다. 입력은 유지됩니다.'); setFailed(true); }
  };
  return <><button className="back" onClick={onBack}>공지 목록</button><section className="card notice-editor"><h1>{notice ? '공지 수정' : '공지 작성'}</h1><form ref={formRef} onSubmit={save}><fieldset disabled={saving}>
    <label className="field"><span>제목<small className="field-hint" aria-hidden="true">필수</small></span><input maxLength={200} value={title} aria-label="제목" aria-required="true" aria-invalid={!!errors.title} aria-describedby={errors.title ? 'notice-title-error' : undefined} onChange={e => { setTitle(e.target.value);clearFeedback(); }} />{errors.title && <small id="notice-title-error" className="field-error">{errors.title}</small>}</label><div><NoticeBodyEditor value={bodyDocument} onChange={next=>{setBodyDocument(next);clearFeedback();}} resetKey={editorReset} error={errors.body ?? errors.bodyDocument} />{(errors.body || errors.bodyDocument) && <small id="notice-body-error" className="field-error">{errors.body ?? errors.bodyDocument}</small>}</div>
    <div aria-invalid={!!errors.attachmentRefs} tabIndex={errors.attachmentRefs ? -1 : undefined} aria-describedby={errors.attachmentRefs ? 'notice-attachment-error' : undefined}><AttachmentPicker previewEnabled={false} files={attachments} onChange={files => { setAttachments(files);clearFeedback(); }} upload={file => api.uploadAttachment(file,'notice')} onBusyChange={setUploading} />{errors.attachmentRefs && <p id="notice-attachment-error" className="field-error">{errors.attachmentRefs}</p>}</div>
    <button className="primary" type="submit" disabled={saving || uploading || conflict}>{saving ? '저장 중…' : notice ? '수정 저장' : '공지 게시'}</button>
    </fieldset>{message && <p ref={feedbackRef} tabIndex={-1} className={failed ? 'error' : 'notice'} role={failed ? 'alert' : 'status'}>{message}</p>}{dirty && !message && <p className="draft-status" role="status">저장하지 않은 공지 변경이 있습니다.</p>}{conflict && <div className="notice"><p>다른 BNOC가 공지를 수정했습니다. 입력은 유지됩니다. 최신 내용을 불러오면 현재 입력을 교체합니다.</p><button type="button" disabled={saving || uploading} onClick={() => reloadLatest()}>최신 내용 다시 불러오기</button></div>}</form></section></>;
}
export function NoticeDetail({ actor, api, run, refNumber, revision, onBack, initialMessage = '' }: { actor: Actor; api: ApiClient; run: RunCommand; refNumber: string; revision: number; onBack: () => void; initialMessage?: string }) {
  const result = useResource<Notice>(signal => api.getNotice(refNumber,signal), [api,refNumber,revision]);
  const [editing,setEditing] = useState(false), [message,setMessage] = useState(initialMessage);
  if (editing && result.data) return <NoticeEditor api={api} run={run} notice={result.data} onBack={onBack} onSaved={(_ref,savedMessage) => { setEditing(false);setMessage(savedMessage ?? '공지 변경을 저장했습니다.'); result.reload(); }} />;
  return <><button className="back" onClick={onBack}>공지 목록</button><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />{message && <p className="notice" role="status">{message}</p>}{result.data && <section className="card notice-detail"><div className="page-head"><h1>{result.data.title}</h1>{actor.role === 'bnoc' && <button onClick={() => { setMessage('');setEditing(true); }}>공지 수정</button>}</div><p className="muted">{result.data.createdBy} · {displayTime(result.data.createdAt)}{result.data.updatedAt !== result.data.createdAt ? ' · 수정 ' + displayTime(result.data.updatedAt) : ''}</p><NoticeBodyContent document={result.data.bodyDocument} body={result.data.body} />{result.data.attachments.length > 0 && <div className="section-gap"><h2>첨부문서</h2>{result.data.attachments.map(file => <p key={file.id}><a href={api.attachmentUrl(file.id)} download>{file.fileName}</a> · {Math.ceil(file.size / 1024)} KB</p>)}</div>}</section>}</>;
}
