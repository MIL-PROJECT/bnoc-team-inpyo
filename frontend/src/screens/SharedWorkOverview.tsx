import { useState, type FormEvent } from 'react';
import type { Actor, SharedWork, WorkOverview } from '../types';
import { priorityLabel, workStatusLabel } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { displayTime, seoulDate } from '../app/dateTime.mjs';
import { displayInterval } from '../app/scheduleIntervals.mjs';
import { Button } from '../ui/Button';
import type {RunCommand} from './RequestRegistrationForm';
import {DepartmentContactEditor} from './DepartmentContactEditor';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';

const initial = () => ({ teamId: '', category: '', workType: '', systemType: '', status: '', priority: '' });
const bucketLabels: Record<string, string> = { assigned:'할당 작업', completed:'완료 작업', remaining:'남은 작업', returned:'반환 대기 작업', unassigned:'미배정 요청', 'after-action':'선조치 후보고', planned:'계획 정비', all:'전체 작업' };
const dateLabel = (value?: string) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${value}T00:00:00Z`)) : '—';

function ProgressTrack({ label, completed, remaining, total, planned = false }: { label: string; completed: number; remaining: number; total: number; planned?: boolean }) {
  const max=Math.max(total,1), value=total>0?Math.min(Math.max(completed,0),total):0;
  const width=total>0?Math.min(Math.max(completed/total*100,0),100):0;
  return <div className={`overview-progress${planned?' overview-progress--planned':''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`완료 ${completed}건, ${planned?'진행':'남음'} ${remaining}건`}><span aria-hidden="true" style={{width:`${width}%`}} /></div>;
}

