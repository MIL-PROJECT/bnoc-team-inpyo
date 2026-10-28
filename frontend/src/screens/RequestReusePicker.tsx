import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {ApiClient} from '../api/apiClient.mjs';
import type {RequestSummary} from '../types';
import {useResource} from '../app/useResource';
import {Button} from '../ui/Button';
import {ActionGroup} from '../ui/ActionGroup';
import {ResourceStatus} from './ResourceStatus';

export function RequestReusePicker({api,onChoose,onClose}:{api:ApiClient;onChoose:(number:string)=>Promise<void>;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),opener=useRef(document.activeElement instanceof HTMLElement?document.activeElement:null);
  const [query,setQuery]=useState(''),[applied,setApplied]=useState(''),[page,setPage]=useState(0),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const result=useResource<{items:RequestSummary[];total:number}>(signal=>api.getRequestList({reusableOnly:true,q:applied,page,size:10},signal),[api,applied,page]);
  useEffect(()=>{dialog.current?.showModal();return()=>{dialog.current?.close();if(opener.current?.isConnected)opener.current.focus();};},[]);
  const choose=async(number:string)=>{setBusy(number);setError('');try{await onChoose(number);onClose();}catch(reason){setError(reason instanceof Error?reason.message:'이전 신청을 불러오지 못했습니다.');}finally{setBusy('');}};
  const search=(event:FormEvent)=>{event.preventDefault();setApplied(query.trim());setPage(0);};
  return <dialog ref={dialog} className="document-dialog request-reuse-dialog" aria-label="이전 신청 불러오기" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header className="document-dialog__head"><h2>이전 신청 불러오기</h2><Button disabled={!!busy} onClick={onClose}>닫기</Button></header>
    <p className="field-hint">이전에 직접 작성한 신청을 골라 새 신청으로 시작하세요. 일정과 첨부파일은 새로 입력합니다.</p>
    <form className="request-reuse-search" onSubmit={search}><ActionGroup><label className="field"><span>이전 신청 내용 검색</span><input value={query} maxLength={200} onChange={event=>setQuery(event.target.value)}/></label><Button type="submit" disabled={result.loading||!!busy}>검색</Button></ActionGroup></form>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload}/>
    {error&&<p role="alert" className="field-error">{error}</p>}
    {result.data?.items.filter(item=>item.canReuse).map(item=><div className="queue-row" key={item.requestNumber}><div className="request-reuse-copy"><strong>{item.detailPreview||item.matches?.find(match=>match.source==='request')?.text||item.status}</strong><div className="request-reuse-meta"><span>신청 {item.requestNumber}</span><span>{item.category}</span>{item.location&&<span>위치 {item.location}</span>}</div></div><Button disabled={!!busy||result.loading} onClick={()=>void choose(item.requestNumber)}>{busy===item.requestNumber?'불러오는 중…':'이 내용으로 새 신청'}</Button></div>)}
    {result.data&&!result.data.items.length&&!result.loading&&<p className="empty">{applied?'검색 결과가 없습니다.':'직접 작성한 이전 신청이 없습니다.'}</p>}
    {result.data&&result.data.total>10&&<ActionGroup className="request-reuse-pages"><Button disabled={page===0||result.loading||!!busy} onClick={()=>setPage(value=>value-1)}>이전 페이지</Button><span>{page+1}페이지</span><Button disabled={(page+1)*10>=result.data.total||result.loading||!!busy} onClick={()=>setPage(value=>value+1)}>다음 페이지</Button></ActionGroup>}
  </dialog>;
}
