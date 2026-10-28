import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/apiClient.mjs';
import { ApiClient } from '../api/apiClient.mjs';
import { moveDate, seoulDate } from '../app/dateTime.mjs';
import { errorMessage, useResource } from '../app/useResource';
import { isPlannedWorkInProgressOnDate, isValidPlannedWorkCompletionDate } from '../app/plannedWorkDate.mjs';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { ActionGroup } from '../ui/ActionGroup';
import { ActionRow } from '../ui/ActionRow';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/DateInput';
import type { PlannedWork, PlannedWorkList } from '../types';
import { ResourceStatus } from './ResourceStatus';

const dateLabel = (value: string) => {
  if (!value) return '날짜 선택';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(year, month - 1, day));
};

type PendingCreate = { operationId: string; firstWorkDate: string; createdAt: number };

const createKey = (operationId: string) => JSON.stringify(['create', operationId]);
const pendingCreateStoragePrefix = 'bnoc:planned-create:';

function readPendingCreates(): PendingCreate[] {
  try { for (const key of Object.keys(window.localStorage)) if (key.startsWith(pendingCreateStoragePrefix)) window.localStorage.removeItem(key); } catch { /* Legacy keys are best-effort cleanup only. */ }
  try {
    return Object.keys(window.sessionStorage).filter(key => key.startsWith(pendingCreateStoragePrefix)).flatMap(key => {
      const value = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as Partial<PendingCreate> | null;
      if (!value || typeof value.operationId !== 'string' || !value.operationId || key !== `${pendingCreateStoragePrefix}${value.operationId}` || typeof value.firstWorkDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.firstWorkDate) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return [];
      return [{ operationId: value.operationId, firstWorkDate: value.firstWorkDate, createdAt: value.createdAt }];
    }).sort((left, right) => left.createdAt - right.createdAt);
  } catch { return []; }
}

function clearPendingCreate(operationId: string) {
  try { window.sessionStorage.removeItem(`${pendingCreateStoragePrefix}${operationId}`); } catch { /* The server receipt still makes a retained retry safe. */ }
}

