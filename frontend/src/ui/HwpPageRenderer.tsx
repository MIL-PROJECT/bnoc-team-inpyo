import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';

type RendererMessage = { type: 'ready'; pageCount: number } | { type: 'page'; page: number; svg: string } | { type: 'error' };

export function HwpPageRenderer({bytes,fileName,onError}:{bytes:Uint8Array;fileName:string;onError?:()=>void}) {
  const worker=useRef<Worker|null>(null),activeUrl=useRef<string|null>(null),requestedPage=useRef(0),timeout=useRef<number|undefined>(undefined),onErrorRef=useRef(onError);
  onErrorRef.current=onError;
  const [status,setStatus]=useState<'loading'|'ready'|'rendering'|'failed'>('loading'),[pageCount,setPageCount]=useState(0),[page,setPage]=useState(0),[rendered,setRendered]=useState<{page:number;url:string}|null>(null),[attempt,setAttempt]=useState(0);
  const clearTimeout=()=>window.clearTimeout(timeout.current);
  const fail=()=>{
    clearTimeout();worker.current?.terminate();worker.current=null;
    if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);activeUrl.current=null;
    setRendered(null);setStatus('failed');onErrorRef.current?.();
  };
  const wait=()=>{clearTimeout();timeout.current=window.setTimeout(fail,30000);};

  useEffect(()=>{
    setPage(0);setPageCount(0);setRendered(null);setStatus('loading');requestedPage.current=0;
    let current:Worker;
    try { current=new Worker(new URL('./hwpPageRenderer.worker.ts',import.meta.url),{type:'module'}); }
    catch { fail();return; }
    worker.current=current;wait();
    current.onmessage=({data}:{data:RendererMessage})=>{
      if(worker.current!==current)return;
      if(data.type==='ready') { clearTimeout();setPageCount(data.pageCount);return; }
      if(data.type==='error') { fail();return; }
      if(data.page!==requestedPage.current)return;
      clearTimeout();
      const url=URL.createObjectURL(new Blob([data.svg],{type:'image/svg+xml'}));
      if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);
      activeUrl.current=url;setRendered({page:data.page,url});setStatus('ready');
    };
    current.onerror=fail;
    const transfer=bytes.slice().buffer;
    current.postMessage({type:'load',buffer:transfer},[transfer]);
    return()=>{
      clearTimeout();current.terminate();if(worker.current===current)worker.current=null;
      if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);activeUrl.current=null;
    };
  },[bytes,attempt]);

  useEffect(()=>{
    requestedPage.current=page;
    if(!pageCount||!worker.current)return;
    setStatus('rendering');wait();worker.current.postMessage({type:'render',page});
  },[page,pageCount]);

  return <div className="hwp-page-view" aria-label="한글 원본 페이지 보기">
    {status==='loading'&&<p className="muted" role="status">한글 파일 여는 중…</p>}
    {status==='rendering'&&<p className="muted" role="status">페이지 그리는 중…</p>}
    {status==='failed'&&<div className="field-error" role="alert"><p>이 한글 파일은 페이지로 표시하지 못했습니다. 다시 열거나 원본을 내려받아 확인하세요.</p><Button onClick={()=>setAttempt(value=>value+1)}>한글 파일 다시 열기</Button></div>}
    {rendered&&<img className="hwp-page-view__image" alt={`${fileName} ${rendered.page+1}쪽`} src={rendered.url} onError={fail}/>}
    {pageCount>1&&status!=='failed'&&<div className="hwp-page-view__controls"><Button disabled={page===0||status==='loading'} onClick={()=>setPage(value=>Math.max(0,value-1))}>이전 쪽</Button><span aria-live="polite">{page+1} / {pageCount}</span><Button disabled={page>=pageCount-1||status==='loading'} onClick={()=>setPage(value=>Math.min(pageCount-1,value+1))}>다음 쪽</Button></div>}
  </div>;
}
