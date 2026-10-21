import { useState, type FormEvent } from 'react';
import type { Actor, RequestSummary, RequestStatus } from '../types';
import { priorityLabel } from '../types';
import { useResource } from '../app/useResource';
import { ResourceStatus } from './ResourceStatus';
import { describeConditions, QueryContext } from './QueryContext';
import { DateInput } from '../ui/DateInput';
const emptyCriteria = () => ({ requestNumber: '', status: '', category: '', teamId: '', location: '', requesterDeptOrName: '', from: '', to: '' });
export function RequestListAndSearch({ actor, query, teams, revision = 0, onOpen, onNew }: {
  actor: Actor; query: any; teams: string[]; revision?: number; onOpen: (id: string) => void; onNew: () => void
}) {
  const [criteria, setCriteria] = useState(emptyCriteria);
  const [applied, setApplied] = useState(emptyCriteria);
  const [page, setPage] = useState(0);
  const set = (key: string, value: string) => setCriteria(previous => ({ ...previous, [key]: value }));
  const context = { page, conditions: describeConditions([
    ['요청 번호', applied.requestNumber], ['상태', applied.status], ['요청 유형', applied.category],
    ['작업반', applied.teamId], ['위치', applied.location],
    ['요청자 소속·이름', actor.role === 'bnoc' ? applied.requesterDeptOrName : undefined],
    ['시작일', applied.from], ['종료일', applied.to]
  ]) + ` · ${page + 1}페이지` };
  const result = useResource<{ items: RequestSummary[]; total: number }, typeof context>(signal => query.getRequestList({
    requestNumber: applied.requestNumber, status: applied.status ? [applied.status as RequestStatus] : undefined,
    category: applied.category, teamId: applied.teamId, location: applied.location,
    requesterDeptOrName: actor.role === 'bnoc' ? applied.requesterDeptOrName : undefined,
    period: { from: applied.from, to: applied.to }, page, size: 20
  }, signal), [actor.id, applied, query, revision, page], context);
  const list = result.data?.items ?? [];
  const ownRequests = actor.role === 'requester';
  const progressText = (item: RequestSummary) => {
    const progress=item.progress;
    const departments=progress?.departments.map(entry=>`${entry.department} ${entry.status}`).join(' · ') ?? '';
    const overall=!progress ? '진행 정보 없음' : progress.currentDepartments
      ? `${progress.completedDepartments}/${progress.currentDepartments}개 부서 완료${departments ? ` · ${departments}` : ''}`
      : progress.hadAssignment ? '현재 담당 부서 없음' : '미배정';
    if (actor.role !== 'team') return overall;
    const ownStatus=item.participation==='current' ? `우리 반: ${item.myTeamWorkStatus ?? '상태 확인'}`
      : item.participation==='past' ? '우리 반: 현재 담당 아님 · 과거 참여' : '우리 반: 관련 작업 없음';
    return `${ownStatus} · ${overall}`;
  };
  const displayedPage = result.success?.context?.page ?? page;
  const search = (event: FormEvent) => { event.preventDefault(); setApplied({ ...criteria }); setPage(0); };
  const reset = () => { const empty = emptyCriteria(); setCriteria(empty); setApplied(empty); setPage(0); };
  return <><div className="page-head"><div><small>{actor.role === 'requester' ? '내 신청' : actor.role === 'bnoc' ? '전체 신청' : '관련 신청'}</small><h1>신청 목록</h1></div>{['requester','bnoc'].includes(actor.role) && <button className="primary" onClick={onNew}>새 작업 신청</button>}</div>
    <form onSubmit={search}><div className="filter-primary">
      <label className="field"><span>요청 번호</span><input value={criteria.requestNumber} onChange={e => set('requestNumber',e.target.value)} /></label>
      <label className="field"><span>상태</span><select value={criteria.status} onChange={e => set('status',e.target.value)}><option value="">전체</option>{['대기','문서 대기','배정','작업 중','완료','취소'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>작업반</span><select value={criteria.teamId} onChange={e => set('teamId',e.target.value)}><option value="">전체</option>{teams.map(value => <option key={value}>{value}</option>)}</select></label>
    </div><details className="filter-details"><summary>상세 조회 조건</summary><div className="filter-grid">
      <label className="field"><span>요청 유형</span><select value={criteria.category} onChange={e => set('category',e.target.value)}><option value="">전체</option><option>장비/체계</option><option>회의 지원</option></select></label>
      <label className="field"><span>위치</span><input value={criteria.location} onChange={e => set('location',e.target.value)} /></label>
      {actor.role === 'bnoc' && <label className="field"><span>요청자 소속·이름</span><input value={criteria.requesterDeptOrName} onChange={e => set('requesterDeptOrName',e.target.value)} /></label>}
      <label className="field"><span>시작일</span><DateInput value={criteria.from} onChange={e => set('from',e.target.value)} /></label>
      <label className="field"><span>종료일</span><DateInput value={criteria.to} onChange={e => set('to',e.target.value)} /></label>
    </div></details><div className="actions"><button className="primary" type="submit">검색</button><button type="button" onClick={reset}>초기화</button></div></form>
    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    <QueryContext success={result.success} loading={result.loading} error={result.error} draftChanged={JSON.stringify(criteria) !== JSON.stringify(applied)} />
    {result.data && <p>요청 {result.data.total}건</p>}
    {list.length ? <div className="table-wrap"><table><thead><tr><th>신청</th>{!ownRequests && <th>요청자</th>}<th>유형</th><th>상태</th><th>일반·긴급</th><th>작업 진행</th></tr></thead><tbody>{list.map(item => <tr key={item.requestNumber}><td><button className="link" onClick={() => onOpen(item.requestNumber)}>{item.requestNumber}</button></td>{!ownRequests && <td>{item.requesterDisplayText}</td>}<td>{item.category}</td><td><span className={`badge status-${item.status.replace(' ','-')}`}>{item.status}</span></td><td>{priorityLabel(item.priority)}</td><td>{progressText(item)}</td></tr>)}</tbody></table></div> : result.data && <p className="empty">조건에 맞는 신청이 없습니다.</p>}
    {result.data && <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{displayedPage + 1}페이지{displayedPage !== page ? ` · 조회 선택 ${page + 1}페이지` : ''}</span><button disabled={(page + 1) * 20 >= result.data.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>}
  </>;
}
