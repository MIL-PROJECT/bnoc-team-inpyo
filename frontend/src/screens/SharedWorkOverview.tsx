import { useState, type FormEvent } from 'react';
import type { SharedWork, WorkOverview } from '../types';
import { priorityLabel, workStatusLabel } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { displayTime, seoulDate } from '../app/dateTime.mjs';
import { displayInterval } from '../app/scheduleIntervals.mjs';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';

const initial = () => ({ teamId: '', category: '', workType: '', systemType: '', status: '', priority: '' });
const bucketLabels: Record<string, string> = { assigned:'할당 작업', completed:'완료 작업', remaining:'남은 작업', returned:'반환 대기 작업', unassigned:'미배정 요청', 'after-action':'선조치 후보고', planned:'계획 정비', all:'전체 작업' };
const dateLabel = (value?: string) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${value}T00:00:00Z`)) : '—';

export function SharedWorkOverview({ api, teams, revision, onOpen }: { api: ApiClient; teams: string[]; revision: number; onOpen: (number: string) => void }) {
  const [criteria, setCriteria] = useState(initial), [applied, setApplied] = useState(initial), [bucket, setBucket] = useState('assigned'), [page, setPage] = useState(0);
  const context = { bucket, page, conditions: describeConditions([
    ['부서', applied.teamId], ['지원 유형', applied.category], ['체계 종류', applied.systemType], ['작업 유형', applied.workType],
    ['작업 상태', applied.status], ['일반·긴급', applied.priority ? priorityLabel(applied.priority) : '']
  ]) + ` · ${bucketLabels[bucket]} · ${page + 1}페이지` };
  const result = useResource<WorkOverview, typeof context>(signal => api.getWorkOverview({ ...applied, bucket, page, size: 20 }, signal), [api, applied, bucket, page, revision], context);
  const view = result.data;
  const count = (key: string) => view?.counts[key] ?? (key === 'unassigned' ? typeof view?.unassignedRequests === 'number' ? view.unassignedRequests : view?.unassignedRequests?.length : key === 'after-action' ? typeof view?.afterActionCompleted === 'number' ? view.afterActionCompleted : view?.afterActionCompleted?.length : 0) ?? 0;
  const scheduleText = (item: WorkOverview['items'][number]) => item.scheduleIntervals?.length
    ? item.scheduleIntervals.map(interval => `${seoulDate(interval.startsAt)} ${displayInterval(interval)}`).join(' · ')
    : displayTime(item.schedule ?? item.scheduledAt);
  const requestOnlyFilters = Boolean(applied.category || applied.workType || applied.systemType || applied.priority);
  const displayed = result.success?.context ?? context;
  const search = (event: FormEvent) => { event.preventDefault(); setApplied({ ...criteria }); setPage(0); };
  const set = (field: keyof ReturnType<typeof initial>, value: string) => setCriteria(previous => ({ ...previous, [field]: value }));
  const openBucket = (value: string) => { setBucket(value); setPage(0); };
  const renderRow = (item: SharedWork) => {
    const planned = item.source === 'planned';
    const number = item.workNumber ?? item.requestNumber;
    const statusClass = item.status.replace(' ', '-');
    return <tr key={planned ? `planned-${item.plannedWorkId ?? item.id}` : `${item.source ?? 'assigned'}-${number}`}>
      <td>{planned ? <span>계획 정비</span> : item.canOpenDetail && number ? <button className="link" onClick={() => onOpen(number)}>{number}</button> : <span>{number}<small>상세 조회 제한</small></span>}</td>
      <td>{item.teamId ?? item.department ?? '미배정'}</td>
      <td>{planned ? item.title : `${item.category ?? '—'}${item.workType ? ' · ' + item.workType : ''}`}</td>
      <td>{planned ? '계획 정비' : item.workNumber ? item.origin === 'after-action' ? '선조치 후보고' : 'BNOC 배정' : '—'}</td>
      <td><span className={`badge status-${statusClass}`}>{workStatusLabel(item.status)}</span></td>
      <td>{planned ? '—' : priorityLabel(item.priority)}</td>
      <td>{planned ? `${dateLabel(item.firstWorkDate)}${item.completedDate ? ` · 완료 ${dateLabel(item.completedDate)}` : ''}` : scheduleText(item)}</td>
      <td>{planned ? '—' : item.requesterContact || '—'}</td>
    </tr>;
  };

  return <><div className="page-head"><div><small>전체 부서의 작업</small><h1>부서별 작업 현황</h1></div><button onClick={result.reload}>새로고침</button></div>
    <p className="muted">현재 상태 기준입니다. 선조치 후보고는 할당·완료에 포함되며, 출처별 수는 참고용 부분집합입니다. 전체 작업은 할당 작업과 계획 정비의 합계입니다.</p>
    <form onSubmit={search}><div className="filter-primary"><label className="field"><span>부서</span><select value={criteria.teamId} onChange={e => set('teamId', e.target.value)}><option value="">전체</option>{teams.map(team => <option key={team}>{team}</option>)}</select></label>
      <label className="field"><span>작업 상태</span><select value={criteria.status} onChange={e => set('status',e.target.value)}><option value="">전체</option>{['배정','작업 중','진행 중','완료','반환'].map(value => <option key={value} value={value}>{workStatusLabel(value)}</option>)}</select></label>
    </div><details className="filter-details"><summary>상세 조회 조건</summary><div className="filter-grid">
      <label className="field"><span>지원 유형</span><select value={criteria.category} onChange={e => set('category',e.target.value)}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
      <label className="field"><span>체계 종류</span><select value={criteria.systemType} onChange={e => set('systemType', e.target.value)}><option value="">전체</option>{['인트라넷','인터넷','AFCCS','KJCCS','기타'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>작업 유형</span><select value={criteria.workType} onChange={e => set('workType',e.target.value)}><option value="">전체</option>{['신설','고장','지원','대여','점검','이전','기타'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>일반·긴급</span><select value={criteria.priority} onChange={e => set('priority',e.target.value)}><option value="">전체</option><option value="general">일반</option><option value="urgent">긴급</option><option value="unclassified">미분류</option></select></label></div></details><div className="actions"><button type="submit" className="primary">검색</button><button type="button" onClick={() => { const empty = initial(); setCriteria(empty); setApplied(empty); openBucket('assigned'); }}>초기화</button></div></form>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} draftChanged={JSON.stringify(criteria) !== JSON.stringify(applied)} />
    {view && <>
      {view.queriedAt && <p className="muted">집계 기준 시각: {displayTime(view.queriedAt)}</p>}
      {requestOnlyFilters && <p className="notice">상세 요청 조건이 적용되어 계획 정비는 이 조회에서 제외됩니다.</p>}
      <section className="planned-overview-demo" aria-labelledby="planned-overview-title">
        <div className="row-head"><h2 id="planned-overview-title">전체 작업 집계</h2></div>
        <div className="planned-overview-metrics">
          <div><small>계획 진행 중</small><strong>{view.counts.plannedInProgress ?? 0}건</strong></div>
          <div><small>계획 완료</small><strong>{view.counts.plannedCompleted ?? 0}건</strong></div>
          <div><small>전체 작업</small><strong>{view.counts.all ?? 0}건</strong></div>
          <div><small>전체 완료</small><strong>{view.counts.allCompleted ?? 0}건</strong></div>
          <div><small>전체 남은 작업</small><strong>{view.counts.allRemaining ?? 0}건</strong></div>
        </div>
      </section>
      <div className="metric-row metric-buttons">{Object.entries(bucketLabels).map(([key,label]) => <button key={key} aria-pressed={bucket === key} onClick={() => openBucket(key)}><strong>{count(key)}건</strong><span>{label}</span></button>)}</div>
      <section className="section-gap"><div className="row-head"><h2>{bucketLabels[displayed.bucket]} 목록</h2><span>{displayed.bucket === 'unassigned' ? '요청' : '작업'} {view.total}건</span></div>
        {view.items.length ? <div className="table-wrap"><table><thead><tr><th>번호</th><th>부서</th><th>지원·작업 유형</th><th>출처</th><th>상태</th><th>일반·긴급</th><th>작업 일정</th><th>요청자 군내전화</th></tr></thead><tbody>{view.items.map(renderRow)}</tbody></table></div> : <p className="empty">조건에 맞는 항목이 없습니다.</p>}
        <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{displayed.page + 1}페이지{displayed.page !== page ? ` · 조회 선택 ${page + 1}페이지` : ''}</span><button disabled={(page + 1) * 20 >= view.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>
      </section>
      <details className="details-panel section-gap"><summary>부서별 작업 집계 <span className="count">{view.byDepartment.length}개 부서</span></summary><div className="table-wrap"><table><thead><tr><th>부서</th><th>할당 작업</th><th>선조치 후보고 (포함)</th><th>계획 진행 중</th><th>계획 완료</th><th>전체 작업</th></tr></thead><tbody>{view.byDepartment.map(row => <tr key={row.department}><td>{row.department}</td><td>{row.assigned}</td><td>{row.afterAction ?? 0}</td><td>{row.plannedInProgress ?? 0}</td><td>{row.plannedCompleted ?? 0}</td><td>{row.all ?? (row.assigned + (row.planned ?? 0))}</td></tr>)}</tbody></table></div></details>
    </>}
  </>;
}
