import { useState } from 'react';
import type { Actor, ScheduleEntry } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { calendarRange, displayTime, moveDate, movePeriod, seoulDate } from '../app/dateTime.mjs';
import { DateInput } from '../ui/DateInput';
import { ResourceStatus } from './ResourceStatus';
import { QueryContext } from './QueryContext';
export function TeamScheduleView({ actor, query, revision = 0, onOpen }: { actor: Actor; query: ApiClient; revision?: number; onOpen: (id:string) => void }) {
  const [mode, setMode] = useState<'day'|'week'|'month'>('week'), [date, setDate] = useState(seoulDate());
  const range = calendarRange(date, mode);
  const context = { range, mode, conditions: `${({ day:'일', week:'주', month:'월' })[mode]} · ${range.firstDate}${range.firstDate !== range.lastDate ? ' ~ ' + range.lastDate : ''} · 한국 시간` };
  const result = useResource<{ entries: ScheduleEntry[]; unscheduled: ScheduleEntry[]; queriedAt?: string }, typeof context>(signal => query.getTeamSchedule({ from: range.from, to: range.to }, signal), [query, actor.id, range.from, range.to, revision], context);
  const displayed = result.success?.context ?? context;
  const items = result.data?.entries.filter(item => !!item.scheduledAt) ?? [], unscheduled = result.data?.unscheduled ?? [];
  const dates: string[] = [];
  for (let cursor = displayed.range.firstDate; cursor <= displayed.range.lastDate; cursor = moveDate(cursor, 1)) dates.push(cursor);
  const card = (item: ScheduleEntry) => <article className="calendar-item" key={item.workNumber}><button className="link" onClick={() => onOpen(item.request.requestNumber)}>{item.workNumber}</button><small>{item.teamId} · {item.status}</small>{item.scheduledAt && <small>{displayTime(item.scheduledAt)}</small>}</article>;
  return <><div className="page-head"><h1>{actor.role === 'bnoc' ? '정비 일정' : '우리 반 일정'}</h1><button onClick={result.reload}>새로고침</button></div>
    <div className="row-head"><div className="tabs" aria-label="일정 보기">{([['day','일'],['week','주'],['month','월']] as const).map(([value,label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div><div className="actions"><button aria-label="이전 기간" onClick={() => setDate(movePeriod(date, mode, -1))}>이전</button><button onClick={() => setDate(seoulDate())}>오늘</button><button aria-label="다음 기간" onClick={() => setDate(movePeriod(date, mode, 1))}>다음</button><label className="field"><span className="sr-only">기준 날짜</span><DateInput aria-label="기준 날짜" value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label></div></div>
    <p>조회 선택: {range.firstDate}{range.firstDate !== range.lastDate ? ' ~ ' + range.lastDate : ''} · 한국 시간</p><p className="muted">작업반이 정한 작업 일정입니다. 희망 일정은 신청 상세에서 확인합니다.</p>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} />
    {result.data && <><p className="muted">기간 내 예정 작업 {items.length}건</p><div className={`calendar-grid calendar-${displayed.mode === 'day' ? 'single-day' : displayed.mode}`}>{dates.map((day,index) => <section className="calendar-day" key={day} style={displayed.mode === 'day' ? { gridColumn: '1 / -1' } : displayed.mode === 'month' && index === 0 ? { gridColumnStart: (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1 } : undefined}><h2>{new Intl.DateTimeFormat('ko-KR', { month:'numeric', day:'numeric', weekday:'short', timeZone:'UTC' }).format(new Date(day + 'T00:00:00Z'))}</h2>{items.filter(item => seoulDate(item.scheduledAt) === day).map(card)}</section>)}</div>
      <details className="details-panel section-gap"><summary>일정 미정 <span className="count">작업 {unscheduled.length}건</span></summary>{unscheduled.length ? <div className="work-list">{unscheduled.map(card)}</div> : <p className="empty">일정 미정인 작업이 없습니다.</p>}</details>{result.data.queriedAt && <small>일정 기준 시각: {displayTime(result.data.queriedAt)}</small>}
    </>}
  </>;
}
