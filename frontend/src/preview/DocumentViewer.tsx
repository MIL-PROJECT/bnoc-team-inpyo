import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { ActionGroup } from '../ui/ActionGroup';
import { readDocument, retryDocument } from './surveyStore.mjs';
import { pdfBlob } from './documentFixtures.mjs';
import { HwpPageRenderer } from '../ui/HwpPageRenderer';
const stateLabels:Record<string,string>={pending:'분석 대기',processing:'분석 중',ready:'분석 완료',partial:'일부 추출',failed:'분석 실패',unreadable:'읽을 수 없음',no_text:'텍스트 없음',excluded:'본문 분석 제외'};
export function DocumentViewer({number,documentId,initialBlockId}:{number:string;documentId:string;initialBlockId?:string}) {
  const [revision,setRevision]=useState(0),[view,setView]=useState('read'),[highlight,setHighlight]=useState(initialBlockId??''),[url,setUrl]=useState(''),[hwpBytes,setHwpBytes]=useState<Uint8Array|null>(null),[hwpError,setHwpError]=useState('');
  const document:any=readDocument(number,documentId);
  useEffect(()=>{
    if(document.format==='hwp'){
      setView(initialBlockId||document.contentExcluded?'read':'original');setHwpBytes(null);setHwpError('');setUrl(document.originalUrl??'');let active=true;
      if(document.contentExcluded)return()=>{active=false;};
      void (async()=>{try{const bytes=document.originalFile?new Uint8Array(await document.originalFile.arrayBuffer()):new Uint8Array(await (await fetch(document.originalUrl)).arrayBuffer());if(active)setHwpBytes(bytes);}catch{if(active)setHwpError('한글 원본을 불러오지 못했습니다.');}})();
      return()=>{active=false;};
    }
    if(document.format==='pdf'||document.originalFile?.type.startsWith('image/')){const objectUrl=URL.createObjectURL(document.originalFile?new Blob([document.originalFile],{type:document.format==='pdf'?'application/pdf':document.originalFile.type}):pdfBlob());setUrl(objectUrl);return()=>URL.revokeObjectURL(objectUrl);}
    setUrl(document.originalUrl??'');
  },[number,documentId]);
  const jump=(id:string)=>{setView('read');setHighlight(id);requestAnimationFrame(()=>{const node=window.document.getElementById('document-'+id);node?.scrollIntoView({block:'center'});node?.focus();});};
  useEffect(()=>{if(initialBlockId)requestAnimationFrame(()=>{const node=window.document.getElementById('document-'+initialBlockId);node?.scrollIntoView({block:'center'});node?.focus();});},[initialBlockId]);
  return <section aria-label="문서 뷰어"><div className="row-head"><div><h3>{document.name}</h3><p role="status">{document.contentExcluded?'본문 분석 제외':stateLabels[document.status]}{document.status==='partial'?' · 추출된 일부 내용만 표시합니다.':''}</p></div><ActionGroup>{url&&<a className="ui-button" href={url} download={document.name}>원본 다운로드</a>}{!document.contentExcluded&&<Button onClick={()=>setRevision(revision+1)}>분석 상태 새로고침</Button>}</ActionGroup></div>
    {!document.contentExcluded&&<ActionGroup className="section-gap"><Button aria-pressed={view==='read'} onClick={()=>setView('read')}>추출 본문</Button>{(document.format==='hwp'||document.format==='pdf'||document.originalFile?.type.startsWith('image/'))&&<Button aria-pressed={view==='original'} onClick={()=>setView('original')}>원본 보기</Button>}</ActionGroup>}
    {['failed','unreadable','no_text'].includes(document.status)&&<div className="notice section-gap"><p>{document.status==='failed'?'문서 분석을 마치지 못했습니다.':document.status==='unreadable'?'암호화·손상 등으로 본문을 읽을 수 없습니다.':'추출할 텍스트를 찾지 못했습니다.'} 원본을 확인하세요.</p>{document.canRetry&&<Button onClick={()=>{retryDocument(number,documentId);setRevision(revision+1);}}>다시 분석 요청</Button>}</div>}
    {['processing','pending'].includes(document.status)&&<p className="notice section-gap">문서를 처리하고 있습니다. 요청 등록과 작업 진행은 계속할 수 있습니다.</p>}
    <div className="survey-document-grid section-gap"><div className="card survey-document-body" aria-label="문서 본문">{document.contentExcluded?<p className="notice">보안 양식 첨부는 앱에서 열거나 검색하지 않습니다. 원본을 내려받아 확인하세요.</p>:view==='original'&&document.format==='hwp'?hwpBytes?<HwpPageRenderer bytes={hwpBytes} fileName={document.name} onError={()=>setView('read')}/>:<p className={hwpError?'field-error':'muted'} role={hwpError?'alert':'status'}>{hwpError||'한글 원본을 불러오는 중…'}</p>:view==='original'&&url?(document.originalFile?.type.startsWith('image/')?<img alt={document.name} src={url}/>:<iframe title="원본 PDF" src={url}/>):document.blocks.length?document.blocks.map((block:any)=><div key={block.id} id={'document-'+block.id} tabIndex={-1} className={highlight===block.id?'survey-source-highlight':''}>{block.type==='table'?<table><tbody>{block.rows.map((row:string[],index:number)=><tr key={index}>{row.map((value:string,i:number)=><td key={i}>{value}</td>)}</tr>)}</tbody></table>:<p>{block.text}</p>}</div>):<p className="empty">현재 표시할 추출 본문이 없습니다.</p>}</div>
      <aside className="card" aria-label="추출한 문서 정보"><h3>문서에서 찾은 정보</h3><p className="muted">원문 후보입니다. 요청의 위치·일정을 자동 변경하지 않습니다.</p>{document.contentExcluded?<p>보안 양식은 문서 정보를 추출하지 않습니다.</p>:document.metadata.length?document.metadata.map((field:any)=><div className="section-gap" key={field.label}><strong>{field.label}</strong>{field.values.length>1&&<p className="notice">후보 {field.values.length}개 · 원문을 확인하세요.</p>}{field.values.map((value:any,index:number)=><div key={index}><p>{value.rawValue}</p><Button onClick={()=>jump(value.blockId)}>원문 근거 보기 · {document.blocks.findIndex((block:any)=>block.id===value.blockId)+1}번째 문단</Button></div>)}</div>):<p>아직 추출된 정보가 없습니다.</p>}</aside>
    </div>
  </section>;
}
