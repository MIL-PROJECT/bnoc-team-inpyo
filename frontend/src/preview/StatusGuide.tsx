import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { workStatusLabel } from '../types';
import { statusGuide } from './statusDescriptions.mjs';
type Guide = ReturnType<typeof statusGuide>;
function StepFlow({guide,compact=false}:{guide:Guide;compact?:boolean}) {
  if(!guide.flow.length)return null;
  return <ol className={`survey-process${compact?' survey-process--compact':''}`} aria-label={`${guide.scope} 기본 단계`} style={{gridTemplateColumns:`repeat(${guide.flow.length},minmax(0,1fr))`}}>
    {guide.flow.map((step:{status:string},index:number)=><li key={step.status} aria-current={index===guide.currentIndex?'step':undefined}>
      <span className="survey-step-number" aria-hidden="true">{index+1}</span><strong>{guide.scope==='개별 작업'?workStatusLabel(step.status):step.status}</strong>
      <span className="survey-step-current">{index===guide.currentIndex?'현재':''}</span>
    </li>)}
  </ol>;
}
export function StatusGuide({status,work=false,afterAction=false,department,departments=[]}:{status:string;work?:boolean;afterAction?:boolean;department?:string;departments?:string[]}) {
  const id=useId(),[open,setOpen]=useState(false),[position,setPosition]=useState<{left:number;top:number}>();
  const root=useRef<HTMLSpanElement>(null),panel=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const contactDepartments=[...new Set((work?[department]:departments).filter((value):value is string=>Boolean(value)))];
  const cancelClose=()=>{clearTimeout(timer.current);};
  const show=()=>{cancelClose();setOpen(true);};
  const closeLater=()=>{cancelClose();if(!root.current?.contains(document.activeElement))timer.current=setTimeout(()=>setOpen(false),140);};
  useLayoutEffect(()=>()=>clearTimeout(timer.current),[]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{
      const trigger=root.current?.getBoundingClientRect(),tip=panel.current?.getBoundingClientRect();if(!trigger||!tip)return;
      const left=Math.max(16,Math.min(trigger.left,window.innerWidth-tip.width-16));
      const below=trigger.bottom+8,top=below+tip.height<=window.innerHeight-16?below:Math.max(16,trigger.top-tip.height-8);
      setPosition({left,top});
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){cancelClose();setOpen(false);}};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);document.addEventListener('keydown',escape);
    return()=>{cancelClose();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('keydown',escape);};
  },[open]);
  return <span ref={root} className="survey-status" onMouseEnter={show} onMouseLeave={closeLater}>
    <Button className={`badge survey-status-trigger status-${status.replace(' ','-')}`} aria-describedby={open?id:undefined} onFocus={show} onBlur={()=>{cancelClose();setOpen(false);}} onClick={show}>{work?workStatusLabel(status):status}</Button>
    {open&&createPortal(<div ref={panel} id={id} role="tooltip" className="survey-status-popover" style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}} onMouseEnter={cancelClose} onMouseLeave={closeLater}>
      <strong>{afterAction?'수행 부서':'담당 부서'}</strong>{contactDepartments.length?<ul className="survey-status-contacts">{contactDepartments.map(team=><li key={team}><span>{team}</span><span>대표번호 미등록</span></li>)}</ul>:<p className="survey-status-meaning">현재 담당 부서 없음</p>}
    </div>,document.body)}
  </span>;
}
export function StatusProcess({status,work=false,afterAction=false}:{status:string;work?:boolean;afterAction?:boolean}) {
  const guide=statusGuide(status,work,afterAction);
  return <section className="card section-gap survey-progress-card" aria-label={work?'우리 반 작업 흐름':'전체 처리 흐름'} data-tone={guide.tone}>
    <h2>{guide.kind==='normal'?(work?'우리 반 작업':'처리 현황'):guide.title}</h2>
    {guide.kind==='normal'?<StepFlow guide={guide}/>:<p className="survey-status-meaning">{guide.summary}</p>}
  </section>;
}
