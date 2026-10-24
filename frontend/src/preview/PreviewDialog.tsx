import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../ui/Button';
export function PreviewDialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null),id=useId(),opener=useRef<HTMLElement|null>(document.activeElement instanceof HTMLElement?document.activeElement:null);
  useEffect(()=>{dialog.current?.showModal();return()=>{dialog.current?.close();if(opener.current?.isConnected)opener.current.focus();};},[]);
  return <dialog ref={dialog} className="survey-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();onClose();}}><div className="page-head"><h2 id={id}>{title}</h2><Button onClick={onClose}>닫기</Button></div>{children}</dialog>;
}