export function clearPendingPlannedCreateRecovery() {
  try { for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(pendingCreateStoragePrefix)) window.sessionStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
  try { for (const key of Object.keys(window.localStorage)) if (key.startsWith(pendingCreateStoragePrefix)) window.localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
}

function PlannedDateField({ label, value, min, max, today, showNavigation = false, disabled = false, onChange }: { label: string; value: string; min?: string; max?: string; today?: string; showNavigation?: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const dateKind = today && value ? value < today ? '지난 날짜' : value > today ? '미래 예정' : '오늘' : '';
  return <div className="field planned-date-field"><label htmlFor={id}>{label}{showNavigation && dateKind && <small className={`planned-date-kind planned-date-kind-${dateKind === '오늘' ? 'today' : dateKind === '미래 예정' ? 'future' : 'past'}`}>{dateKind}</small>}</label><span className="planned-date-control">
    <DateInput id={id} value={value} min={min} max={max} required disabled={disabled} onChange={event => onChange(event.target.value)} />
  </span>{showNavigation && value && <ActionGroup className="planned-date-nav" role="group" aria-label="날짜 빠른 이동">
    <Button type="button" disabled={disabled} aria-label="이전 날짜" onClick={() => onChange(moveDate(value, -1))}>이전</Button>
    <Button type="button" disabled={disabled} aria-current={value === today ? 'date' : undefined} onClick={() => today && onChange(today)}>오늘</Button>
    <Button type="button" disabled={disabled} aria-label="다음 날짜" onClick={() => onChange(moveDate(value, 1))}>다음</Button>
  </ActionGroup>}</div>;
}

export function PlannedMaintenanceView({ api, revision, department, onChanged, onOpenOverview }: {
  api: ApiClient;
  revision: number;
  department: string;
  onChanged: () => void;
  onOpenOverview: () => void;
}) {
  const today = seoulDate();
  const [pendingCreates, setPendingCreates] = useState<PendingCreate[]>(() => readPendingCreates());
  const [selectedDate, setSelectedDate] = useState(() => pendingCreates[0]?.firstWorkDate ?? today);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [uncertainCreate, setUncertainCreate] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(pendingCreates.length > 0);
  const [activePendingOperationId, setActivePendingOperationId] = useState(() => pendingCreates.length === 1 ? pendingCreates[0].operationId : '');
  const [recoveryList, setRecoveryList] = useState<PlannedWorkList | null>(null);
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const [notice, setNotice] = useState('');
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const [writeError, setWriteError] = useState(() => pendingCreates.length > 0 ? '저장 결과를 확인하지 못했습니다. 원래 작업 제목을 다시 입력하면 같은 제출 번호로 확인합니다.' : '');
  useEffect(()=>{if(writeError){feedbackRef.current?.focus({preventScroll:true});feedbackRef.current?.scrollIntoView({block:'nearest'});}},[writeError]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editFirstWorkDate, setEditFirstWorkDate] = useState('');
  const [completingId, setCompletingId] = useState('');
  const [completedDate, setCompletedDate] = useState(today);
  const pendingOperations = useRef(new Map<string, string>(pendingCreates.map(pending => [createKey(pending.operationId), pending.operationId])));
  const lastWriteErrorCode = useRef('');
  const context = { workDate: selectedDate, revision };
  const result = useResource<PlannedWorkList, typeof context>(signal => api.getPlannedWorks(selectedDate, signal), [api, selectedDate, revision], context);
  const data = result.success?.context?.workDate === selectedDate && result.success.context.revision === revision ? result.data : null;
  const inProgressItems = data?.inProgress ?? [];
  const dayItems = useMemo(() => inProgressItems.filter(item => isPlannedWorkInProgressOnDate(item, selectedDate)), [inProgressItems, selectedDate]);
  const completedItems = data?.completed ?? [];
  const editingItem = [...inProgressItems, ...completedItems].find(item => item.id === editingId);
  const editDirty = Boolean(editingItem && (editTitle !== editingItem.title || editFirstWorkDate !== editingItem.firstWorkDate));
  useUnsavedChanges(Boolean(title.trim()) || editDirty || creating || uncertainCreate, creating || uncertainCreate);

  const changeWorkDate = (value: string) => {
    if (uncertainCreate || saving || !value || value === selectedDate) return;
    if (editDirty && !window.confirm('수정 중인 내용이 저장되지 않았습니다. 날짜를 이동하면 수정 내용을 버릴까요?')) return;
    if (editDirty) setEditingId('');
    setSelectedDate(value);
    setNotice('');
    setWriteError('');
  };

  const write = async (key: string, action: (operationId: string) => Promise<unknown>, success: string) => {
    let operationId = pendingOperations.current.get(key);
    if (!operationId) { operationId = crypto.randomUUID(); pendingOperations.current.set(key, operationId); }
    lastWriteErrorCode.current = '';
    setSaving(true); setWriteError(''); setNotice('');
    try {
      await action(operationId);
      pendingOperations.current.delete(key);
      setNotice(success);
      onChanged();
      return true;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'SAVE_FAILED';
      lastWriteErrorCode.current = code;
      if (!['NETWORK', 'INVALID_RESPONSE', 'PROCESSING', 'SAVE_FAILED', 'DUPLICATE_ACTION'].includes(code)) pendingOperations.current.delete(key);
      setWriteError(errorMessage(error instanceof Error ? error : new Error('저장하지 못했습니다.')));
      if (code === 'CONFLICT') onChanged();
      return false;
    } finally { setSaving(false); }
  };

  const addItem = (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || !selectedDate) return;
    const activePending = uncertainCreate || recoveryRequired ? pendingCreates.find(item => item.operationId === activePendingOperationId) : undefined;
    if ((uncertainCreate || recoveryRequired) && !activePending) return;
    const operationId = activePending?.operationId ?? crypto.randomUUID();
    const key = createKey(operationId);
    const pending = activePending ?? { operationId, firstWorkDate: selectedDate, createdAt: Date.now() };
    try {
      window.sessionStorage.setItem(`${pendingCreateStoragePrefix}${operationId}`, JSON.stringify(pending));
    } catch {
      setWriteError('재시도 정보를 브라우저에 보관하지 못해 저장하지 않았습니다. 브라우저 저장공간을 확인하세요.');
      return;
    }
    pendingOperations.current.set(key, operationId);
    setActivePendingOperationId(operationId);
    setPendingCreates(previous => previous.some(item => item.operationId === operationId) ? previous : [...previous, pending].sort((left, right) => left.createdAt - right.createdAt));
    setRecoveryRequired(false);
      setRecoveryList(null);
    setCreating(true);
    void write(key, operationId => api.createPlannedWork({ operationId, title: cleanTitle, firstWorkDate: selectedDate }), '작업을 추가했습니다.').then(saved => {
      setCreating(false);
      if (saved) {
        clearPendingCreate(operationId);
        const remaining = readPendingCreates().filter(item => item.operationId !== operationId);
        setPendingCreates(remaining);
        if (remaining.length > 0) {
          setTitle(''); setSelectedDate(remaining[0].firstWorkDate); setUncertainCreate(false); setRecoveryRequired(true);
          setActivePendingOperationId(remaining.length === 1 ? remaining[0].operationId : '');
          setWriteError(remaining.length === 1 ? '저장 결과를 확인하지 못한 다른 제출이 있습니다. 원래 작업 제목을 다시 입력하세요.' : '확인이 필요한 제출을 날짜와 시각으로 골라 원래 제목을 다시 입력하세요.');
        } else { setTitle(''); setUncertainCreate(false); setRecoveryRequired(false); setActivePendingOperationId(''); }
      }
      else if (pendingOperations.current.has(key)) {
        setPendingCreates(readPendingCreates());
        setActivePendingOperationId(operationId);
        setUncertainCreate(true);
        setRecoveryRequired(false);
        setWriteError(lastWriteErrorCode.current === 'DUPLICATE_ACTION'
          ? '같은 제출 번호를 다시 쓸 수 없습니다. 목록을 새로 조회한 뒤 원래 작업이 없으면 새 제출로 전환하세요.'
          : '저장 결과가 확인되지 않았습니다. 제목과 날짜를 유지하고 같은 제출을 다시 확인하세요.');
      } else {
        clearPendingCreate(operationId);
        const remaining = readPendingCreates().filter(item => item.operationId !== operationId);
        setPendingCreates(remaining);
        setActivePendingOperationId(remaining.length === 1 ? remaining[0].operationId : '');
        setUncertainCreate(false); setRecoveryRequired(remaining.length > 0);
        if (lastWriteErrorCode.current === 'OPERATION_NOT_AVAILABLE') {
          setTitle(''); setSelectedDate(remaining[0]?.firstWorkDate ?? today); setRecoveryList(null);
          setWriteError('현재 계정 또는 작업반에서 확인할 수 없는 제출입니다. 작업 목록을 확인하고 새 작업은 제목을 다시 입력하세요.');
        }
      }
    });
  };

  const checkUncertainCreate = async () => {
    if (!uncertainCreate || lastWriteErrorCode.current !== 'DUPLICATE_ACTION') return;
    setCheckingRecovery(true); setRecoveryList(null); setWriteError('');
    try {
      const latest = await api.getPlannedWorks(selectedDate, new AbortController().signal);
      setRecoveryList(latest);
      onChanged();
      setWriteError('최신 목록을 조회했습니다. 아래 목록에서 원래 작업이 보이지 않는지 확인하세요.');
    } catch (error) {
      setWriteError(`최신 작업 목록을 확인하지 못했습니다. 다시 조회하세요. ${errorMessage(error instanceof Error ? error : new Error('조회하지 못했습니다.'))}`);
    } finally { setCheckingRecovery(false); }
  };

  const beginNewCreateAfterCheck = () => {
    if (!recoveryList || lastWriteErrorCode.current !== 'DUPLICATE_ACTION' || !activePendingOperationId) return;
    if (!window.confirm('최신 목록에서 원래 작업이 없음을 확인했습니까? 기존 작업이 보이면 취소하고 다시 만들지 마세요.')) return;
    clearPendingCreate(activePendingOperationId);
    pendingOperations.current.delete(createKey(activePendingOperationId));
    const remaining = readPendingCreates();
    setPendingCreates(remaining); setRecoveryList(null); setActivePendingOperationId(remaining.length === 1 ? remaining[0].operationId : '');
    setUncertainCreate(false); setRecoveryRequired(remaining.length > 0); lastWriteErrorCode.current = '';
    if (remaining.length) {
      setTitle(''); setSelectedDate(remaining[0].firstWorkDate);
      setWriteError(remaining.length === 1 ? '다른 확인 대기 제출이 있습니다. 원래 제목을 다시 입력하세요.' : '다른 확인 대기 제출을 날짜와 시각으로 선택하세요.');
    } else setWriteError('새 제출을 준비했습니다. 기존 작업이 없음을 확인한 뒤 작업 추가를 누르세요.');
  };

  const startEdit = (item: PlannedWork) => {
    setEditingId(item.id); setEditTitle(item.title); setEditFirstWorkDate(item.firstWorkDate); setWriteError(''); setNotice('');
  };

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = editTitle.trim();
    if (!cleanTitle || !editFirstWorkDate || !editingItem) return;
    if (editingItem.completedDate && editFirstWorkDate > editingItem.completedDate) {
      setWriteError('업무 기준일은 완료일보다 늦을 수 없습니다.');
      return;
    }
    const item = editingItem;
    const key = JSON.stringify(['update', item.id, item.revision, cleanTitle, editFirstWorkDate]);
    void write(key, operationId => api.updatePlannedWork(item.id, { operationId, revision: item.revision, title: cleanTitle, firstWorkDate: editFirstWorkDate }), '수정했습니다.').then(saved => {
      if (saved) setEditingId('');
    });
  };

  const complete = (item: PlannedWork) => {
    if (!isValidPlannedWorkCompletionDate(item, completedDate, today)) return;
    if (!window.confirm(`‘${item.title}’ 작업을 완료 처리할까요?`)) return;
    const key = JSON.stringify(['complete', item.id, item.revision, completedDate]);
    void write(key, operationId => api.completePlannedWork(item.id, { operationId, revision: item.revision, completedDate }), '완료 처리했습니다.').then(saved => {
      if (saved) setCompletingId('');
    });
  };

  const remove = async (item: PlannedWork) => {
    if (!window.confirm(`‘${item.title}’ 작업을 영구 삭제할까요?`)) return;
    setSaving(true); setWriteError(''); setNotice('');
    try {
      await api.deletePlannedWork(item.id, item.revision);
      setNotice('삭제했습니다.'); onChanged();
    } catch (error) {
      setWriteError(errorMessage(error instanceof Error ? error : new Error('삭제하지 못했습니다.')));
      if (error instanceof ApiError && ['CONFLICT', 'NOT_FOUND', 'NETWORK', 'INVALID_RESPONSE', 'PROCESSING'].includes(error.code)) onChanged();
      if (error instanceof ApiError && ['NETWORK', 'INVALID_RESPONSE', 'PROCESSING'].includes(error.code)) setWriteError('삭제 결과를 확인하지 못했습니다. 목록을 새로고침해 상태를 확인하세요.');
    } finally { setSaving(false); }
  };

  const renderEdit = (item: PlannedWork) => <form className="planned-edit" onSubmit={saveEdit}>
    <label className="field"><span>작업 제목</span><input value={editTitle} onChange={event => setEditTitle(event.target.value)} maxLength={160} required autoFocus /></label>
    <PlannedDateField label="업무 날짜" value={editFirstWorkDate} onChange={setEditFirstWorkDate} />
    <ActionGroup><Button type="submit" variant="primary" disabled={saving || !editTitle.trim() || !editFirstWorkDate}>저장</Button><Button disabled={saving} onClick={() => setEditingId('')}>취소</Button></ActionGroup>
  </form>;

  const renderCompletionCheck = (item: PlannedWork) => completingId === item.id ? <div className="planned-complete-check">
    <PlannedDateField label="완료일" value={completedDate} min={item.firstWorkDate} max={today} onChange={setCompletedDate} />
    <ActionGroup><Button type="button" variant="primary" disabled={saving || !isValidPlannedWorkCompletionDate(item, completedDate, today)} onClick={() => complete(item)}>완료 처리</Button>
      <Button type="button" disabled={saving} onClick={() => setCompletingId('')}>취소</Button>
    </ActionGroup>
  </div> : null;

  const renderActions = (item: PlannedWork) => <ActionGroup className="planned-item-actions">
    <Button type="button" disabled={saving} onClick={() => startEdit(item)}>수정</Button>
    {item.status === '진행 중' && item.firstWorkDate <= today && <Button type="button" disabled={saving} onClick={() => { setCompletingId(item.id); setCompletedDate(today); setWriteError(''); }}>완료</Button>}
    <Button type="button" variant="danger" disabled={saving} onClick={() => void remove(item)}>삭제</Button>
  </ActionGroup>;

  const renderWorkItem = (item: PlannedWork) => <ActionRow className="planned-item" key={item.id}
    actions={editingId === item.id ? undefined : renderActions(item)}
    details={editingId !== item.id && item.status === '진행 중' ? renderCompletionCheck(item) : undefined}>
    {editingId === item.id ? renderEdit(item) : <div className="planned-item-main"><h3>{item.title}</h3><small className="planned-item-status">{item.status}{item.completedDate && ` · 완료일 ${dateLabel(item.completedDate)}`}</small></div>}
  </ActionRow>;

  return <div className="planned-page">
    <div className="page-head planned-head">
      <div><small>{department}</small><h1>계획 정비</h1></div>
      <Button type="button" disabled={creating || uncertainCreate} onClick={onOpenOverview}>전체 작업 현황</Button>
    </div>

    {writeError && <p ref={feedbackRef} tabIndex={-1} className="error" role="alert">{writeError}</p>}
    {notice && <p className="planned-feedback" role="status">{notice}</p>}

    <section className="planned-date-panel" aria-label="업무 날짜 선택">
      <PlannedDateField label="업무 날짜" value={selectedDate} today={today} showNavigation disabled={uncertainCreate || recoveryRequired || saving} onChange={changeWorkDate} />
    </section>

    <section className="planned-section" aria-labelledby="planned-add-title">
      <div className="row-head"><h2 id="planned-add-title">작업 추가</h2></div>
      {recoveryRequired && !activePendingOperationId && <div className="planned-pending-recovery" aria-label="확인이 필요한 제출">
        <p>확인이 필요한 제출이 여러 건입니다. 날짜와 시각을 골라 원래 제목을 다시 입력하세요.</p>
        <ActionGroup>{pendingCreates.map(item => <Button key={item.operationId} type="button" disabled={saving} onClick={() => {
          setActivePendingOperationId(item.operationId); setSelectedDate(item.firstWorkDate); setTitle(''); setUncertainCreate(false);
          setWriteError('원래 작업 제목을 다시 입력하면 같은 제출 번호로 확인합니다.');
        }}>{dateLabel(item.firstWorkDate)} · {new Date(item.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Button>)}</ActionGroup>
      </div>}
      {uncertainCreate && lastWriteErrorCode.current === 'DUPLICATE_ACTION' && <div className="planned-pending-recovery" aria-label="새 제출 복구">
        <p>같은 제출 번호를 다시 사용할 수 없습니다. 최신 목록을 확인한 뒤 원래 작업이 없을 때만 새 제출을 시작하세요.</p>
        <Button type="button" disabled={checkingRecovery || saving} onClick={() => void checkUncertainCreate()}>{checkingRecovery ? '목록 확인 중…' : '최신 목록 조회'}</Button>
        {recoveryList && <>
          <ul aria-label="최신 작업 목록">
            {[...recoveryList.inProgress, ...recoveryList.completed].map(item => <li key={item.id}>{item.title} · {item.status} · {item.firstWorkDate}</li>)}
            {recoveryList.inProgress.length + recoveryList.completed.length === 0 && <li>현재 작업이 없습니다.</li>}
          </ul>
          <Button type="button" disabled={checkingRecovery || saving} onClick={beginNewCreateAfterCheck}>목록 확인 후 새 제출 시작</Button>
        </>}
      </div>}
      <form className="planned-add" onSubmit={addItem}>
        <label className="field"><span>작업 제목</span><input value={title} onChange={event => { setTitle(event.target.value); setNotice(''); }} placeholder="장소를 포함해 입력" maxLength={160} required disabled={uncertainCreate || saving || (recoveryRequired && !activePendingOperationId)} /></label>
        <Button type="submit" variant="primary" disabled={saving || !title.trim() || !selectedDate || (recoveryRequired && !activePendingOperationId)}>{uncertainCreate || recoveryRequired ? '같은 제출 재확인' : '작업 추가'}</Button>
      </form>
    </section>

    <ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {data && <>
      <section className="planned-section" aria-labelledby="planned-day-title">
        <div className="row-head"><h2 id="planned-day-title">{dateLabel(selectedDate)} 업무 <span className="count">{dayItems.length}</span></h2></div>
        {dayItems.length ? <div className="planned-list">{dayItems.map(renderWorkItem)}</div> : <p className="empty planned-empty">진행 중인 작업이 없습니다.</p>}
      </section>

      <section className="planned-section" aria-labelledby="planned-completed-title">
        <div className="row-head"><h2 id="planned-completed-title">완료 작업 <span className="count">{completedItems.length}</span></h2></div>
        {completedItems.length ? <div className="planned-list">{completedItems.map(renderWorkItem)}</div> : <p className="empty planned-empty">완료된 작업이 없습니다.</p>}
      </section>
    </>}

  </div>;
}
