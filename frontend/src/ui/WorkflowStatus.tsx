import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../api/apiClient.mjs';
import { statusGuide } from '../preview/statusDescriptions.mjs';
import { workStatusLabel } from '../types';
import { Button } from './Button';
import './workflow-status.css';

type Guide = ReturnType<typeof statusGuide>;
export const DepartmentContactApiContext = createContext<ApiClient | null>(null);

function StepFlow({ guide, compact = false }: { guide: Guide; compact?: boolean }) {
  if (!guide.flow.length) return null;
  return <ol className={`workflow-status-steps${compact ? ' workflow-status-steps--compact' : ''}`} aria-label={`${guide.scope} 기본 단계`} style={{ gridTemplateColumns: `repeat(${guide.flow.length}, minmax(0, 1fr))` }}>
    {guide.flow.map((step: { status: string }, index: number) => <li className="workflow-status-step" key={step.status} aria-current={index === guide.currentIndex ? 'step' : undefined}>
      <span className="workflow-status-step__number" aria-hidden="true">{index + 1}</span>
      <strong>{guide.scope === '개별 작업' ? workStatusLabel(step.status) : step.status}</strong>
      {index === guide.currentIndex && <span className="workflow-status-step__current">현재</span>}
    </li>)}
  </ol>;
}

export function StatusBadge({ status, work = false, afterAction = false, department, departments = [] }: { status: string; work?: boolean; afterAction?: boolean; department?: string; departments?: string[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const api = useContext(DepartmentContactApiContext);
  const [contacts, setContacts] = useState<Record<string,string> | null>(null);
  const [contactError, setContactError] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const label = work ? workStatusLabel(status) : status;
  const contactDepartments = [...new Set((work ? [department] : departments).filter((value): value is string => Boolean(value)))];
  const contactKey = contactDepartments.join('|');
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => { cancelClose(); if (!open) { setContacts(null);setContactError(false); } setOpen(true); };
  const closeLater = () => {
    cancelClose();
    if (!root.current?.contains(document.activeElement)) timer.current = setTimeout(() => setOpen(false), 180);
  };

  useLayoutEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || !api || !contactKey) return;
    const controller = new AbortController();
    setContacts(null);setContactError(false);
    api.getDepartmentContacts(controller.signal).then((data:{items:{department:string;phone:string}[]}) => {
      if (!controller.signal.aborted) setContacts(Object.fromEntries(data.items.map(row => [row.department,row.phone])));
    }).catch(() => { if (!controller.signal.aborted) setContactError(true); });
    return () => controller.abort();
  }, [open, api, contactKey]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = root.current?.getBoundingClientRect();
      const tip = panel.current?.getBoundingClientRect();
      if (!trigger || !tip) return;
      const left = Math.max(16, Math.min(trigger.left, window.innerWidth - tip.width - 16));
      const below = trigger.bottom + 8;
      const top = below + tip.height <= window.innerHeight - 16 ? below : Math.max(16, trigger.top - tip.height - 8);
      setPosition({ left, top });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { cancelClose(); setOpen(false); }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, contacts, contactError]);

  return <span ref={root} className="workflow-status" onMouseEnter={show} onMouseLeave={closeLater}>
    <Button className={`badge workflow-status__trigger status-${status.replace(' ', '-').toLowerCase()}`} aria-label={`${work ? '우리 반 작업' : '요청 전체'} 상태: ${label}`} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={show} onBlur={() => { cancelClose(); setOpen(false); }} onClick={show}>
      {label}
    </Button>
    {open && createPortal(<div ref={panel} id={id} role="tooltip" className="workflow-status__popover" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }} onMouseEnter={cancelClose} onMouseLeave={closeLater}>
      <strong>{afterAction ? '수행 부서' : '담당 부서'}</strong>
      {contactDepartments.length ? <ul className="workflow-status__contacts">{contactDepartments.map(team => <li key={team}><span>{team}</span><span>{!api || contactError ? '대표번호 조회 실패' : contacts ? contacts[team] || '대표번호 미등록' : '대표번호 확인 중…'}</span></li>)}</ul> : <p>현재 담당 부서 없음</p>}
    </div>, document.body)}
  </span>;
}

export function StatusProcess({ status, work = false, afterAction = false }: { status: string; work?: boolean; afterAction?: boolean }) {
  const guide = statusGuide(status, work, afterAction);
  return <section role="region" aria-label={work ? '우리 반 작업 흐름' : '전체 처리 흐름'} className="workflow-status-process" data-tone={guide.tone}>
    <h2>{guide.kind === 'normal' ? (work ? '우리 반 작업' : '처리 현황') : guide.title}</h2>
    {guide.kind === 'normal' ? <StepFlow guide={guide} /> : <p>{guide.summary}</p>}
  </section>;
}
