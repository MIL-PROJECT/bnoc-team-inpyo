import { useEffect, useRef, useState } from 'react';
import type { AttachmentMeta } from '../types';
import { errorMessage } from '../app/useResource';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { uploadAttachmentBatch, attachmentSubmissionBlocked } from '../api/attachmentQueue.mjs';
export type UploadAttachment = (file: File) => Promise<AttachmentMeta>;
type FailedUpload = { file: File; error: Error };
export function AttachmentPicker({ files, onChange, upload, onBusyChange, disabled = false, label = '첨부파일' }: {
  files: AttachmentMeta[]; onChange: (files: AttachmentMeta[]) => void; upload: UploadAttachment;
  onBusyChange?: (blocked: boolean) => void; disabled?: boolean; label?: string
}) {
  const [busy,setBusy] = useState(false), [failures,setFailures] = useState<FailedUpload[]>([]);
  const processing = useRef(false), failed = useRef<FailedUpload[]>([]);
  const latest = useRef({ files,onChange,upload,onBusyChange }); latest.current = { files,onChange,upload,onBusyChange };
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false; }; },[]);
  useUnsavedChanges(attachmentSubmissionBlocked(busy,failures));
  const run = async (selected: File[], retrying: File[] = []) => {
    if (!selected.length || processing.current || disabled) return;
    processing.current=true;setBusy(true);latest.current.onBusyChange?.(true);
    const remaining=failed.current.filter(item => !retrying.includes(item.file));
    const next=await uploadAttachmentBatch(selected,(file: File) => latest.current.upload(file),() => ({ files:latest.current.files,onChange:(uploaded: AttachmentMeta[]) => { if(mounted.current) latest.current.onChange(uploaded); } }));
    if(!mounted.current) return;
    failed.current=[...remaining,...next];setFailures(failed.current);processing.current=false;setBusy(false);latest.current.onBusyChange?.(attachmentSubmissionBlocked(false,failed.current));
  };
  const exclude = (file: File) => { failed.current=failed.current.filter(item => item.file !== file);setFailures(failed.current);latest.current.onBusyChange?.(attachmentSubmissionBlocked(busy,failed.current)); };
  return <div className="attachment-picker">
    <label className="field"><span>{label}</span><input type="file" aria-label={label} multiple disabled={busy || disabled} onChange={event => { const selected=[...(event.target.files ?? [])];event.target.value='';void run(selected); }} /></label>
    {busy && <p role="status">파일을 올리는 중…</p>}
    {failures.length > 0 && <div className="error" role="alert"><p>올리지 못한 파일이 있습니다. 다시 시도하거나 해당 파일을 제외한 뒤 저장하세요.</p>{failures.map((item,index) => <div className="attachment-row" key={index}><span>{item.file.name} · 업로드 실패<small>{errorMessage(item.error)}</small></span><div className="actions"><button type="button" disabled={busy || disabled} aria-label={item.file.name + ' 업로드 다시 시도'} onClick={() => void run([item.file],[item.file])}>다시 시도</button><button type="button" disabled={busy || disabled} aria-label={item.file.name + ' 실패 첨부 제외'} onClick={() => exclude(item.file)}>제외</button></div></div>)}</div>}
    {files.map(file => <div className="attachment-row" key={file.id}><span>{file.fileName} · {Math.ceil(file.size / 1024)} KB</span><button type="button" disabled={busy || disabled} aria-label={file.fileName + ' 첨부 제외'} onClick={() => onChange(files.filter(item => item.id !== file.id))}>제외</button></div>)}
  </div>;
}
