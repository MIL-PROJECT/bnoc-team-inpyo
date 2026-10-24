(() => {
  const root = document.documentElement;
  const kind = root.dataset.situationKind;
  if (kind !== 'gps' && kind !== 'cpcon') return;

  const refreshButton = document.getElementById('situation-refresh');
  const statusElement = document.getElementById('situation-status');
  const errorElement = document.getElementById('situation-error');
  const card = document.getElementById('situation-card');
  const stateElement = document.getElementById('situation-state');
  const stageElement = document.getElementById('situation-stage');
  const failureElement = document.getElementById('situation-failure');
  const scopeElement = document.getElementById('situation-scope');
  const stateLabels = { not_collected: '미수집', ok: '수집 정상', failed: '갱신 실패', stale: '유효시간 초과', unconfigured: '미설정' };
  const failureLabels = {
    UNCONFIGURED: '수집에 필요한 설정이 없습니다.',
    SOURCE_UNAVAILABLE: '정보원에 연결하지 못했습니다.',
    TIMEOUT: '정보원 응답 시간이 초과됐습니다.',
    SOURCE_MISMATCH: '정보 종류 또는 출처를 확인하지 못했습니다.',
    INVALID_SCOPE: '정보원 제공 범위를 확인하지 못했습니다.',
    INVALID_STAGE: '허용된 단계 값이 아닙니다.',
    INVALID_STAGE_LABEL: '단계 표시가 허용된 값과 다릅니다.',
    INVALID_OBSERVED_AT: '원본 기준시각을 확인하지 못했습니다.',
    FUTURE_OBSERVED_AT: '원본 기준시각이 허용된 미래 범위를 벗어났습니다.'
  };
  const cpconStages = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V' };
  let currentSnapshot = null;
  let fetchFailed = false;

  function render(snapshot) {
    const code = snapshot.stageCode == null ? null : Number(snapshot.stageCode);
    const stage = kind === 'cpcon'
      ? cpconStages[String(snapshot.stageCode)] ?? '수집된 값 없음'
      : code == null ? '수집된 값 없음' : snapshot.stageLabel ?? `${code}단계${code === 5 ? ' · 양호' : ''}`;
    const scope = kind === 'gps' && snapshot.scopeKey === 'unit'
      ? '부대 공통'
      : kind === 'cpcon' && snapshot.sourceMode === 'simulation' && snapshot.scopeKey === 'source'
        ? '정보원 제공 범위'
        : snapshot.scopeKey || '정보원 범위 미확인';
    const failure = snapshot.failureCode
      ? failureLabels[snapshot.failureCode] ?? '이번 수집을 완료하지 못했습니다.'
      : snapshot.collectionState === 'stale' ? '마지막 성공 정보의 유효시간이 지났습니다.' : '';
    const badgeText = fetchFailed
      ? (currentSnapshot ? '조회 오류 · 마지막 값' : '조회 오류')
      : stateLabels[snapshot.collectionState] ?? '상태 확인';

    stateElement.textContent = badgeText;
    stateElement.className = `badge${fetchFailed || ['failed', 'stale', 'unconfigured'].includes(snapshot.collectionState) ? ' badge--review' : ''}`;
    stageElement.textContent = stage;
    scopeElement.textContent = scope;
    failureElement.textContent = fetchFailed
      ? '상황을 다시 확인하지 못했습니다. 표시된 값은 마지막 응답이며 현재 상황으로 확정하지 않습니다.'
      : failure || (snapshot.collectionState !== 'ok' && code != null ? '마지막 성공 값입니다. 현재 상황으로 확정하지 않습니다.' : '');
    failureElement.hidden = !failureElement.textContent;
    card.hidden = false;
  }

  async function reload() {
    refreshButton.disabled = true;
    statusElement.hidden = !currentSnapshot;
    statusElement.textContent = currentSnapshot ? '상황 정보를 확인하는 중입니다.' : '상황 정보를 불러오는 중입니다.';
    errorElement.hidden = true;
    errorElement.textContent = '';
    try {
      const response = await fetch(`/api/situation/${kind}`, { headers: { Accept: 'application/json' } });
      if (response.status === 401) {
        errorElement.textContent = '로그인 세션을 확인할 수 없습니다. BNOC 화면에서 다시 로그인하세요.';
        throw new Error('unauthenticated');
      }
      if (!response.ok) throw new Error('request-failed');
      const envelope = await response.json();
      if (!envelope?.data || envelope.data.kind !== kind) throw new Error('invalid-response');
      currentSnapshot = envelope.data;
      fetchFailed = false;
      render(currentSnapshot);
      statusElement.hidden = true;
    } catch {
      fetchFailed = true;
      if (!errorElement.textContent) errorElement.textContent = '상황 정보를 불러오지 못했습니다. 잠시 뒤 다시 확인하세요.';
      errorElement.hidden = false;
      if (currentSnapshot) render(currentSnapshot);
      statusElement.hidden = true;
    } finally {
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => void reload());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reload();
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void reload();
  }, 30000);
  void reload();
})();
