import { useEffect } from 'react';
import type { SituationSnapshot } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { displayTime } from '../app/dateTime.mjs';
import { ResourceStatus } from './ResourceStatus';
const stateLabels = { not_collected:'미수집',ok:'수집 정상',failed:'갱신 실패',stale:'유효시간 초과',unconfigured:'미설정' };
const failureLabels: Record<string,string> = {
  UNCONFIGURED:'수집에 필요한 설정이 없습니다.',SOURCE_UNAVAILABLE:'정보원에 연결하지 못했습니다.',TIMEOUT:'정보원 응답 시간이 초과됐습니다.',
  SOURCE_MISMATCH:'정보 종류 또는 출처를 확인하지 못했습니다.',INVALID_SCOPE:'정보원 제공 범위를 확인하지 못했습니다.',INVALID_STAGE:'허용된 단계 값이 아닙니다.',
  INVALID_STAGE_LABEL:'단계 표시가 허용된 값과 다릅니다.',INVALID_OBSERVED_AT:'원본 기준시각을 확인하지 못했습니다.',FUTURE_OBSERVED_AT:'원본 기준시각이 허용된 미래 범위를 벗어났습니다.'
};
export function SituationView({ api }: { api: ApiClient }) {
  const result = useResource<{ gps: SituationSnapshot; cpcon: SituationSnapshot }>(signal => api.getSituation(signal), [api]);
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === 'visible') result.reload(); },30000); return () => window.clearInterval(timer); }, [result.reload]);
  return <><div className="page-head"><h1>정보통신 상황</h1><button onClick={result.reload}>새로고침</button></div><p className="notice">GPS와 CPCON 현황을 자동으로 조회합니다.</p><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {result.data && <div className="dashboard-grid">{[['gps','GPS'],['cpcon','CPCON']].map(([key,title]) => {
      const value = result.data![key as 'gps'|'cpcon'];
      const code = value.stageCode == null ? null : Number(value.stageCode);
      const scope = key === 'gps' && value.scopeKey === 'unit' ? '부대 공통' : key === 'cpcon' && value.sourceMode === 'simulation' && value.scopeKey === 'source' ? '정보원 제공 범위' : value.scopeKey || '정보원 범위 미확인';
      const failure = value.failureCode ? failureLabels[value.failureCode] ?? '이번 수집을 완료하지 못했습니다.' : value.collectionState === 'stale' ? '마지막 성공 정보의 유효시간이 지났습니다.' : '';
      return <section className="card" key={key}><div className="row-head"><h2>{title}</h2><span className={`badge ${['failed','stale','unconfigured'].includes(value.collectionState) ? 'review' : ''}`}>{stateLabels[value.collectionState]}</span></div>
        <p className="situation-stage">{code == null ? '수집된 값 없음' : value.stageLabel ?? (key === 'gps' ? code + '단계' + (code === 5 ? ' · 양호' : '') : 'CPCON' + ['','Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ'][code] + '급')}</p>
        {value.collectionState !== 'ok' && code != null && <p className="muted">마지막 성공 값입니다. 현재 상황으로 확정하지 않습니다.</p>}{failure && <p className="notice" role="status">{failure}</p>}
        <dl><dt>출처</dt><dd>{key === 'gps' ? 'GPS 정보원' : 'CPCON 정보원'}</dd><dt>적용 범위</dt><dd>{scope}</dd><dt>원본 기준시각</dt><dd>{value.observedAt ? displayTime(value.observedAt) : '없음'}</dd><dt>마지막 성공</dt><dd>{value.lastSuccess ? displayTime(value.lastSuccess) : '없음'}</dd><dt>마지막 시도</dt><dd>{value.lastAttempt ? displayTime(value.lastAttempt) : '없음'}</dd></dl>
        {key === 'gps' ? <small>1~5단계 · 5단계 양호</small> : <small>CPCONⅠ급~Ⅴ급</small>}
      </section>;
    })}</div>}
  </>;
}
