import { useState } from 'react';
import type { Actor, ScheduleEntry } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { calendarRange, displayClock, displayTime, moveDate, movePeriod, seoulDate } from '../app/dateTime.mjs';
import { calendarPlacementsForPeriod } from '../app/scheduleIntervals.mjs';
import { workStatusLabel } from '../types';
import { DateInput } from '../ui/DateInput';
import { ResourceStatus } from './ResourceStatus';
import { QueryContext } from './QueryContext';

type TeamSchedule = { entries: ScheduleEntry[]; completedRecords: ScheduleEntry[]; unscheduled: ScheduleEntry[]; queriedAt?: string };

function calendarIntervalText(intervals: NonNullable<ScheduleEntry['scheduleIntervals']>) {
  const dates = new Set(intervals.flatMap(interval => [seoulDate(interval.startsAt), seoulDate(interval.endsAt)]));
  const includeDates = dates.size > 1;
  const dateLabel = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).format(new Date(value));
  const clock = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return intervals.map(interval => `${includeDates ? `${dateLabel(interval.startsAt)} ` : ''}${clock(interval.startsAt)}–${includeDates ? `${dateLabel(interval.endsAt)} ` : ''}${clock(interval.endsAt)}`).join(' · ');
}

export function TeamScheduleView({ actor, query, revision = 0, onOpen }: { actor: Actor; query: ApiClient; revision?: number; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<'day' | 'week' | 'month'>('week');
  const [date, setDate] = useState(seoulDate());
  const range = calendarRange(date, mode);
  const context = { range, mode, conditions: `${({ day: '일', week: '주', month: '월' })[mode]} · ${range.firstDate}${range.firstDate !== range.lastDate ? ` ~ ${range.lastDate}` : ''} · 한국 시간` };
  const result = useResource<TeamSchedule, typeof context>(signal => query.getTeamSchedule({ from: range.from, to: range.to }, signal), [query, actor.id, range.from, range.to, revision], context);
  const displayed = result.success?.context ?? context;
  const items = result.data?.entries ?? [];
  const completedRecords = result.data?.completedRecords ?? [];
  const unscheduled = result.data?.unscheduled ?? [];
  const dates: string[] = [];
  for (let cursor = displayed.range.firstDate; cursor <= displayed.range.lastDate; cursor = moveDate(cursor, 1)) dates.push(cursor);
  const placements = calendarPlacementsForPeriod(items, completedRecords, dates);

  const card = (item: ScheduleEntry, time?: string, key = 'unscheduled', state?: 'scheduled' | 'completed') => <button type="button" className={`calendar-item${state ? ` calendar-item--${state}` : ''}`} key={`${item.workNumber}-${key}`} onClick={() => onOpen(item.request.requestNumber)}>
    {time && <strong className="calendar-time">{time}</strong>}
    <span className="calendar-work-number">작업번호: {item.workNumber} ({workStatusLabel(item.status)})</span>
    <span className="calendar-location">위치: {item.location}</span>
    {item.memo && <span className="calendar-memo">작업 메모: {item.memo}</span>}
  </button>;

  const placementTime = (placement: ReturnType<typeof calendarPlacementsForPeriod>[number]) => {
    if (placement.kind === 'after-action') return displayClock(placement.item.actualStartedAt);
    return placement.intervals.length ? calendarIntervalText(placement.intervals) : undefined;
  };

  return <>
    <div className="page-head"><h1>{actor.role === 'bnoc' ? '정비 일정' : '우리 반 일정'}</h1><button onClick={result.reload}>새로고침</button></div>
    <div className="row-head"><div className="tabs" aria-label="일정 보기">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div><div className="actions"><button aria-label="이전 기간" onClick={() => setDate(movePeriod(date, mode, -1))}>이전</button><button onClick={() => setDate(seoulDate())}>오늘</button><button aria-label="다음 기간" onClick={() => setDate(movePeriod(date, mode, 1))}>다음</button><label className="field"><span className="sr-only">기준 날짜</span><DateInput aria-label="기준 날짜" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label></div></div>
    <p>조회 선택: {range.firstDate}{range.firstDate !== range.lastDate ? ` ~ ${range.lastDate}` : ''} · 한국 시간</p><p className="muted">작업반이 정한 작업 일정입니다. 희망 일정은 신청 상세에서 확인합니다.</p>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} />
    {result.data && <>
      <p className="muted">기간 내 예정 작업 {items.length}건 · 완료 기록 {completedRecords.length}건</p>
      <div className={`calendar-grid calendar-${displayed.mode === 'day' ? 'single-day' : displayed.mode}`}>
        {dates.map((day, index) => {
          const dayPlacements = placements.filter(placement => placement.date === day);
          const hours = Array.from({ length: 24 }, (_, hour) => {
            const atHour = dayPlacements.filter(placement => placement.hour === hour);
            if (!atHour.length) return null;
            const label = `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;
            return <section className="calendar-hour" key={hour}><h3>{label}</h3><div className="calendar-hour-items">
              {atHour.map(placement => card(placement.item, placementTime(placement), `${placement.kind}-${placement.sortAt}`, placement.kind === 'scheduled' ? 'scheduled' : 'completed'))}
            </div></section>;
          });
          const dayHeading = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
          const style = displayed.mode === 'day' ? { gridColumn: '1 / -1' } : displayed.mode === 'month' && index === 0 ? { gridColumnStart: (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7 + 1 } : undefined;
          return <section className="calendar-day" key={day} style={style}><h2>{dayHeading}</h2>{hours.some(Boolean) ? hours : <p className="empty">등록된 일정이 없습니다.</p>}</section>;
        })}
      </div>
      <details className="details-panel section-gap"><summary>일정 미정 <span className="count">작업 {unscheduled.length}건</span></summary>{unscheduled.length ? <div className="work-list">{unscheduled.map(item => card(item))}</div> : <p className="empty">일정 미정인 작업이 없습니다.</p>}</details>
      {result.data.queriedAt && <small>일정 기준 시각: {displayTime(result.data.queriedAt)}</small>}
    </>}
  </>;
}
