import type { Dispatch, SetStateAction } from 'react';
import type { Actor, ScheduleEntry } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { calendarRange, displayClock, moveDate, movePeriod, seoulDate } from '../app/dateTime.mjs';
import { calendarPlacementsForPeriod } from '../app/scheduleIntervals.mjs';
import { workStatusLabel } from '../types';
import { DateInput } from '../ui/DateInput';
import { ResourceStatus } from './ResourceStatus';
import { QueryContext } from './QueryContext';

type PlannedCalendarEntry = { source: 'planned'; plannedWorkId: string; title: string; teamId: string; status: string; firstWorkDate: string; completedDate?: string | null };
type TeamSchedule = { entries: ScheduleEntry[]; completedRecords: ScheduleEntry[]; unscheduled: ScheduleEntry[]; plans: PlannedCalendarEntry[]; queriedAt?: string };
export type TeamScheduleSelection = { mode: 'day' | 'week' | 'month'; date: string };
export const initialTeamScheduleSelection = (): TeamScheduleSelection => ({ mode: 'week', date: seoulDate() });

function calendarIntervalText(intervals: NonNullable<ScheduleEntry['scheduleIntervals']>) {
  const dates = new Set(intervals.flatMap(interval => [seoulDate(interval.startsAt), seoulDate(interval.endsAt)]));
  const includeDates = dates.size > 1;
  const dateLabel = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).format(new Date(value));
  const clock = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return intervals.map(interval => `${includeDates ? `${dateLabel(interval.startsAt)} ` : ''}${clock(interval.startsAt)}–${includeDates ? `${dateLabel(interval.endsAt)} ` : ''}${clock(interval.endsAt)}`).join(' · ');
}

export function TeamScheduleView({ actor, query, revision = 0, onOpen, selection, onSelectionChange }: {
  actor: Actor; query: ApiClient; revision?: number; onOpen: (id: string) => void;
  selection: TeamScheduleSelection; onSelectionChange: Dispatch<SetStateAction<TeamScheduleSelection>>;
}) {
  const { mode, date } = selection;
  const setMode = (mode: TeamScheduleSelection['mode']) => onSelectionChange(previous => ({ ...previous, mode }));
  const setDate = (date: string) => onSelectionChange(previous => ({ ...previous, date }));
  const range = calendarRange(date, mode);
  const context = { range, mode, conditions: `${({ day: '일', week: '주', month: '월' })[mode]} · ${range.firstDate}${range.firstDate !== range.lastDate ? ` ~ ${range.lastDate}` : ''}` };
  const result = useResource<TeamSchedule, typeof context>(signal => query.getTeamSchedule({ from: range.from, to: range.to }, signal), [query, actor.id, range.from, range.to, revision], context);
  const displayed = result.success?.context ?? context;
  const items = result.data?.entries ?? [];
  const completedRecords = result.data?.completedRecords ?? [];
  const unscheduled = result.data?.unscheduled ?? [];
  const plans = result.data?.plans ?? [];
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

  const plansOn = (day: string) => plans.filter(plan => plan.completedDate ? plan.completedDate === day : plan.status === '진행 중' && plan.firstWorkDate <= day);
  return <>
    <div className="page-head"><h1>{actor.role === 'bnoc' ? '정비 일정' : actor.role === 'team' ? '우리 반 일정' : '정비 달력'}</h1><button onClick={result.reload}>새로고침</button></div>
    <div className="row-head calendar-toolbar"><div className="tabs" aria-label="일정 보기">{([['day', '일'], ['week', '주'], ['month', '월']] as const).map(([value, label]) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div><div className="actions"><button aria-label="이전 기간" onClick={() => setDate(movePeriod(date, mode, -1))}>이전</button><button onClick={() => setDate(seoulDate())}>오늘</button><button aria-label="다음 기간" onClick={() => setDate(movePeriod(date, mode, 1))}>다음</button><label className="field"><span className="sr-only">기준 날짜</span><DateInput aria-label="기준 날짜" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label></div></div>
    <p className="calendar-period">{displayed.range.firstDate}{displayed.range.firstDate !== displayed.range.lastDate && ` ~ ${displayed.range.lastDate}`}</p>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} />
    {result.data && <>
      <p className="calendar-summary"><span>기간 내 예정 작업 <strong>{items.length}건</strong></span><span>완료 기록 <strong>{completedRecords.length}건</strong></span><span>계획 정비 <strong>{plans.length}건</strong></span></p>
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
          const dayPlans = plansOn(day);
          return <section className="calendar-day" key={day} style={style}><h2>{dayHeading}</h2>{dayPlans.length > 0 && <div className="calendar-planned-list" aria-label="계획 정비">{dayPlans.map(plan => <div className={`calendar-item calendar-item--${plan.status === '완료' ? 'completed' : 'scheduled'}`} key={plan.plannedWorkId}><strong>{plan.title}</strong><span>{plan.teamId} · {plan.status}</span></div>)}</div>}{hours}</section>;
        })}
      </div>
      <details className="details-panel section-gap"><summary>일정 미정 <span className="count">작업 {unscheduled.length}건</span></summary>{unscheduled.length ? <div className="work-list">{unscheduled.map(item => card(item))}</div> : <p className="empty">일정 미정인 작업이 없습니다.</p>}</details>
    </>}
  </>;
}
