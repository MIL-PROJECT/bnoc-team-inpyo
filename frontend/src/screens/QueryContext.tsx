import { displayTime } from '../app/dateTime.mjs';

export function describeConditions(fields: [string, string | undefined][]) {
  return fields.filter(([, value]) => !!value).map(([label, value]) => `${label}: ${value}`).join(' · ') || '전체';
}

export function QueryContext({ success, loading, error, draftChanged = false }: {
  success: { context: { conditions: string } | undefined; confirmedAt: string } | null;
  loading: boolean; error: Error | null; draftChanged?: boolean;
}) {
  if (!success && !draftChanged) return null;
  return <div className="query-context" aria-live="polite">
    {success && <p><strong>{loading || error ? '마지막 성공 결과' : '조회 결과'}</strong> · 조건: {success.context?.conditions ?? '전체'} · 확인 시각: {displayTime(success.confirmedAt)}</p>}
    {draftChanged && <p className="muted">조건 편집 중 · 검색 전까지 표시된 결과를 유지합니다.</p>}
  </div>;
}
