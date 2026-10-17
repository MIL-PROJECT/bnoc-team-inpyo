import { useState } from 'react';
import type { Actor, HistoryView } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { ResourceStatus } from './ResourceStatus';
import { displayTime } from '../app/dateTime.mjs';
export function HistoryPanel({ actor, requestId, query, revision = 0 }: { actor: Actor; requestId: string; query: ApiClient; revision?: number }) {
  const [page,setPage] = useState(0);
  const result = useResource<{ items: HistoryView[]; total: number }>(signal => query.getHistory(requestId, signal, { page,size:20 }), [actor.id, requestId, query, revision, page]);
  const rows = result.data?.items ?? [];
  return <section className="history"><h2>처리 이력</h2><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />{rows.length ? <ol>{rows.map((row,index) => <li key={index}><strong>{row.summary}</strong><small>{displayTime(row.at)} · {row.actorLabel}</small></li>)}</ol> : !result.loading && !result.error && <p className="empty">처리 이력이 없습니다.</p>}{result.data && result.data.total > 20 && <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 이력</button><span>{page + 1}페이지</span><button disabled={(page + 1) * 20 >= result.data.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 이력</button></div>}</section>;
}
