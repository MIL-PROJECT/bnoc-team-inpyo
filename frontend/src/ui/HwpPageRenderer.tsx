import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

type RendererMessage = { type: 'ready'; pageCount: number } | { type: 'page'; page: number; svg: string } | { type: 'error' };

export function HwpPageRenderer({bytes,fileName,onError}:{bytes:Uint8Array;fileName:string;onError?:()=>void}) {
  const worker=useRef<Worker|null>(null),activeUrl=useRef<string|null>(null),requestedPage=useRef(0);
  const [status,setStatus]=useState<'loading'|'ready'|'rendering'|'failed'>('loading'),[pageCount,setPageCount]=useState(0),[page,setPage]=useState(0),[rendered,setRendered]=useState<{page:number;url:string}|null>(null);

  useEffect(()=>{
    setPage(0);setPageCount(0);setRendered(null);setStatus('loading');requestedPage.current=0;
    const current=new Worker(new URL('./hwpPageRenderer.worker.ts',import.meta.url),{type:'module'});
    worker.current=current;
    current.onmessage=({data}:{data:RendererMessage})=>{
      if(data.type==='ready') { setPageCount(data.pageCount);setStatus('ready');return; }
      if(data.type==='error') { setStatus('failed');onError?.();return; }
      if(data.page!==requestedPage.current)return;
      const url=URL.createObjectURL(new Blob([data.svg],{type:'image/svg+xml'}));
      if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);
      activeUrl.current=url;setRendered({page:data.page,url});setStatus('ready');
    };
    current.onerror=()=>{setStatus('failed');onError?.();};
    const transfer=bytes.slice().buffer;
    current.postMessage({type:'load',buffer:transfer},[transfer]);
    return()=>{
      current.terminate();if(worker.current===current)worker.current=null;
      if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);activeUrl.current=null;
    };
  },[bytes]);

  useEffect(()=>{
    requestedPage.current=page;
    if(!pageCount||status==='failed')return;
    setStatus('rendering');worker.current?.postMessage({type:'render',page});
  },[page,pageCount]);

  return <div className="hwp-page-view" aria-label="한글 원본 페이지 보기">
    {status==='loading'&&<p className="muted" role="status">한글 파일 여는 중…</p>}
    {status==='rendering'&&<p className="muted" role="status">페이지 그리는 중…</p>}
    {status==='failed'&&<p className="field-error" role="alert">이 한글 파일은 페이지로 표시하지 못했습니다. 추출 본문이나 원본 다운로드를 이용하세요.</p>}
    {rendered&&<img className="hwp-page-view__image" alt={`${fileName} ${rendered.page+1}쪽`} src={rendered.url}/>}
    {pageCount>1&&status!=='failed'&&<div className="hwp-page-view__controls"><Button disabled={page===0||status==='loading'} onClick={()=>setPage(value=>Math.max(0,value-1))}>이전 쪽</Button><span aria-live="polite">{page+1} / {pageCount}</span><Button disabled={page>=pageCount-1||status==='loading'} onClick={()=>setPage(value=>Math.min(pageCount-1,value+1))}>다음 쪽</Button></div>}
  </div>;
}
