import { useState, type FormEvent } from 'react';
import type { WorkOverview } from '../types';
import { priorityLabel } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { displayTime } from '../app/dateTime.mjs';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';
import type { PlannedWorkDemoItem } from './PlannedMaintenanceView';
const initial = () => ({ teamId: '', category: '', workType: '', systemType: '', status: '', priority: '' });
const bucketLabels: Record<string, string> = { assigned:'할당 작업', completed:'완료 작업', remaining:'남은 작업', returned:'반환 대기 작업', unassigned:'미배정 요청', 'after-action':'선조치 후보고 완료 작업' };
export function SharedWorkOverview({ api, teams, revision, onOpen, plannedDemoItems }: { api: ApiClient; teams: string[]; revision: number; onOpen: (number: string) => void; plannedDemoItems?: PlannedWorkDemoItem[] }) {
  const [criteria, setCriteria] = useState(initial), [applied, setApplied] = useState(initial), [bucket, setBucket] = useState('assigned'), [page, setPage] = useState(0);
  const [demoSource, setDemoSource] = useState<'all' | 'assigned' | 'after-action' | 'planned'>('all'), [demoPage, setDemoPage] = useState(0);
  const context = { bucket, page, conditions: describeConditions([
    ['부서', applied.teamId], ['지원 유형', applied.category], ['체계 종류', applied.systemType], ['작업 유형', applied.workType],
    ['작업 상태', applied.status], ['일반·긴급', applied.priority ? priorityLabel(applied.priority) : '']
  ]) + ` · ${bucketLabels[bucket]} · ${page + 1}페이지` };
  const result = useResource<WorkOverview, typeof context>(signal => api.getWorkOverview({ ...applied, bucket, page, size: 20 }, signal), [api, applied, bucket, page, revision], context);
  const view = result.data;
  const count = (key: string) => view?.counts[key] ?? (key === 'unassigned' ? typeof view?.unassignedRequests === 'number' ? view.unassignedRequests : view?.unassignedRequests?.length : key === 'after-action' ? typeof view?.afterActionCompleted === 'number' ? view.afterActionCompleted : view?.afterActionCompleted?.length : 0) ?? 0;
  const demoContext = { conditions: describeConditions([['부서', applied.teamId], ['지원 유형', applied.category], ['체계 종류', applied.systemType], ['작업 유형', applied.workType], ['작업 상태', applied.status], ['일반·긴급', applied.priority ? priorityLabel(applied.priority) : '']]) };
  const demoSnapshot = useResource<{ assigned: WorkOverview; afterAction: WorkOverview; afterActionByDepartment: { department: string; total: number }[] } | null, typeof demoContext>(signal => {
    if (plannedDemoItems === undefined) return Promise.resolve(null);
    const teamsToCount = applied.teamId ? [applied.teamId] : teams;
    const fetchRange = async (source: 'assigned' | 'after-action', total: number, start: number, length: number) => {
      if (length <= 0 || start >= total) return [];
      const firstPage = Math.floor(start / 20), lastPage = Math.floor((start + length - 1) / 20);
      const pages = await Promise.all(Array.from({ length: lastPage - firstPage + 1 }, (_, offset) => api.getWorkOverview({ ...applied, bucket: source, page: firstPage + offset, size: 20 }, signal)));
      const items = pages.flatMap(result => result.items);
      return items.slice(start - firstPage * 20, start - firstPage * 20 + length);
    };
    return Promise.all([
      api.getWorkOverview({ ...applied, bucket: 'assigned', page: 0, size: 1 }, signal),
      api.getWorkOverview({ ...applied, bucket: 'after-action', page: 0, size: 1 }, signal),
      Promise.all(teamsToCount.map(async department => ({ department, total: (await api.getWorkOverview({ ...applied, teamId: department, bucket: 'after-action', page: 0, size: 1 }, signal)).total })))
    ]).then(async ([assignedSummary, afterActionSummary, afterActionByDepartment]) => {
      const pageStart = demoPage * 20, pageEnd = pageStart + 20;
      let assignedStart = 0, assignedLength = 0, afterActionStart = 0, afterActionLength = 0;
      if (demoSource === 'all') {
        assignedStart = Math.min(pageStart, assignedSummary.total);
        assignedLength = Math.max(0, Math.min(pageEnd, assignedSummary.total) - pageStart);
        const afterActionOffset = assignedSummary.total;
        afterActionStart = Math.max(0, pageStart - afterActionOffset);
        afterActionLength = Math.max(0, Math.min(pageEnd, afterActionOffset + afterActionSummary.total) - Math.max(pageStart, afterActionOffset));
      } else if (demoSource === 'assigned') {
        assignedStart = pageStart;
        assignedLength = Math.max(0, Math.min(20, assignedSummary.total - pageStart));
      } else if (demoSource === 'after-action') {
        afterActionStart = pageStart;
        afterActionLength = Math.max(0, Math.min(20, afterActionSummary.total - pageStart));
      }
      const [assignedItems, afterActionItems] = await Promise.all([
        fetchRange('assigned', assignedSummary.total, assignedStart, assignedLength),
        fetchRange('after-action', afterActionSummary.total, afterActionStart, afterActionLength)
      ]);
      return {
        assigned: { ...assignedSummary, items: assignedItems },
        afterAction: { ...afterActionSummary, items: afterActionItems },
        afterActionByDepartment
      };
    });
  }, [api, applied, demoPage, demoSource, revision, Boolean(plannedDemoItems), teams], demoContext);
  const plannedDemoRows = (plannedDemoItems ?? []).filter(item => (!applied.teamId || item.teamId === applied.teamId) && (!applied.status || applied.status === '전체' || applied.status === '완료' && item.status === '완료' || applied.status === '작업 중' && item.status === '진행 중'));
  const unsupportedPlanFilters = Boolean(applied.category || applied.workType || applied.systemType || applied.priority);
  const countedPlanRows = unsupportedPlanFilters ? [] : plannedDemoRows;
  const plannedInProgress = countedPlanRows.filter(item => item.status === '진행 중').length;
  const plannedCompleted = countedPlanRows.filter(item => item.status === '완료').length;
  const demoData = demoSnapshot.data;
  const assignedCount = demoData?.assigned.total ?? count('assigned');
  const afterActionCount = demoData?.afterAction.total ?? count('after-action');
  const totalAcrossSources = assignedCount + afterActionCount + countedPlanRows.length;
  const completedAcrossSources = (demoData?.assigned.counts.completed ?? count('completed')) + afterActionCount + plannedCompleted;
  const remainingAcrossSources = (demoData?.assigned.counts.remaining ?? count('remaining')) + plannedInProgress;
  const demoSourceCount = (source: typeof demoSource) => source === 'planned' ? countedPlanRows.length : source === 'assigned' ? assignedCount : source === 'after-action' ? afterActionCount : totalAcrossSources;
  const demoPageCount = (source: typeof demoSource) => Math.max(1, Math.ceil(demoSourceCount(source) / 20));
  const demoSourceRows = (() => {
    const assigned = demoData?.assigned.items ?? [];
    const afterAction = demoData?.afterAction.items ?? [];
    const pageStart = demoPage * 20;
    const plannedOffset = demoSource === 'all' ? assignedCount + afterActionCount : 0;
    const plannedStart = demoSource === 'all' ? Math.max(0, pageStart - plannedOffset) : pageStart;
    const plannedLength = demoSource === 'all' ? Math.max(0, Math.min(plannedOffset + countedPlanRows.length, pageStart + 20) - Math.max(plannedOffset, pageStart)) : 20;
    const planned = demoSource === 'all' || demoSource === 'planned' ? countedPlanRows.slice(plannedStart, plannedStart + plannedLength) : [];
    const rows = [
      ...(demoSource === 'all' || demoSource === 'assigned' ? assigned.map(item => ({ key: `assigned-${item.workNumber}`, source: '비계획 할당', department: item.teamId ?? item.department ?? '미배정', title: item.workNumber, detail: `${item.category}${item.workType ? ' · ' + item.workType : ''}`, status: item.status, date: displayTime(item.schedule ?? item.scheduledAt) })) : []),
      ...(demoSource === 'all' || demoSource === 'after-action' ? afterAction.map(item => ({ key: `after-action-${item.workNumber}`, source: '선조치 후보고', department: item.teamId ?? item.department ?? '미배정', title: item.workNumber, detail: `${item.category}${item.workType ? ' · ' + item.workType : ''}`, status: item.status, date: displayTime(item.schedule ?? item.scheduledAt) })) : []),
      ...(demoSource === 'all' || demoSource === 'planned' ? planned.map(item => ({ key: `planned-${item.id}`, source: '계획', department: item.department ?? item.teamId ?? '부서', title: item.title, detail: '', status: item.status, date: item.completedDate ? `완료일 ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${item.completedDate}T00:00:00Z`))}` : '' })) : [])
    ];
    return rows;
  })();
  const departmentSummary = (() => {
    const summary = new Map<string, { assigned: number; afterAction: number; plannedInProgress: number; plannedCompleted: number }>();
    const ensure = (department: string) => { if (!summary.has(department)) summary.set(department, { assigned: 0, afterAction: 0, plannedInProgress: 0, plannedCompleted: 0 }); return summary.get(department)!; };
    for (const row of demoData?.assigned.byDepartment ?? view?.byDepartment ?? []) ensure(row.department).assigned = row.assigned;
    for (const row of demoData?.afterActionByDepartment ?? []) ensure(row.department).afterAction = row.total;
    for (const item of countedPlanRows) { const department = item.department ?? item.teamId ?? '부서'; if (item.status === '완료') ensure(department).plannedCompleted++; else ensure(department).plannedInProgress++; }
    return [...summary.entries()].sort(([first], [second]) => first.localeCompare(second, 'ko'));
  })();
  const displayed = result.success?.context ?? context;
  const search = (event: FormEvent) => { event.preventDefault(); setApplied({ ...criteria }); setPage(0); setDemoPage(0); };
  const set = (field: keyof ReturnType<typeof initial>, value: string) => setCriteria({ ...criteria, [field]: value });
  return <><div className="page-head"><div><small>전체 부서의 작업</small><h1>부서별 작업 현황</h1></div><button onClick={result.reload}>새로고침</button></div>
    <p className="muted">현재 상태 기준입니다. 할당 작업은 완료와 남은 작업의 합계이며, 재배정된 이전 작업과 취소 요청은 제외합니다.</p>
    <form onSubmit={search}><div className="filter-primary"><label className="field"><span>부서</span><select value={criteria.teamId} onChange={e => set('teamId', e.target.value)}><option value="">전체</option>{teams.map(team => <option key={team}>{team}</option>)}</select></label>
      <label className="field"><span>작업 상태</span><select value={criteria.status} onChange={e => set('status',e.target.value)}><option value="">전체</option>{['배정','작업 중','완료','반환'].map(value => <option key={value}>{value}</option>)}</select></label>
    </div><details className="filter-details"><summary>상세 조회 조건</summary><div className="filter-grid">
      <label className="field"><span>지원 유형</span><select value={criteria.category} onChange={e => set('category',e.target.value)}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
      <label className="field"><span>체계 종류</span><select value={criteria.systemType} onChange={e => set('systemType', e.target.value)}><option value="">전체</option>{['인트라넷','인터넷','AFCCS','KJCCS','기타'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>작업 유형</span><select value={criteria.workType} onChange={e => set('workType',e.target.value)}><option value="">전체</option>{['신설','고장','지원','대여','점검','이전','기타'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>일반·긴급</span><select value={criteria.priority} onChange={e => set('priority',e.target.value)}><option value="">전체</option><option value="general">일반</option><option value="urgent">긴급</option><option value="unclassified">미분류</option></select></label></div></details><div className="actions"><button type="submit" className="primary">검색</button><button type="button" onClick={() => { const empty = initial(); setCriteria(empty); setApplied(empty); setBucket('assigned'); setPage(0); setDemoSource('all'); setDemoPage(0); }}>초기화</button></div></form>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} draftChanged={JSON.stringify(criteria) !== JSON.stringify(applied)} />
    {view && <>
      {view.queriedAt && <p className="muted">집계 기준 시각: {displayTime(view.queriedAt)}</p>}
      {plannedDemoItems && <section className="planned-overview-demo" aria-labelledby="planned-demo-overview-title">
        <div className="row-head"><h2 id="planned-demo-overview-title">전체 작업 집계</h2></div>
        {unsupportedPlanFilters && <p className="notice">요청 유형·체계·우선순위 필터는 계획 작업에 적용할 수 없어 이번 시안 합계에서 계획 작업을 뺐습니다.</p>}
        {demoSnapshot.error && <p className="notice error">작업 전체 목록을 불러오지 못했습니다. <button type="button" className="link" onClick={demoSnapshot.reload}>다시 조회</button></p>}
        <div className="planned-overview-metrics">
          <div><small>비계획 할당</small><strong>{assignedCount}건</strong></div>
          <div><small>선조치 후보고</small><strong>{afterActionCount}건</strong></div>
          <div><small>계획 진행 중</small><strong>{plannedInProgress}건</strong></div>
          <div><small>계획 완료</small><strong>{plannedCompleted}건</strong></div>
          <div><small>전체 작업</small><strong>{totalAcrossSources}건</strong></div>
          <div><small>전체 완료</small><strong>{completedAcrossSources}건</strong></div>
          <div><small>전체 남은 작업</small><strong>{remainingAcrossSources}건</strong></div>
        </div>
        <div className="planned-overview-tabs" role="group" aria-label="표시할 작업 출처">
          {([['all','전체'],['assigned','비계획 할당'],['after-action','선조치 후보고'],['planned','계획']] as const).map(([source, label]) => <button type="button" key={source} aria-pressed={demoSource === source} onClick={() => { setDemoSource(source); setDemoPage(0); }}>{label} {demoSourceCount(source)}건</button>)}
        </div>
        <div className="table-wrap"><table><thead><tr><th>출처</th><th>부서</th><th>제목·번호</th><th>상태</th><th>일정·완료일</th></tr></thead><tbody>
          {demoSourceRows.length ? demoSourceRows.map(item => <tr key={item.key}><td>{item.source}</td><td>{item.department}</td><td>{item.title}{item.detail && <small>{item.detail}</small>}</td><td>{item.status}</td><td>{item.date}</td></tr>) : <tr><td colSpan={5}>{demoSnapshot.loading ? '불러오는 중…' : '표시할 작업이 없습니다.'}</td></tr>}
        </tbody></table></div>
        <div className="actions pagination"><button type="button" disabled={demoPage === 0 || demoSnapshot.loading} onClick={() => setDemoPage(value => value - 1)}>이전</button><span>{demoPage + 1} / {demoPageCount(demoSource)}페이지</span><button type="button" disabled={demoPage + 1 >= demoPageCount(demoSource) || demoSnapshot.loading} onClick={() => setDemoPage(value => value + 1)}>다음</button></div>
        <details className="details-panel"><summary>부서별 전체 작업 <span className="count">{departmentSummary.length}개 부서</span></summary><div className="table-wrap"><table><thead><tr><th>부서</th><th>비계획 할당</th><th>선조치 후보고</th><th>계획 진행 중</th><th>계획 완료</th><th>전체</th></tr></thead><tbody>
          {departmentSummary.map(([department, values]) => <tr key={department}><td>{department}</td><td>{values.assigned}건</td><td>{values.afterAction}건</td><td>{values.plannedInProgress}건</td><td>{values.plannedCompleted}건</td><td>{values.assigned + values.afterAction + values.plannedInProgress + values.plannedCompleted}건</td></tr>)}
        </tbody></table></div></details>
      </section>}
      <div className="metric-row metric-buttons">{Object.entries(bucketLabels).map(([key,label]) => <button key={key} aria-pressed={bucket === key} onClick={() => { setBucket(key); setPage(0); }}><strong>{count(key)}건</strong><span>{label}</span></button>)}</div>
      <section className="section-gap"><div className="row-head"><h2>{bucketLabels[displayed.bucket]} 목록</h2><span>{displayed.bucket === 'unassigned' ? '요청' : '작업'} {view.total}건</span></div>
        {view.items.length ? <div className="table-wrap"><table><thead><tr><th>번호</th><th>부서</th><th>지원·작업 유형</th><th>상태</th><th>일반·긴급</th><th>작업 일정</th></tr></thead><tbody>{view.items.map(item => <tr key={item.workNumber ?? item.requestNumber}><td>{item.canOpenDetail ? <button className="link" onClick={() => onOpen(item.requestNumber)}>{item.workNumber ?? item.requestNumber}</button> : <span>{item.workNumber ?? item.requestNumber}<small>상세 조회 제한</small></span>}</td><td>{item.teamId ?? item.department ?? '미배정'}</td><td>{item.category}{item.workType ? ' · ' + item.workType : ''}</td><td><span className={`badge status-${item.status.replace(' ','-')}`}>{item.status}</span></td><td>{priorityLabel(item.priority)}</td><td>{displayTime(item.schedule ?? item.scheduledAt)}</td></tr>)}</tbody></table></div> : <p className="empty">조건에 맞는 항목이 없습니다.</p>}
        <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{displayed.page + 1}페이지{displayed.page !== page ? ` · 조회 선택 ${page + 1}페이지` : ''}</span><button disabled={(page + 1) * 20 >= view.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>
      </section>
      <details className="details-panel section-gap"><summary>부서별 작업 집계 <span className="count">{view.byDepartment.length}개 부서</span></summary><div className="table-wrap"><table><thead><tr><th>부서</th><th>할당 작업(건)</th><th>완료 작업(건)</th><th>남은 작업(건)</th><th>반환 대기 작업(건)</th></tr></thead><tbody>{view.byDepartment.map(row => <tr key={row.department}><td>{row.department}</td><td>{row.assigned}</td><td>{row.completed}</td><td>{row.remaining}</td><td>{row.returned}</td></tr>)}</tbody></table></div></details>
    </>}
  </>;
}
