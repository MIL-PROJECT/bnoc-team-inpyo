import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { prepareHwpEngine } from './hwpEngine';

type RendererMessage = { type: 'ready'; pageCount: number } | { type: 'page'; page: number; svg: string } | { type: 'error' };
type Size = { width: number; height: number };

export function HwpPageRenderer({bytes,fileName,onError}:{bytes:Uint8Array;fileName:string;onError?:()=>void}) {
  const worker=useRef<Worker|null>(null),activeUrl=useRef<string|null>(null),requestedPage=useRef(0),timeout=useRef<number|undefined>(undefined),onErrorRef=useRef(onError);
  const viewport=useRef<HTMLDivElement>(null);
  onErrorRef.current=onError;
  const [status,setStatus]=useState<'loading'|'ready'|'rendering'|'failed'>('loading'),[pageCount,setPageCount]=useState(0),[page,setPage]=useState(0),[rendered,setRendered]=useState<{page:number;url:string}|null>(null),[attempt,setAttempt]=useState(0);
  const [area,setArea]=useState<Size>({width:0,height:0}),[paper,setPaper]=useState<Size>({width:0,height:0});
  const [zoom,setZoom]=useState<'page'|'width'|number>('page');
  const clearTimeout=()=>window.clearTimeout(timeout.current);
  const fail=()=>{
    clearTimeout();worker.current?.terminate();worker.current=null;
    if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);activeUrl.current=null;
    setRendered(null);setStatus('failed');onErrorRef.current?.();
  };
  const wait=()=>{clearTimeout();timeout.current=window.setTimeout(fail,30000);};

  useEffect(()=>{
    const element=viewport.current;if(!element)return;
    const resize=()=>setArea({width:element.clientWidth,height:element.clientHeight});
    const observer=new ResizeObserver(resize);observer.observe(element);resize();
    return()=>observer.disconnect();
  },[]);

  useEffect(()=>{
    setPage(0);setPageCount(0);setRendered(null);setStatus('loading');setPaper({width:0,height:0});setZoom('page');requestedPage.current=0;
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
    current.onerror=()=>{if(worker.current===current)fail();};
    let pendingBytes:ArrayBuffer|null=bytes.slice().buffer;
    void prepareHwpEngine().then(module=>{
      if(worker.current!==current||!pendingBytes)return;
      const transfer=pendingBytes;pendingBytes=null;
      current.postMessage({type:'load',buffer:transfer,module},[transfer]);
    }).catch(()=>{if(worker.current===current)fail();});
    return()=>{
      pendingBytes=null;
      clearTimeout();current.terminate();if(worker.current===current)worker.current=null;
      if(activeUrl.current)URL.revokeObjectURL(activeUrl.current);activeUrl.current=null;
    };
  },[bytes,attempt]);

  useEffect(()=>{
    requestedPage.current=page;
    if(!pageCount||!worker.current)return;
    setStatus('rendering');wait();worker.current.postMessage({type:'render',page});
  },[page,pageCount]);

  const widthScale=paper.width?Math.max(1,area.width-2)/paper.width:1;
  const pageScale=paper.height?Math.min(widthScale,Math.max(1,area.height-2)/paper.height):1;
  const scale=typeof zoom==='number'?zoom:zoom==='width'?widthScale:pageScale;
  const width=paper.width*scale,height=paper.height*scale;
  const ready=!!rendered&&paper.width>0;
  useEffect(()=>{if(zoom==='page'&&viewport.current){viewport.current.scrollTop=0;viewport.current.scrollLeft=0;}},[zoom,page,area.width,area.height]);

  return <div className="hwp-page-view" aria-label="한글 원본 페이지 보기">
    <div className="hwp-page-view__controls" role="toolbar" aria-label="한글 페이지 도구">
      <div className="hwp-page-view__group"><Button disabled={page===0||status==='loading'||status==='failed'} onClick={()=>setPage(value=>Math.max(0,value-1))}>이전 쪽</Button><span aria-live="polite">{pageCount?`${page+1} / ${pageCount}`:'쪽 확인 중'}</span><Button disabled={!pageCount||page>=pageCount-1||status==='loading'||status==='failed'} onClick={()=>setPage(value=>Math.min(pageCount-1,value+1))}>다음 쪽</Button></div>
      <div className="hwp-page-view__group"><Button aria-label="축소" disabled={!ready||scale<=.1} onClick={()=>setZoom(Math.max(.1,scale/1.25))}>−</Button><output aria-label="현재 확대 배율">{ready?`${Math.round(scale*100)}%`:'—'}</output><Button aria-label="확대" disabled={!ready||scale>=3} onClick={()=>setZoom(Math.min(3,scale*1.25))}>+</Button><Button variant={zoom==='page'?'primary':undefined} aria-pressed={zoom==='page'} disabled={!ready} onClick={()=>setZoom('page')}>페이지 맞춤</Button><Button variant={zoom==='width'?'primary':undefined} aria-pressed={zoom==='width'} disabled={!ready} onClick={()=>setZoom('width')}>너비 맞춤</Button></div>
    </div>
    <div ref={viewport} className="hwp-page-view__viewport" tabIndex={0} role="region" aria-label="한글 페이지" aria-busy={status==='loading'||status==='rendering'}>
      {(status==='loading'||status==='rendering')&&<p className="hwp-page-view__status muted" role="status">{status==='loading'?'한글 파일 여는 중…':'페이지 그리는 중…'}</p>}
      {status==='failed'&&<div className="field-error" role="alert"><p>이 한글 파일은 페이지로 표시하지 못했습니다. 다시 열거나 원본을 내려받아 확인하세요.</p><Button onClick={()=>setAttempt(value=>value+1)}>한글 파일 다시 열기</Button></div>}
      {rendered&&<div className="hwp-page-view__surface" style={{width:Math.max(area.width,width),height:Math.max(area.height,height)}}><img className="hwp-page-view__image" style={{width,height,maxWidth:'none',margin:0}} alt={`${fileName} ${rendered.page+1}쪽`} src={rendered.url} onLoad={event=>setPaper({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={fail}/></div>}
    </div>
  </div>;
}
