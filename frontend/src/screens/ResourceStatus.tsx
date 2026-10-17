import { ApiError } from '../api/apiClient.mjs';
import { errorMessage } from '../app/useResource';
export function ResourceStatus({ loading, error, retry }: { loading: boolean; error: Error | null; retry?: () => void }) {
  if (error) return <p className="error" role="alert">{errorMessage(error)}{!(error instanceof ApiError && error.status === 401) && retry && <button onClick={retry}>다시 조회</button>}</p>;
  if (loading) return <p className="muted" role="status">불러오는 중…</p>;
  return null;
}
