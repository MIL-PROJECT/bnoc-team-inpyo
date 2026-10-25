import { useEffect, useId, useRef, useState } from 'react';
import type { ApiClient } from '../api/apiClient.mjs';
import { ApiError } from '../api/apiClient.mjs';
import type { AttachmentDocument } from '../types';
import { HwpPageRenderer } from '../ui/HwpPageRenderer';
import { DocxPageRenderer } from '../ui/DocxPageRenderer';

const labels:Record<string,string>={pending:'분석 대기',processing:'분석 중',ready:'분석 완료',partial:'일부 추출',failed:'분석 실패',unreadable:'읽을 수 없음',no_text:'본문 텍스트 없음',excluded:'본문 분석 제외',unsupported:'본문 분석 대상 아님'};
function statusMessage(status:string,processedRange?:string|null) {
  if(status==='excluded') return '서버 본문 분석·검색은 제외됩니다. 원본 미리보기와 다운로드는 이용할 수 있습니다.';
  if(status==='unsupported') return '서버 본문 분석·검색 대상이 아닙니다. 지원하는 형식은 원본으로 미리 볼 수 있습니다.';
  if(status==='pending'||status==='processing') return '문서를 분석 중입니다. 신청 처리는 계속됩니다.';
  if(status==='partial') return processedRange?`처리 범위: ${processedRange}`:'추출 한도에 도달한 내용만 표시합니다.';
  if(status==='failed') return '본문 분석을 마치지 못했습니다. 원본은 내려받을 수 있습니다.';
  if(status==='unreadable') return '암호화·손상 등으로 본문을 읽지 못했습니다. 원본은 내려받을 수 있습니다.';
  if(status==='no_text') return '추출된 본문이 없습니다. 원본 파일을 확인하세요.';
  return '';
}

function highlightText(value:string,term?:string) {
  const text=value.normalize('NFC'),query=term?.normalize('NFC');
  if(!query) return text;
  const index=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if(index<0) return text;
  return <>{text.slice(0,index)}<mark className="document-search-hit" data-document-search-hit>{text.slice(index,index+query.length)}</mark>{text.slice(index+query.length)}</>;
}

