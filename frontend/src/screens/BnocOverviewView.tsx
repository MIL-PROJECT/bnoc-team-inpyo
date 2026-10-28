import { useState } from 'react';
import type { RequestStatus, RequestSummary, WorkOverview } from '../types';
import { workStatusLabel } from '../types';
import { useResource } from '../app/useResource';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';
import { DateInput } from '../ui/DateInput';
import { StatusBadge } from '../ui/WorkflowStatus';
export function BnocOverviewView({ query, teams, revision = 0, onOpen, initialMessage = '' }: { query: any; teams: string[]; revision?: number; onOpen: (id:string) => void; initialMessage?: string }) {
  const [status, setStatus] = useState(''), [teamId, setTeamId] = useState(''), [category, setCategory] = useState('');
  const [unassignedPage, setUnassignedPage] = useState(0);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const context = { conditions: describeConditions([['상태', status], ['작업반', teamId], ['요청 유형', category], ['시작일', from], ['종료일', to]]) };
  const result = useResource<{ total: number; byStatus: Record<string,number>; list: RequestSummary[] }, typeof context>(signal => query.getBnocOverview({
    status: status ? [status as RequestStatus] : undefined, teamId, category, period: { from, to }
  }, signal), [query, status, teamId, category, from, to, revision], context);
  const unassignedContext = { category, page: unassignedPage };
  const unassigned = useResource<WorkOverview, typeof unassignedContext>(signal => query.getWorkOverview({ bucket: 'unassigned', category, page: unassignedPage, size: 20 }, signal), [query, category, unassignedPage, revision], unassignedContext);
  const unassignedMatches = unassigned.success?.context?.category === category && unassigned.success?.context?.page === unassignedPage;
  const unassignedData = unassignedMatches ? unassigned.data : null;
  const overview = result.data;
  return <div className="bnoc-overview"><div className="page-head"><h1>요청 현황(BNOC)</h1><button onClick={()=>{result.reload();unassigned.reload();}}>새로고침</button></div>{initialMessage && <p role="status" className="notice">{initialMessage}</p>}<div className="filter-primary overview-query">
    <label className="field"><span>상태</span><select value={status} onChange={e => setStatus(e.target.value)}><option value="">전체</option>{['대기','문서 대기','배정','작업 중','완료','취소','기각'].map(value => <option key={value}>{value}</option>)}</select></label>
    <label className="field"><span>작업반</span><select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">전체</option>{teams.map(value => <option key={value}>{value}</option>)}</select></label>
  </div><details className="filter-details"><summary>상세 조회 조건</summary><div className="filter-grid">
    <label className="field"><span>요청 유형</span><select value={category} onChange={e => { setCategory(e.target.value); setUnassignedPage(0); }}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
    <label className="field"><span>시작일</span><DateInput value={from} onChange={e => setFrom(e.target.value)} /></label>
    <label className="field"><span>종료일</span><DateInput value={to} onChange={e => setTo(e.target.value)} /></label>
  </div></details><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
  <QueryContext success={result.success} loading={result.loading} error={result.error} />
  {overview && <><div className="metric-row request-metrics"><div><strong>{overview.total}건</strong><span>전체 요청</span></div>{Object.entries(overview.byStatus).map(([key,value]) => <div key={key}><strong>{value}건</strong><span>{key} 요청</span></div>)}</div>
  <div className="bnoc-queues"><section className="section-gap"><h2>요청 목록</h2>{overview.list.length ? overview.list.map(item => <div className="queue-row" key={item.requestNumber}><button className="queue-row__open" onClick={() => onOpen(item.requestNumber)}>{item.requestNumber} · {item.requesterDisplayText}</button><StatusBadge status={item.status} afterAction={item.afterAction} departments={item.teamIds} /></div>) : <p className="empty">조건에 맞는 요청이 없습니다.</p>}</section>
  <section className="section-gap" aria-label="미배정 요청"><div className="row-head"><h2>미배정 요청</h2><span>{unassignedData ? `${unassignedData.total}건` : '—'}</span></div><ResourceStatus loading={unassigned.loading} error={unassigned.error} retry={unassigned.reload} />{unassigned.error && unassignedData && <p className="muted">마지막으로 조회한 미배정 요청을 표시합니다.</p>}{unassignedData?.items.length ? unassignedData.items.map(item => item.requestNumber ? <button className="queue-row" key={item.requestNumber} onClick={() => onOpen(item.requestNumber!)}><span>{item.requestNumber} · {item.category}</span><span className={`badge status-${item.status.replace(' ','-')}`}>{workStatusLabel(item.status)}</span></button> : null) : unassignedData && !unassigned.loading && !unassigned.error && <p className="empty">조건에 맞는 미배정 요청이 없습니다.</p>}{unassignedData && <div className="actions pagination"><button disabled={unassignedPage === 0 || unassigned.loading} onClick={() => setUnassignedPage(value => value - 1)}>이전 페이지</button><span>{unassignedPage + 1}페이지</span><button disabled={(unassignedPage + 1) * (unassignedData.size ?? 20) >= unassignedData.total || unassigned.loading} onClick={() => setUnassignedPage(value => value + 1)}>다음 페이지</button></div>}</section></div></>}</div>;
}