export function SharedWorkOverview({ api, teams, revision, onOpen, actor, run }: { actor?:Actor;run?:RunCommand;api: ApiClient; teams: string[]; revision: number; onOpen: (number: string) => void }) {
  const [criteria, setCriteria] = useState(initial), [applied, setApplied] = useState(initial), [bucket, setBucket] = useState('assigned'), [page, setPage] = useState(0), [advanced, setAdvanced] = useState(false);
  const context = { bucket, page, teamId:applied.teamId, conditions: describeConditions([
    ['부서', applied.teamId], ['지원 유형', applied.category], ['체계 종류', applied.systemType], ['작업 유형', applied.workType],
    ['작업 상태', applied.status], ['일반·긴급', applied.priority ? priorityLabel(applied.priority) : '']
  ]) + ` · ${bucketLabels[bucket]} · ${page + 1}페이지` };
  const result = useResource<WorkOverview, typeof context>(signal => api.getWorkOverview({ ...applied, bucket, page, size: 20 }, signal), [api, applied, bucket, page, revision], context);
  const view = result.data;
  const count = (key: string) => view?.counts[key] ?? (key === 'unassigned' ? typeof view?.unassignedRequests === 'number' ? view.unassignedRequests : view?.unassignedRequests?.length : key === 'after-action' ? typeof view?.afterActionCompleted === 'number' ? view.afterActionCompleted : view?.afterActionCompleted?.length : 0) ?? 0;
  const assignedTotal=view?.counts.assigned??0, assignedCompleted=view?.counts.completed??0, assignedRemaining=view?.counts.remaining??0;
  const plannedTotal=view?.counts.planned??((view?.counts.plannedCompleted??0)+(view?.counts.plannedInProgress??0));
  const plannedCompleted=view?.counts.plannedCompleted??0, plannedInProgress=view?.counts.plannedInProgress??0;
  const allTotal=view?.counts.all??(assignedTotal+plannedTotal);
  const allCompleted=view?.counts.allCompleted??(assignedCompleted+plannedCompleted);
  const allRemaining=view?.counts.allRemaining??(assignedRemaining+plannedInProgress);
  const scheduleText = (item: WorkOverview['items'][number]) => item.scheduleIntervals?.length
    ? item.scheduleIntervals.map(interval => `${seoulDate(interval.startsAt)} ${displayInterval(interval)}`).join(' · ')
    : displayTime(item.schedule ?? item.scheduledAt);
  const requestOnlyFilters = Boolean(applied.category || applied.workType || applied.systemType || applied.priority);
  const displayed = result.success?.context ?? context;
  const displayedDepartments=view?.byDepartment.filter(row=>!displayed.teamId||row.department===displayed.teamId)??[];
  const search = (event: FormEvent) => { event.preventDefault(); setApplied({ ...criteria }); setPage(0); };
  const set = (field: keyof ReturnType<typeof initial>, value: string) => setCriteria(previous => ({ ...previous, [field]: value }));
  const openBucket = (value: string) => { setBucket(value); setPage(0); };
  const renderRow = (item: SharedWork) => {
    const planned = item.source === 'planned';
    const number = item.workNumber ?? item.requestNumber;
    const statusClass = item.status.replace(' ', '-');
    return <tr key={planned ? `planned-${item.plannedWorkId ?? item.id}` : `${item.source ?? 'assigned'}-${number}`}>
      <td>{planned ? <span>계획 정비</span> : item.canOpenDetail && item.requestNumber ? <button className="link" onClick={() => onOpen(item.requestNumber!)}>{number}</button> : <span>{number}<small>상세 조회 제한</small></span>}</td>
      <td>{item.teamId ?? item.department ?? '미배정'}</td>
      <td>{planned ? item.title : `${item.category ?? '—'}${item.workType ? ' · ' + item.workType : ''}`}</td>
      <td>{planned ? '계획 정비' : item.workNumber ? item.origin === 'after-action' ? '선조치 후보고' : 'BNOC 배정' : '—'}</td>
      <td><span className={`badge status-${statusClass}`}>{workStatusLabel(item.status)}</span></td>
      <td>{planned ? '—' : priorityLabel(item.priority)}</td>
      <td>{planned ? `${dateLabel(item.firstWorkDate)}${item.completedDate ? ` · 완료 ${dateLabel(item.completedDate)}` : ''}` : scheduleText(item)}</td>
      <td>{planned ? '—' : item.requesterContact || '—'}</td>
    </tr>;
  };

  const selectDepartment = (teamId: string) => { const next={...applied,teamId};setCriteria(next);setApplied(next);setBucket('assigned');setPage(0); };
  return <div className="work-overview-page"><div className="page-head"><h1>부서별 작업 현황</h1><Button onClick={result.reload}>새로고침</Button></div>
    {actor?.role==='admin'&&run&&<DepartmentContactEditor api={api} run={run}/>}
    <form onSubmit={search} className="overview-filters"><div className="overview-filter-bar">
      <label className="field"><span>부서</span><select aria-label="부서" value={criteria.teamId} onChange={e => set('teamId', e.target.value)}><option value="">전체</option>{teams.map(team => <option key={team}>{team}</option>)}</select></label>
      <label className="field"><span>작업 상태</span><select aria-label="작업 상태" value={criteria.status} onChange={e => set('status',e.target.value)}><option value="">전체</option>{['배정','작업 중','진행 중','완료','반환'].map(value => <option key={value} value={value}>{workStatusLabel(value)}</option>)}</select></label>
      <Button type="submit" variant="primary">검색</Button><Button onClick={() => { const empty=initial();setCriteria(empty);setApplied(empty);openBucket('assigned'); }}>초기화</Button>
      <Button aria-expanded={advanced} aria-controls="overview-extra-filters" onClick={()=>setAdvanced(value=>!value)}>상세 조회 조건</Button>
    </div>{advanced&&<div id="overview-extra-filters" className="filter-grid">
      <label className="field"><span>지원 유형</span><select value={criteria.category} onChange={e => set('category',e.target.value)}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
      <label className="field"><span>체계 종류</span><select value={criteria.systemType} onChange={e => set('systemType',e.target.value)}><option value="">전체</option>{['인트라넷','인터넷','AFCCS','KJCCS','기타'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>작업 유형</span><select value={criteria.workType} onChange={e => set('workType',e.target.value)}><option value="">전체</option>{['신설','고장','지원','대여','점검','이전','기타'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>일반·긴급</span><select value={criteria.priority} onChange={e => set('priority',e.target.value)}><option value="">전체</option><option value="general">일반</option><option value="urgent">긴급</option><option value="unclassified">미분류</option></select></label>
    </div>}</form>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} draftChanged={JSON.stringify(criteria) !== JSON.stringify(applied)} />
    {view && <>
      <section className="work-overview-summary" aria-label="전체 작업 현황">
        <div className="overview-totals"><span className="overview-total-open"><span>남음</span><strong>{allRemaining}<small>건</small></strong></span><span><span>전체</span><strong>{allTotal}<small>건</small></strong></span><span><span>완료</span><strong>{allCompleted}<small>건</small></strong></span><span className="overview-total-unassigned"><span>미배정 요청</span><strong>{count('unassigned')}<small>건</small></strong></span></div>
        <ProgressTrack label="전체 작업 완료율" completed={allCompleted} remaining={allRemaining} total={allTotal} />
      </section>
      {requestOnlyFilters&&<p className="notice">상세 요청 조건이 적용되어 계획 정비는 이 조회에서 제외됩니다.</p>}
      <section className="department-comparison-section" aria-labelledby="department-overview-title"><h2 id="department-overview-title">부서별 진행 상황</h2>
        {displayedDepartments.length?<div className="table-wrap"><table className="department-comparison"><thead><tr><th scope="col" rowSpan={2}>부서</th><th scope="col" rowSpan={2}>미완료</th><th scope="colgroup" colSpan={2}>배정 작업</th><th scope="colgroup" colSpan={2}>계획 정비</th><th scope="col" rowSpan={2}>전체</th><th scope="col" rowSpan={2}>포함 내역</th></tr><tr><th scope="col">남음</th><th scope="col">완료</th><th scope="col">진행</th><th scope="col">완료</th></tr></thead><tbody>{[...displayedDepartments].sort((a,b)=>(b.allRemaining??((b.remaining??0)+(b.plannedInProgress??0)))-(a.allRemaining??((a.remaining??0)+(a.plannedInProgress??0)))).map(row=>{
          const assigned=row.assigned??0,completed=row.completed??0,remaining=row.remaining??0;
          const plannedDone=row.plannedCompleted??0,plannedLeft=row.plannedInProgress??0,planned=row.planned??(plannedDone+plannedLeft);
          const total=row.all??(assigned+planned),open=row.allRemaining??(remaining+plannedLeft);
          return <tr className="department-overview" key={row.department} aria-label={`${row.department} 작업 현황`}>
            <th scope="row"><Button className="link" aria-label={row.department} onClick={()=>selectDepartment(row.department)}>{row.department}</Button></th>
            <td className="department-open"><strong>{open}</strong></td><td>{remaining}</td>
            <td>{completed}<ProgressTrack label={`${row.department} 배정 작업 완료율`} completed={completed} remaining={remaining} total={assigned}/></td>
            <td>{plannedLeft}</td><td>{plannedDone}<ProgressTrack label={`${row.department} 계획 정비 완료율`} completed={plannedDone} remaining={plannedLeft} total={planned} planned/></td>
            <td>{total}</td><td className="department-subsets">{row.afterAction? <span>후보고 {row.afterAction}건 포함</span>:null}{row.returned?<span className="exception">반환 {row.returned}건 포함</span>:null}{!row.afterAction&&!row.returned?'—':null}</td>
          </tr>;
        })}</tbody></table></div>:<p className="empty">표시할 부서별 집계가 없습니다.</p>}
        <details className="overview-definitions"><summary>집계 기준</summary><p>전체 작업은 배정 작업과 계획 정비의 합계입니다. 선조치 후보고·반환은 배정 작업에 포함되며 중복 합산하지 않습니다. 미배정은 요청 단위입니다.</p></details>
      </section>
      <section className="section-gap overview-detail-section" aria-labelledby="shared-work-list-title"><div className="row-head overview-list-head"><div><h2 id="shared-work-list-title">{bucketLabels[displayed.bucket]} 목록</h2><span className="overview-list-count">{displayed.bucket === 'unassigned' ? '요청' : '작업'} {view.total}건</span></div><label className="field"><span>목록 종류</span><select value={bucket} onChange={event=>openBucket(event.target.value)}>{Object.entries(bucketLabels).map(([key,label])=><option key={key} value={key}>{label} · {count(key)}건</option>)}</select></label></div>
        {view.items.length ? <div className="table-wrap"><table className="shared-work-detail"><thead><tr><th>번호</th><th>부서</th><th>지원·작업 유형</th><th>출처</th><th>상태</th><th>일반·긴급</th><th>작업 일정</th><th>요청자 군내전화</th></tr></thead><tbody>{view.items.map(renderRow)}</tbody></table></div> : <p className="empty">조건에 맞는 항목이 없습니다.</p>}
        <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{displayed.page + 1}페이지{displayed.page !== page ? ` · 조회 선택 ${page + 1}페이지` : ''}</span><button disabled={(page + 1) * 20 >= view.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>
      </section>
    </>}
  </div>;
}
