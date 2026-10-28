import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Actor } from '../types';
import type { ApiClient } from '../api/apiClient.mjs';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/DateInput';
import { ActionGroup } from '../ui/ActionGroup';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { clearCommandRetry, commandForRetry, commandResultUnknown } from '../api/commandRetry.mjs';
import { absenceOn, calendarDates, seoulDate } from './mainFunctionsModel.mjs';
import { movePeriod } from '../app/dateTime.mjs';
import { dutyCandidates, officerSlots, serverSeat, uiSeat, dutyGroupsForDate, type Person, type Absence, type Duty } from './personnelModel';

type SavedPerson={personRef:string;displayName?:string;rank?:string;category?:string;department?:string;active?:boolean;conflict:boolean};
type ScheduleEntry={date:string;seat:string;scopeKey:string;revision:number;people:SavedPerson[]};
type DutyAssignment=Duty&{conflict?:boolean;rank?:string;name?:string};
type Props={actor:Actor;api:ApiClient;teams:string[];revision?:number};
const shortDate=(date:string)=>new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short',timeZone:'UTC'}).format(new Date(`${date}T00:00:00Z`));
const keyOf=(date:string,seat:string,scope='')=>`${date}|${seat}|${scope}`;

export function MonthlyDutyPreview({actor,api,teams,revision=0}:Props) {
  const today=seoulDate();const isBnoc=actor.role==='bnoc';const canEdit=isBnoc||actor.role==='team';const team=actor.teamId||actor.department;
  const [view,setView]=useState<'day'|'week'|'month'>('day');const [viewDate,setViewDate]=useState(today);const month=viewDate.slice(0,7);
  const [slot,setSlot]=useState(isBnoc?officerSlots[0]:'야간 근무자');
  const [dates,setDates]=useState<string[]>([today]);
  const [batch,setBatch]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [savedPeople,setSavedPeople]=useState<Record<string,SavedPerson>>({});
  const latestReload=useRef(0),selectionEdited=useRef(false);
  const context=useRef({dates,slot,batch});context.current={dates,slot,batch};
  const [people,setPeople]=useState<Person[]>([]);const [absences,setAbsences]=useState<Absence[]>([]);const [duties,setDuties]=useState<DutyAssignment[]>([]);const [versions,setVersions]=useState<Record<string,number>>({});
  const [search,setSearch]=useState('');const [selected,setSelected]=useState<string[]>([]);const [bulkText,setBulkText]=useState('');const [error,setError]=useState('');const [receipt,setReceipt]=useState('');const [loading,setLoading]=useState(true);const [loadError,setLoadError]=useState('');const [saving,setSaving]=useState(false);
  const pendingSchedule=useRef<{signature:string;operationId:string}|null>(null);const pendingText=useRef<{signature:string;operationId:string}|null>(null);
  const candidates=useMemo(()=>canEdit?dutyCandidates(people,actor.role,team):[],[canEdit,people,actor.role,team]);
  const visible=candidates.filter(person=>`${person.team} ${person.rank} ${person.name}`.toLocaleLowerCase('ko').includes(search.trim().toLocaleLowerCase('ko')));
  const scope=isBnoc?'':team;
  const viewDays=useMemo(()=>calendarDates(view,viewDate) as string[],[view,viewDate]);
  const scheduleMonthKey=[...new Set(viewDays.map(date=>date.slice(0,7)))].join(',');
  const existing=(date:string,currentSlot=slot)=>duties.filter(item=>item.date===date&&item.slot===currentSlot&&item.team===scope).map(item=>item.personId);
  const selectedKey=(ids:string[])=>JSON.stringify([...ids].sort());
  const changed=dates.some(date=>selectedKey(selected)!==selectedKey(existing(date)));
  useUnsavedChanges(changed||Boolean(bulkText.trim())||uncertain,uncertain);
  const reload=useCallback(async()=>{
    const request=++latestReload.current;
    setLoading(true);setLoadError('');
    try {
      const requestedMonths=scheduleMonthKey.split(',').filter(Boolean);
      const [directory,schedules]=await Promise.all([canEdit?api.getRoster():Promise.resolve({entries:[]}),Promise.all(requestedMonths.map(value=>api.getDutySchedules({month:value})))]);
      if(request!==latestReload.current)return;
      const entries=directory.entries as any[];
      const mapped=entries.filter(item=>item.category&&item.rank).map(item=>({id:item.personRef,team:item.department,name:item.displayName,category:item.category,rank:item.rank,serviceNumber:item.serviceNumber||'',phone:item.internalPhone||'',active:item.active} as Person));
      const absenceRows:Absence[]=entries.flatMap(item=>(item.absences||[]).map((record:any)=>({id:record.absenceRef,personId:item.personRef,kind:record.absenceType,start:record.startDate,end:record.endDate})));
      const scheduleRows=schedules.flatMap(result=>result.entries as ScheduleEntry[]);const nextDuties:DutyAssignment[]=[];const nextVersions:Record<string,number>={};const memberDetails:Record<string,SavedPerson>={};
      for(const entry of scheduleRows){const displaySlot=uiSeat(entry.seat);const scopeKey=entry.seat==='team_night'?entry.scopeKey:'';nextVersions[keyOf(entry.date,displaySlot,scopeKey)]=entry.revision;entry.people.forEach((person,index)=>{const personId=person.personRef||`readonly:${entry.date}:${entry.seat}:${scopeKey}:${index}`;if(person.personRef)memberDetails[person.personRef]=person;nextDuties.push({id:`${entry.date}|${displaySlot}|${scopeKey}|${personId}`,date:entry.date,slot:displaySlot,team:scopeKey,personId,rank:person.rank,name:person.displayName,conflict:person.conflict});});}
      setPeople(mapped);setAbsences(absenceRows);setSavedPeople(memberDetails);
      if(!selectionEdited.current&&!pendingSchedule.current&&!pendingText.current){setDuties(nextDuties);setVersions(nextVersions);const current=context.current;if(canEdit&&!current.batch)setSelected(nextDuties.filter(item=>item.date===current.dates[0]&&item.slot===current.slot&&item.team===scope).map(item=>item.personId));}
    }catch(failure){if(request===latestReload.current)setLoadError(failure instanceof Error?failure.message:'근무표를 불러오지 못했습니다.');}
    finally{if(request===latestReload.current)setLoading(false);}
  },[api,canEdit,scheduleMonthKey,scope]);
  useEffect(()=>{void reload();},[reload,revision]);
  const days=calendarDates('month',`${month}-01`) as string[];const offset=(new Date(`${month}-01T00:00:00Z`).getUTCDay()+6)%7;
  const visibleDateSet=new Set(viewDays);const calendarDuties=duties.filter(item=>visibleDateSet.has(item.date));
  const clearFeedback=()=>{setError('');setReceipt('');};
  const canSwitch=()=>{if(uncertain||saving)return false;if(!changed&&!bulkText.trim())return true;if(!window.confirm('저장하지 않은 근무 편성을 취소할까요?'))return false;setBulkText('');setError('');return true;};
  const chooseMonth=(value:string,date=`${value}-01`)=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)||!canSwitch())return;selectionEdited.current=false;setViewDate(date);setDates([date]);setSelected([]);setBatch(false);clearFeedback();};
  const chooseView=(nextView:'day'|'week'|'month')=>{if(nextView===view||!canSwitch())return;const date=dates[0]||viewDate;setView(nextView);setViewDate(date);setDates([date]);setSelected(existing(date));setBatch(false);selectionEdited.current=false;clearFeedback();};
  const movePeriodBy=(amount:number)=>{if(!canSwitch())return;const next=movePeriod(viewDate,view,amount);setViewDate(next);setDates([next]);setSelected(existing(next));setBatch(false);selectionEdited.current=false;clearFeedback();};
  const chooseViewDate=(date:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||uncertain||saving||loading||(!canSwitch()&&dates[0]!==date))return;if(batch){setBatch(false);}setViewDate(date);setDates([date]);selectionEdited.current=false;setSelected(existing(date));clearFeedback();};
  const chooseDay=(date:string)=>{if(uncertain||saving||loading)return;if(view==='month'&&batch){clearFeedback();setDates(current=>current.includes(date)?current.filter(value=>value!==date):[...current,date].sort());return;}chooseViewDate(date);};
  const chooseSlot=(value:string)=>{if(value===slot||!canSwitch())return;selectionEdited.current=false;setSlot(value);setSelected(existing(dates[0]||'',value));clearFeedback();};
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(saving)return;
    if(!dates.length||!selected.length){setError('근무자를 한 명 이상 선택하세요.');return;}
    setSaving(true);setError('');
    try{
      const entries=dates.map(date=>({date,personRefs:selected,expectedRevision:versions[keyOf(date,slot,scope)]||0}));
      const command=commandForRetry(pendingSchedule,{type:'saveDutyScheduleBatch',payload:{month,seat:serverSeat(slot),mode:batch?'append':'replace',entries}});
      const result=await api.dispatch(command);clearCommandRetry(pendingSchedule);setUncertain(false);selectionEdited.current=false;
      setReceipt(result.state||`${dates.length}일 저장됨`);setBatch(false);await reload();
    }catch(failure){const unknown=commandResultUnknown(failure);setUncertain(unknown);if(!unknown)clearCommandRetry(pendingSchedule);setError(failure instanceof Error?failure.message:'저장하지 못했습니다. 선택 내용을 유지했습니다.');}
    finally{setSaving(false);}
  };
  const addBulkText=async()=>{
    if(changed){setError('먼저 근무자 선택을 저장하거나 취소하세요.');return;}
    if(!bulkText.trim()){setError('근무자 목록을 입력하세요.');return;}
    setSaving(true);setError('');setReceipt('');
    try{
      const command=commandForRetry(pendingText,{type:'saveDutyScheduleBatch',payload:{month,seat:serverSeat(slot),text:bulkText}});
      const result=await api.dispatch(command);clearCommandRetry(pendingText);setUncertain(false);selectionEdited.current=false;
      setReceipt(result.state||'근무표를 추가했습니다.');setBulkText('');await reload();
    }catch(failure){const unknown=commandResultUnknown(failure);setUncertain(unknown);if(!unknown)clearCommandRetry(pendingText);setError(failure instanceof Error?failure.message:'근무자 목록을 확인하세요.');}
    finally{setSaving(false);}
  };
  const weekCount=Math.ceil((offset+days.length)/7);
  const shortName=(item:DutyAssignment)=>{const person=people.find(person=>person.id===item.personId),saved=savedPeople[item.personId];return `${item.rank||person?.rank||saved?.rank||''} ${item.name||person?.name||saved?.displayName||'명부 확인 필요'}`.trim();};
  const renderGroups=(date:string,officersOnly=false)=><div className="duty-date-groups">{dutyGroupsForDate(calendarDuties,teams,date).filter(group=>!officersOnly||officerSlots.includes(group.slot)).map(group=><section className="duty-date-group" key={group.key} data-seat={serverSeat(group.slot)} aria-label={group.team?`${group.team} 야간근무`:group.slot}><h3>{group.team?`${group.team} 야간근무`:`${group.slot} · 24시간`}</h3><ul tabIndex={officersOnly?0:undefined} aria-label={officersOnly?`${group.slot} 근무자`:undefined}>{group.people.length?group.people.map(item=><li key={item.id}>{shortName(item)}</li>):<li className="duty-unassigned"><span aria-label={loading?'조회 중':loadError?'편성 조회 실패':'미편성'}>—</span></li>}</ul></section>)}</div>;
  const renderCalendarDay=(date:string)=>{
    const entries=calendarDuties.filter(item=>item.date===date);
    const names=[...new Set(entries.map(item=>item.personId))].map(personId=>shortName(entries.find(item=>item.personId===personId)!));
    const conflict=entries.some(item=>item.conflict||absenceOn(absences,item.personId,date));
    const fullDetails=names.join(' · ');
    const visibleNames=view==='month'?1:2;
    return <Button key={date} className={`duty-day${date===today?' duty-day--today':''}${conflict?' duty-day--conflict':''}`} aria-label={`${date} 근무자 보기${conflict?' · 편성 충돌':''}${fullDetails?` · ${fullDetails}`:''}`} title={fullDetails||undefined} aria-pressed={dates.includes(date)} disabled={saving||uncertain||loading} onClick={()=>chooseDay(date)}><span className="duty-day-number">{Number(date.slice(8))}{view==='month'&&names.length>visibleNames&&<span className="duty-day-more" aria-hidden="true" title={names.slice(visibleNames).join(' · ')}>외 {names.length-visibleNames}명</span>}{conflict&&<span className="duty-conflict-dot" aria-hidden="true">!</span>}</span><span className="duty-day-entries">{names.slice(0,visibleNames).map((name,index)=><span className="duty-entry" title={name} key={`${date}-${index}-${name}`}>{name}</span>)}{view!=='month'&&names.length>visibleNames&&<span className="duty-entry duty-entry--more" title={names.slice(visibleNames).join(' · ')}>외 {names.length-visibleNames}명</span>}</span></Button>;
  };
  const heading=view==='day'?'당직 야간근무 현황':view==='week'?'주간 당직 야간근무 현황':'월간 당직 야간근무 현황';
  const roleNote=[actor.role==='team'?'작업반은 자기 반 야간근무자를 월별로 편성합니다.':null,'당직사관, A대대 일직사관, B대대 일직사관은 24시간 근무자로 야간 현황에 포함됩니다.'].filter(Boolean).join(' · ');
  const currentDate=dates[0]||viewDate;
  return <div className="main-preview-stack duty-page">
    <div className="page-head"><div><h1>{heading}</h1><p className="duty-role-note">{roleNote}</p></div></div>
    <div className="duty-toolbar"><ActionGroup><div className="duty-view-tabs" role="group" aria-label="근무표 보기">{([['day','일'],['week','주'],['month','월']] as const).map(([value,label])=><Button key={value} aria-pressed={view===value} onClick={()=>chooseView(value)}>{label}</Button>)}</div><Button aria-label="이전 기간" onClick={()=>movePeriodBy(-1)}>이전</Button>{view==='month'?<label className="field duty-month"><span className="sr-only">대상 월</span><input aria-label="대상 월" type="month" disabled={saving||uncertain} required value={month} onChange={event=>chooseMonth(event.target.value)}/></label>:<label className="field duty-date"><span className="sr-only">기준 날짜</span><DateInput aria-label="기준 날짜" disabled={saving||uncertain} required value={viewDate} onChange={event=>{if(event.target.value)chooseViewDate(event.target.value);}}/></label>}<Button aria-label="다음 기간" onClick={()=>movePeriodBy(1)}>다음</Button><Button onClick={()=>chooseViewDate(today)}>오늘</Button></ActionGroup>{canEdit&&view==='month'&&<Button aria-pressed={batch} onClick={()=>{if(!canSwitch())return;selectionEdited.current=false;setBatch(value=>!value);setDates([dates[0]||today]);setSelected(batch?existing(dates[0]||today):[]);clearFeedback();}}>여러 날짜 편성</Button>}</div>
    <div className="duty-status-area" aria-live="polite">{loadError&&<p role="alert" className="error">{loadError} <Button onClick={()=>void reload()}>다시 불러오기</Button></p>}{loading&&<p role="status">불러오는 중…</p>}{error&&<p role="alert" className="error">{error}</p>}{receipt&&<p role="status" className="duty-feedback">{receipt}</p>}</div>
    <div className={`duty-workspace${canEdit?'':' duty-workspace--readonly'} duty-workspace--${view}`}>
      <section className={`card duty-calendar-panel duty-calendar-panel--${view}`} aria-label={view==='month'?`${month} 월간 근무자`:view==='week'?'주간 근무자':`${viewDate} 근무자`}>
        {view!=='day'&&<section className="duty-officer-board" aria-label={`${currentDate} 당직·일직 편성`}><h2>{shortDate(currentDate)} 당직·일직</h2>{renderGroups(currentDate,true)}</section>}
        {view==='day'&&<div className="duty-daily-summary"><div className="row-head"><h2>{viewDate===today?'금일 근무 편성':`${shortDate(viewDate)} 근무 편성`}</h2><span>{viewDate}</span></div>{renderGroups(viewDate)}</div>}
        {view==='week'&&<div className="duty-calendar duty-calendar--week" style={{gridTemplateRows:'auto minmax(0,1fr)'}} role="group" aria-label="주간 근무자">{['월','화','수','목','금','토','일'].map(day=><span className="duty-weekday" key={day}>{day}</span>)}{viewDays.map(date=>renderCalendarDay(date))}</div>}
        {view==='month'&&<div className="duty-calendar" style={{gridTemplateRows:`auto repeat(${weekCount}, minmax(0, 1fr))`}} role="group" aria-label="월간 근무자">{['월','화','수','목','금','토','일'].map(day=><span className="duty-weekday" key={day}>{day}</span>)}{Array.from({length:offset},(_,index)=><div className="duty-blank" key={`blank-${index}`} aria-hidden="true"/>)}{days.map(renderCalendarDay)}</div>}
      </section>
      {canEdit&&<form className={`card duty-editor${view==='month'?' duty-editor--month':''}`} onSubmit={save} aria-label="근무 편성"><div className="row-head"><h2>{currentDate===today?'오늘 편성':shortDate(currentDate)}</h2>{batch&&<span className="badge">여러 날짜</span>}</div>{view!=='day'&&<details className={`duty-current-summary${view==='month'?' duty-current-summary--collapsed':''}`} aria-label="선택 날짜 야간근무자" open={view!=='month'}><summary>{currentDate===today?'금일 근무 편성':`${shortDate(currentDate)} 근무 편성`}</summary>{renderGroups(currentDate)}</details>}
        {batch&&dates.length>0&&<div className="duty-selected-days">{dates.map(date=><Button key={date} aria-label={`${date} 선택 해제`} onClick={()=>chooseDay(date)}>{Number(date.slice(8))}일 ×</Button>)}</div>}
        {isBnoc&&<label className="field"><span>근무 자리</span><select disabled={saving||uncertain||loading} value={slot} onChange={event=>chooseSlot(event.target.value)}>{officerSlots.map(value=><option key={value}>{value}</option>)}</select></label>}
        <details className="duty-text-import"><summary>텍스트로 일괄 추가</summary><div className="duty-text-import__body"><label className="field"><span>근무자 목록</span><textarea aria-label="근무자 목록" placeholder="YYYYMMDD 계급 이름" disabled={saving||uncertain} value={bulkText} onChange={event=>{setBulkText(event.target.value);setError('');setReceipt('');}}/></label><p className="muted"><code>YYYYMMDD 계급 이름</code></p><Button type="button" variant="primary" onClick={()=>void addBulkText()} disabled={!bulkText.trim()||saving||Boolean(pendingSchedule.current)}>입력한 근무자 추가</Button></div></details>
        {dates.length>0&&<><label className="field"><span>근무자 검색</span><input type="search" placeholder="부서·이름·계급" value={search} onChange={event=>setSearch(event.target.value)}/></label><fieldset className="duty-candidates"><legend>{batch?'추가 인원':'근무자'} <span className="count">{selected.length}명</span></legend>{visible.map(person=>{const absentDate=dates.find(date=>absenceOn(absences,person.id,date));const absent=absentDate?absenceOn(absences,person.id,absentDate) as Absence:undefined;const checked=selected.includes(person.id);const inactive=person.active===false;return <label className={`duty-person${absent||inactive?' duty-person--unavailable':''}`} key={person.id}><input type="checkbox" aria-label={`${person.rank} ${person.name} · ${person.team}`} aria-describedby={absent?`duty-absence-${person.id}`:inactive?`duty-inactive-${person.id}`:undefined} disabled={saving||uncertain||loading||(!checked&&(Boolean(absent)||inactive))} checked={checked} onChange={()=>{selectionEdited.current=true;setSelected(checked?selected.filter(id=>id!==person.id):[...selected,person.id]);clearFeedback();}}/><span><strong>{person.rank} {person.name}</strong><small>{isBnoc?person.team:person.category}</small>{inactive&&<span className="duty-unavailable" id={`duty-inactive-${person.id}`}>비활성 인원</span>}{absent&&<span className="duty-unavailable" id={`duty-absence-${person.id}`}>{absent.kind} · {absentDate?.slice(5)}</span>}</span></label>;})}{selected.filter(id=>!candidates.some(person=>person.id===id)).map(id=><label className="duty-person duty-person--unavailable" key={id}><input type="checkbox" checked disabled={saving||uncertain} onChange={()=>{selectionEdited.current=true;setSelected(selected.filter(ref=>ref!==id));}}/><span><strong>{savedPeople[id]?.rank} {savedPeople[id]?.displayName||'명부 확인 필요'}</strong><small>기존 편성: 소속/명부 변경, 선택 해제 가능</small>{duties.some(item=>item.personId===id&&dates.includes(item.date)&&item.conflict)&&<small>부재 충돌: 근무표 정정 필요</small>}</span></label>)}{!visible.length&&<p className="empty">검색 결과 없음</p>}</fieldset>
          <Button type="submit" variant="primary" className="duty-save" disabled={saving||loading||Boolean(pendingText.current)}>{saving?'저장 중…':batch?`${dates.length}일 야간근무표 저장`:isBnoc?'당직·일직 편성 저장':'작업반 야간근무표 저장'}</Button></>}
      </form>}
      {!canEdit&&view!=='day'&&<aside className="card duty-readonly-details" aria-label="선택 날짜 야간근무자"><div className="row-head"><h2>{currentDate===today?'금일 근무 편성':`${shortDate(currentDate)} 근무 편성`}</h2></div>{renderGroups(currentDate)}</aside>}
    </div>
  </div>;
}