export function AttachmentDocumentDialog({api,attachmentId,searchTerm,targetBlockIndex,targetMetadataIndex,onClose}:{api:ApiClient;attachmentId:string;searchTerm?:string;targetBlockIndex?:number;targetMetadataIndex?:number;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),id=useId(),opener=useRef<HTMLElement|null>(window.document.activeElement instanceof HTMLElement?window.document.activeElement:null);
  const [document,setDocument]=useState<AttachmentDocument|null>(null),[error,setError]=useState(''),[original,setOriginal]=useState(false),[offset,setOffset]=useState(0),[loading,setLoading]=useState(false),[hwpBytes,setHwpBytes]=useState<Uint8Array|null>(null),[sourceLoading,setSourceLoading]=useState(false),[sourceError,setSourceError]=useState(''),[renderWarning,setRenderWarning]=useState(false);
  const load=async(nextOffset=offset)=>{setLoading(true);try{const result=await api.getAttachmentDocument(attachmentId,nextOffset,50) as AttachmentDocument;setDocument(result);setError('');setOffset(nextOffset);}catch(e){setError(e instanceof ApiError?e.message:'문서 정보를 불러오지 못했습니다.');}finally{setLoading(false);}};
  const targetOffset=targetBlockIndex!==undefined&&targetBlockIndex>=0?Math.floor(targetBlockIndex/50)*50:0;
  useEffect(()=>{dialog.current?.showModal();void load(targetOffset);return()=>{dialog.current?.close();if(opener.current?.isConnected)opener.current.focus();};},[attachmentId,targetOffset]);
  const isHwp=/\.hwp$/i.test(document?.fileName??'');
  const isDocx=/\.docx$/i.test(document?.fileName??'');
  const canShowOriginal=/\.(pdf|hwp|docx|png|jpe?g)$/i.test(document?.fileName??'');
  const canShowExtracted=!!document&&!['excluded','unsupported'].includes(document.status);
  useEffect(()=>{if(!document)return;setOriginal(canShowOriginal&&(!searchTerm||!canShowExtracted));setHwpBytes(null);setSourceError('');setRenderWarning(false);},[attachmentId,document?.fileName,searchTerm,canShowOriginal,canShowExtracted]);
  useEffect(()=>{
    if(!original||(!isHwp&&!isDocx)){setHwpBytes(null);return;}
    const controller=new AbortController();let active=true;setHwpBytes(null);setSourceLoading(true);setSourceError('');
    void api.getAttachmentRenderSource(attachmentId,controller.signal).then(bytes=>{if(active)setHwpBytes(bytes);}).catch(reason=>{if(active&&reason?.name!=='AbortError')setSourceError(reason instanceof ApiError?reason.message:'문서 원본을 열지 못했습니다.');}).finally(()=>{if(active)setSourceLoading(false);});
    return()=>{active=false;controller.abort();};
  },[api,attachmentId,original,isHwp,isDocx]);
  useEffect(()=>{if(!document||!['pending','processing'].includes(document.status))return;const timer=window.setInterval(()=>void load(offset),3000);return()=>window.clearInterval(timer);},[document?.status,offset]);
  useEffect(()=>{if(!document||!searchTerm)return;const frame=window.requestAnimationFrame(()=>{const target=targetMetadataIndex!==undefined&&targetMetadataIndex>=0?dialog.current?.querySelector(`[data-document-metadata-index="${targetMetadataIndex}"]`):targetBlockIndex!==undefined&&targetBlockIndex>=0?dialog.current?.querySelector(`[data-document-block-index="${targetBlockIndex}"]`):dialog.current?.querySelector('[data-document-search-hit]');target?.scrollIntoView({block:'center'});});return()=>window.cancelAnimationFrame(frame);},[document,searchTerm,targetBlockIndex,targetMetadataIndex]);
  const retry=async()=>{try{await api.reprocessAttachment(attachmentId);void load(0);}catch(e){setError(e instanceof ApiError?e.message:'문서 분석을 다시 요청하지 못했습니다.');}};
  return <dialog ref={dialog} className="document-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();onClose();}}>
    <header className="document-dialog__head"><div><h2 id={id}>{document?.fileName??'첨부 문서'}</h2><p className="muted" role="status">{document?labels[document.status]??document.status:'문서 정보 불러오는 중'}{document&&statusMessage(document.status,document.processedRange)?` · ${statusMessage(document.status,document.processedRange)}`:''}</p></div><div className="document-dialog__actions"><a className="ui-button" href={api.attachmentUrl(attachmentId)} download>원본 다운로드</a><button type="button" onClick={onClose}>닫기</button></div></header>
    {error&&<p className="field-error" role="alert">{error}</p>}
    {document&&<>
      {document.canRetry&&<p><button type="button" onClick={()=>void retry()} disabled={loading}>다시 분석</button></p>}
      {canShowOriginal&&canShowExtracted&&<div className="actions"><button type="button" aria-pressed={!original} onClick={()=>setOriginal(false)}>추출 본문</button><button type="button" aria-pressed={original} onClick={()=>{setRenderWarning(false);setOriginal(true);}}>원본 보기</button></div>}
      {renderWarning&&<p className="muted" role="status">원본 페이지를 만들지 못해 추출 본문을 표시합니다.</p>}
      <div className={`document-dialog__content${original||!canShowExtracted?' document-dialog__content--original':''}`}>
        <section className="document-dialog__body" aria-label={original?'원본 문서':'추출 본문'}>
          {original&&canShowOriginal?(/\.pdf$/i.test(document.fileName)?<iframe title="원본 PDF" src={api.attachmentInlineUrl(attachmentId)} referrerPolicy="no-referrer"/>:isHwp||isDocx?hwpBytes?(isDocx?<DocxPageRenderer bytes={hwpBytes} fileName={document.fileName}/>:<HwpPageRenderer bytes={hwpBytes} fileName={document.fileName} onError={()=>{if(canShowExtracted){setRenderWarning(true);setOriginal(false);}}}/>):sourceError?<p className="field-error" role="alert">{sourceError} 원본 다운로드를 이용하세요.</p>:<p className="muted" role="status">{sourceLoading?'문서 원본을 불러오는 중…':'문서 원본을 준비하고 있습니다.'}</p>:<img alt={document.fileName} src={api.attachmentInlineUrl(attachmentId)} onError={event=>{event.currentTarget.hidden=true;setSourceError('이미지를 미리 볼 수 없습니다. 원본 다운로드를 이용하세요.');}}/>):document.blocks.length?document.blocks.map((block,index)=>block.type==='table'?<table key={block.id} data-document-block-index={document.offset+index} data-document-search-target={targetBlockIndex===document.offset+index||undefined}><tbody>{block.rows?.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,column)=><td key={column}>{highlightText(cell,searchTerm)}</td>)}</tr>)}</tbody></table>:<p key={block.id} data-document-block-index={document.offset+index} data-document-search-target={targetBlockIndex===document.offset+index||undefined}>{highlightText(block.text??'',searchTerm)}</p>):<p className="muted">{canShowExtracted?'추출된 본문이 없습니다. 원본 보기나 다운로드를 이용하세요.':'이 파일 형식은 미리보기를 지원하지 않습니다. 원본 다운로드를 이용하세요.'}</p>}
          {sourceError&&!isHwp&&!isDocx&&<p className="field-error" role="alert">{sourceError}</p>}
        </section>
        {!original&&canShowExtracted&&<aside className="document-dialog__metadata" aria-label="문서에서 찾은 정보"><h3>문서 정보</h3>{document.metadata.length?document.metadata.map((field,index)=><div key={`${field.blockId}-${index}`} data-document-metadata-index={index} data-document-metadata-target={targetMetadataIndex===index||undefined}><strong>{highlightText(field.label,searchTerm)}</strong><p>{highlightText(field.rawValue,searchTerm)}</p><details><summary>원문 근거{field.page?` · ${field.page}쪽`:field.blockId?` · ${field.blockId}`:''}</summary><p>{highlightText(field.evidence,searchTerm)}</p></details></div>):<p className="muted">표시할 항목이 없습니다.</p>}</aside>}
      </div>
      {document.totalBlocks>50&&<footer className="document-dialog__footer"><button type="button" disabled={offset===0||loading} onClick={()=>void load(Math.max(0,offset-50))}>이전</button><span>{offset+1}–{Math.min(offset+50,document.totalBlocks)} / {document.totalBlocks}</span><button type="button" disabled={offset+50>=document.totalBlocks||loading} onClick={()=>void load(offset+50)}>다음</button></footer>}
    </>}
  </dialog>;
}
