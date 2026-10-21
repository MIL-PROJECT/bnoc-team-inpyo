import { useState } from 'react';
import type { RequestStatus, RequestSummary } from '../types';
import { useResource } from '../app/useResource';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';
import { DateInput } from '../ui/DateInput';
export function BnocOverviewView({ query, teams, revision = 0, onOpen }: { query: any; teams: string[]; revision?: number; onOpen: (id:string) => void }) {
  const [status, setStatus] = useState(''), [teamId, setTeamId] = useState(''), [category, setCategory] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const context = { conditions: describeConditions([['상태', status], ['작업반', teamId], ['요청 유형', category], ['시작일', from], ['종료일', to]]) };
  const result = useResource<{ total: number; byStatus: Record<string,number>; list: RequestSummary[] }, typeof context>(signal => query.getBnocOverview({
    status: status ? [status as RequestStatus] : undefined, teamId, category, period: { from, to }
  }, signal), [query, status, teamId, category, from, to, revision], context);
  const overview = result.data;
  return <><h1>요청 현황(BNOC)</h1><div className="filter-primary">
    <label className="field"><span>상태</span><select value={status} onChange={e => setStatus(e.target.value)}><option value="">전체</option>{['대기','문서 대기','배정','작업 중','완료','취소'].map(value => <option key={value}>{value}</option>)}</select></label>
    <label className="field"><span>작업반</span><select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">전체</option>{teams.map(value => <option key={value}>{value}</option>)}</select></label>
  </div><details className="filter-details"><summary>상세 조회 조건</summary><div className="filter-grid">
    <label className="field"><span>요청 유형</span><select value={category} onChange={e => setCategory(e.target.value)}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
    <label className="field"><span>시작일</span><DateInput value={from} onChange={e => setFrom(e.target.value)} /></label>
    <label className="field"><span>종료일</span><DateInput value={to} onChange={e => setTo(e.target.value)} /></label>
  </div></details><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
  <QueryContext success={result.success} loading={result.loading} error={result.error} />
  {overview && <><div className="metric-row"><div><strong>{overview.total}건</strong><span>전체 요청</span></div>{Object.entries(overview.byStatus).map(([key,value]) => <div key={key}><strong>{value}건</strong><span>{key} 요청</span></div>)}</div>
  <section className="section-gap"><h2>요청 목록</h2>{overview.list.length ? overview.list.map(item => <button className="queue-row" key={item.requestNumber} onClick={() => onOpen(item.requestNumber)}><span>{item.requestNumber} · {item.requesterDisplayText}</span><span className={`badge status-${item.status.replace(' ','-')}`}>{item.status}</span></button>) : <p className="empty">조건에 맞는 요청이 없습니다.</p>}</section></>}</>;
}
