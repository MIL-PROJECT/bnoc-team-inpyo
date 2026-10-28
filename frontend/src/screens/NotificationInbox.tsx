import { useEffect, useRef, useState } from 'react';
import type { Actor, Notification } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { displayDate } from '../app/dateTime.mjs';
import { useResource } from '../app/useResource';
import { ResourceStatus } from './ResourceStatus';
import type { RunCommand } from './RequestRegistrationForm';
export function NotificationInbox({ actor, query, run, revision = 0, onOpen }: { actor: Actor; query: ApiClient; run:RunCommand; revision?: number; onOpen: (id:string) => void }) {
  const [page,setPage] = useState(0);
  const [markError,setMarkError]=useState('');
  const [retryKey,setRetryKey]=useState(0);
  const submitted=useRef(new Set<string>());
  const result = useResource<{ items: Notification[]; total: number }>(signal => query.getNotifications(signal,{ page,size:20 }), [actor.id, query, revision, page]);
  const items = result.data?.items ?? [];
  const unreadIds=items.filter(item=>!item.read && item.notificationId).map(item=>item.notificationId);
  useEffect(()=>{
    if(!result.data || document.visibilityState!=='visible')return;
    const ids=items.filter(item=>!item.read && item.notificationId && !submitted.current.has(item.notificationId)).map(item=>item.notificationId);
    if(!ids.length)return;
    ids.forEach(id=>submitted.current.add(id));
    void run('markNotificationsSeen',{notificationIds:ids},undefined,undefined,crypto.randomUUID()).then(response=>{
      if(!response.ok)setMarkError(response.message ?? '알림 확인 상태를 저장하지 못했습니다.');
      else setMarkError('');
    });
  },[items,result.data,run,retryKey]);
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === 'visible') result.reload(); },30000); const refresh = () => { if (document.visibilityState === 'visible') result.reload(); }; document.addEventListener('visibilitychange',refresh); return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange',refresh); }; }, [result.reload]);
  return <><div className="page-head"><h1>알림함</h1><button onClick={result.reload}>새로고침</button></div><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />{result.error && result.data && <p className="muted">마지막 성공 조회 결과를 표시합니다.</p>}{markError && <p className="error" role="alert">{markError}<button type="button" onClick={()=>{unreadIds.forEach(id=>submitted.current.delete(id));setRetryKey(value=>value+1);}}>알림 확인 다시 시도</button></p>}{items.length ? <div className="card notification-list">{items.map(item => <article className={`notification${item.read?' read':''}`} key={item.notificationId}><strong>{item.event}</strong>{!item.read&&<span className="exception">새 알림</span>}<span>{displayDate(item.at)}</span>{item.relatedRequestId && <button className="link" onClick={() => onOpen(item.relatedRequestId!)}>{item.relatedRequestId}</button>}</article>)}</div> : !result.loading && !result.error && <p className="empty">알림이 없습니다.</p>}{result.data && <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 알림</button><span>{page + 1}페이지 · {result.data.total}건</span><button disabled={(page + 1) * 20 >= result.data.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 알림</button></div>}</>;
}
