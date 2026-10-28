import { useEffect, useState } from 'react';
import type { Actor } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { displayTime } from '../app/dateTime.mjs';
import { Button } from '../ui/Button';
import './mainFunctionsPreview.css';

type OperationsItem={itemId:string;kind:string;groupId?:string|null;displayName:string;stageCode?:string|null;health?:'normal'|'abnormal'|null;observedAt:string};
type OperationsSnapshot={collectionState:'not_collected'|'ok'|'failed'|'stale';failureCode?:string|null;lastAttempt?:string|null;items:OperationsItem[];groups:{groupId:string;items:OperationsItem[]}[]};
const romanStage=(code?:string|null)=>({'1':'Ⅰ급','2':'Ⅱ급','3':'Ⅲ급','4':'Ⅳ급','5':'Ⅴ급'}[code??'']??'값 없음');

export function MainFunctionsPreview({actor,api}:{actor:Actor;api:ApiClient}) {
  const [operations,setOperations]=useState<OperationsSnapshot|null>(null);const [error,setError]=useState('');const [refresh,setRefresh]=useState(0);const [loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;setLoading(true);void api.getOperationsStatus().then(result=>{if(active){setOperations(result as OperationsSnapshot);setError('');}}).catch(()=>{if(active)setError('정보통신 운용현황을 불러오지 못했습니다.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[actor.id,api,refresh]);
  return <div className="main-preview"><div className="page-head"><h1>정보통신 운용현황</h1><Button onClick={()=>setRefresh(value=>value+1)}>새로고침</Button></div>
    {error&&<p className="error" role="alert">{error}</p>}{loading&&!operations&&<p role="status">불러오는 중…</p>}
    {operations&&operations.collectionState!=='ok'&&<p className={operations.collectionState==='failed'?'error':'notice'} role={operations.collectionState==='failed'?'alert':'status'}>{operations.collectionState==='failed'?'정보원 갱신 실패':operations.collectionState==='stale'?'마지막 수집값이 오래됐습니다.':'수집된 정보가 없습니다.'}{operations.lastAttempt?` · 마지막 시도 ${displayTime(operations.lastAttempt)}`:''}</p>}
    <section className="main-preview-stack" aria-label="정보통신 운용현황">
      <div className="main-preview-status-row"><section className="card"><h2>태세</h2>{operations?.items.filter(item=>item.kind==='posture').map(item=><strong key={item.itemId}>{item.displayName} · {romanStage(item.stageCode)}</strong>)}{(!operations||!operations.items.some(item=>item.kind==='posture'))&&<p className="empty">수집된 태세 값이 없습니다.</p>}</section><section className="card"><h2>경보</h2>{operations?.items.filter(item=>item.kind==='alarm').map(item=><div className="row-head" key={item.itemId}><strong>{item.displayName}</strong><span className={`operation-health ${item.health==='abnormal'?'warning':''}`}>{item.health==='normal'?'정상':item.health==='abnormal'?'이상':'값 없음'}</span></div>)}{(!operations||!operations.items.some(item=>item.kind==='alarm'))&&<p className="empty">수집된 경보 값이 없습니다.</p>}</section></div>
      <div className="main-preview-group-grid">{operations?.groups.map(group=><section className="card" key={group.groupId}><div className="row-head"><h3>{group.groupId}</h3></div><ul className="main-preview-status-list">{group.items.map(item=><li key={item.itemId}><span>{item.displayName}</span><span className={`operation-health ${item.health==='abnormal'?'warning':''}`}>{item.health==='normal'?'정상':item.health==='abnormal'?'이상':'값 없음'}</span></li>)}</ul>{group.items.length===0&&<p className="empty">수집된 값이 없습니다.</p>}</section>)}</div>
    </section>
  </div>;
}
