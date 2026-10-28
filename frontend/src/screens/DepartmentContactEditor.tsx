import {useId,useRef,useState} from 'react';
import type {ApiClient} from '../api/apiClient.mjs';
import {useResource,errorMessage} from '../app/useResource';
import {useSubmission} from '../app/useSubmission';
import {useUnsavedChanges} from '../app/useUnsavedChanges';
import type {RunCommand} from './RequestRegistrationForm';
import {ResourceStatus} from './ResourceStatus';
import {Button} from '../ui/Button';
import {PhoneInput} from '../ui/PhoneInput';
import {ActionGroup} from '../ui/ActionGroup';

type Contact={department:string;phone:string;revision:number};
export function DepartmentContactEditor({api,run}:{api:ApiClient;run:RunCommand}) {
  const result=useResource<{items:Contact[]}>(signal=>api.getDepartmentContacts(signal),[api]);
  const [draft,setDraft]=useState<Contact|null>(null),[original,setOriginal]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false);
  const {saving,submit}=useSubmission(run),feedback=useRef<HTMLParagraphElement>(null),errorId=useId();
  useUnsavedChanges(Boolean(draft&&draft.phone!==original)||uncertain);
  const edit=(row:Contact)=>{if(draft&&draft.phone!==original&&!window.confirm('저장하지 않은 번호를 바꿀까요?'))return;setDraft({...row});setOriginal(row.phone);setMessage('');setError('');setConflict(false);};
  const fail=(text:string)=>{setError(text);requestAnimationFrame(()=>feedback.current?.focus());};
  const save=async()=>{
    if(!draft||saving)return;
    setError('');setMessage('');
    const response=await submit('saveDepartmentContact',{department:draft.department,phone:draft.phone},undefined,draft.revision);
    if(!response)return;
    if(response.ok){setMessage(`${draft.department} 대표전화를 저장했습니다.`);setDraft(null);setUncertain(false);setConflict(false);result.reload();}
    else{setUncertain(['NETWORK','INVALID_RESPONSE','PROCESSING','SAVE_FAILED'].includes(response.errorCode));setConflict(response.errorCode==='CONFLICT');fail(response.fieldErrors?.phone??response.message??'대표전화를 저장하지 못했습니다.');}
  };
  const latest=async()=>{
    if(!draft)return;
    try{const data=await api.getDepartmentContacts();const row=data.items.find((item:Contact)=>item.department===draft.department);if(!row)throw new Error('부서 번호를 찾지 못했습니다.');setDraft({...row});setOriginal(row.phone);setConflict(false);setError('');result.reload();}
    catch(reason){fail(errorMessage(reason instanceof Error?reason:new Error('최신 번호를 불러오지 못했습니다.')));}
  };
  return <details className="optional-fields department-contact-editor"><summary>부서 대표전화 관리</summary>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload}/>
    {message&&<p role="status" className="notice">{message}</p>}
    {result.data&&<div className="table-wrap"><table><thead><tr><th>부서</th><th>대표 군내전화</th><th>관리</th></tr></thead><tbody>{result.data.items.map(row=><tr key={row.department} data-editing={draft?.department===row.department}><th scope="row">{row.department}</th><td>{row.phone}</td><td><Button disabled={saving||uncertain||result.loading||!!result.error} aria-label={`${row.department} 대표전화 수정`} onClick={()=>edit(row)}>수정</Button></td></tr>)}</tbody></table></div>}
    {draft&&<form key={draft.department} className="department-contact-form" onSubmit={event=>{event.preventDefault();void save();}}><label className="field"><span>{draft.department} 대표 군내전화</span><PhoneInput autoFocus required maxLength={50} aria-invalid={!!error} aria-describedby={error?errorId:undefined} aria-label="부서 대표 군내전화" disabled={saving||uncertain} value={draft.phone} onChange={event=>{setDraft({...draft,phone:event.target.value});setError('');}}/></label>
      {error&&<p id={errorId} ref={feedback} tabIndex={-1} role="alert" className="field-error">{error}</p>}
      {uncertain&&<p role="status" className="notice">저장 결과를 확인할 때까지 같은 번호로 다시 저장하세요.</p>}
      <ActionGroup><Button type="submit" variant="primary" disabled={saving||conflict||!/[0-9]/.test(draft.phone)||!uncertain&&draft.phone===original}>{saving?'저장 중…':uncertain?'저장 결과 다시 확인':'대표전화 저장'}</Button>{conflict&&<Button disabled={saving} onClick={()=>void latest()}>최신 번호 불러오기</Button>}<Button disabled={saving||uncertain} onClick={()=>{setDraft(null);setError('');setConflict(false);}}>취소</Button></ActionGroup>
    </form>}
  </details>;
}
