import { useId, useMemo, useState, type FormEvent } from 'react';
import { moveDate, seoulDate } from '../app/dateTime.mjs';
import { isPlannedWorkInProgressOnDate, isValidPlannedWorkCompletionDate } from '../app/plannedWorkDate.mjs';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { ActionGroup } from '../ui/ActionGroup';
import { ActionRow } from '../ui/ActionRow';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/DateInput';

export type PlannedWorkDemoItem = {
  id: string;
  title: string;
  status: '진행 중' | '완료';
  firstWorkDate: string;
  completedDate?: string;
  department?: string;
  teamId?: string;
};

const dateLabel = (value: string) => {
  if (!value) return '날짜 선택';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(year, month - 1, day));
};

function PlannedDateField({ label, value, min, max, today, showNavigation = false, onChange }: { label: string; value: string; min?: string; max?: string; today?: string; showNavigation?: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const dateKind = today && value ? value < today ? '지난 날짜' : value > today ? '미래 예정' : '오늘' : '';
  return <div className="field planned-date-field"><label htmlFor={id}>{label}{showNavigation && dateKind && <small className={`planned-date-kind planned-date-kind-${dateKind === '오늘' ? 'today' : dateKind === '미래 예정' ? 'future' : 'past'}`}>{dateKind}</small>}</label><span className="planned-date-control">
    <DateInput id={id} value={value} min={min} max={max} required onChange={event => onChange(event.target.value)} />
  </span>{showNavigation && value && <ActionGroup className="planned-date-nav" role="group" aria-label="날짜 빠른 이동">
    <Button type="button" aria-label="이전 날짜" onClick={() => onChange(moveDate(value, -1))}>← 이전</Button>
    <Button type="button" aria-current={value === today ? 'date' : undefined} onClick={() => today && onChange(today)}>오늘</Button>
    <Button type="button" aria-label="다음 날짜" onClick={() => onChange(moveDate(value, 1))}>다음 →</Button>
  </ActionGroup>}</div>;
}

export function PlannedMaintenanceView({ department, teamId, items, onChange, onOpenOverview }: {
  department: string;
  teamId?: string;
  items: PlannedWorkDemoItem[];
  onChange: (items: PlannedWorkDemoItem[]) => void;
  onOpenOverview: () => void;
}) {
  const today = seoulDate();
  const [selectedDate, setSelectedDate] = useState(today);
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editFirstWorkDate, setEditFirstWorkDate] = useState('');
  const [editError, setEditError] = useState('');
  const [completingId, setCompletingId] = useState('');
  const [completedDate, setCompletedDate] = useState(today);
  const inProgressItems = useMemo(() => items.filter(item => item.status === '진행 중'), [items]);
  const dayItems = useMemo(() => inProgressItems.filter(item => isPlannedWorkInProgressOnDate(item, selectedDate)), [inProgressItems, selectedDate]);
  const completedItems = useMemo(() => items.filter(item => item.status === '완료'), [items]);
  const editingItem = items.find(item => item.id === editingId);
  useUnsavedChanges(Boolean(title.trim()) || Boolean(editingItem && (editTitle !== editingItem.title || editFirstWorkDate !== editingItem.firstWorkDate)));

  const addItem = (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || !selectedDate) return;
    onChange([{ id: crypto.randomUUID(), title: cleanTitle, status: '진행 중', firstWorkDate: selectedDate, department, teamId }, ...items]);
    setTitle('');
    setNotice('작업을 추가했습니다.');
  };

  const startEdit = (item: PlannedWorkDemoItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditFirstWorkDate(item.firstWorkDate);
    setEditError('');
    setNotice('');
  };

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = editTitle.trim();
    if (!cleanTitle || !editFirstWorkDate || !editingItem) return;
    if (editingItem.completedDate && editFirstWorkDate > editingItem.completedDate) {
      setEditError('업무 기준일은 완료일보다 늦을 수 없습니다.');
      return;
    }
    onChange(items.map(item => item.id === editingId ? { ...item, title: cleanTitle, firstWorkDate: editFirstWorkDate } : item));
    setEditingId('');
    setEditError('');
    setNotice('수정했습니다.');
  };

  const complete = (item: PlannedWorkDemoItem) => {
    if (!isValidPlannedWorkCompletionDate(item, completedDate, today)) return;
    if (!window.confirm(`‘${item.title}’ 작업을 완료 처리할까요?`)) return;
    onChange(items.map(value => value.id === item.id ? { ...value, status: '완료', completedDate } : value));
    setCompletingId('');
    setNotice('완료 처리했습니다.');
  };

  const remove = (item: PlannedWorkDemoItem) => {
    if (!window.confirm(`‘${item.title}’ 작업을 영구 삭제할까요?`)) return;
    onChange(items.filter(value => value.id !== item.id));
    setNotice('삭제했습니다.');
  };

  const renderEdit = (item: PlannedWorkDemoItem) => <form className="planned-edit" onSubmit={saveEdit}>
    <label className="field"><span>작업 제목</span><input value={editTitle} onChange={event => setEditTitle(event.target.value)} maxLength={160} required autoFocus /></label>
    <PlannedDateField label="업무 날짜" value={editFirstWorkDate} onChange={value => { setEditFirstWorkDate(value); setEditError(''); }} />
    {editError && <p className="error" role="alert">{editError}</p>}
    <ActionGroup><Button type="submit" variant="primary" disabled={!editTitle.trim() || !editFirstWorkDate}>저장</Button><Button onClick={() => { setEditingId(''); setEditError(''); }}>취소</Button></ActionGroup>
  </form>;

  const renderCompletionCheck = (item: PlannedWorkDemoItem) => completingId === item.id ? <div className="planned-complete-check">
    <PlannedDateField label="완료일" value={completedDate} min={item.firstWorkDate} max={today} onChange={setCompletedDate} />
    <ActionGroup><Button type="button" variant="primary" disabled={!isValidPlannedWorkCompletionDate(item, completedDate, today)} onClick={() => complete(item)}>완료 처리</Button>
      <Button type="button" onClick={() => setCompletingId('')}>취소</Button>
    </ActionGroup>
  </div> : null;

  const renderActions = (item: PlannedWorkDemoItem) => <ActionGroup className="planned-item-actions">
    <Button type="button" onClick={() => startEdit(item)}>수정</Button>
    {item.status === '진행 중' && item.firstWorkDate <= today && <Button type="button" onClick={() => { setCompletingId(item.id); setCompletedDate(today); }}>완료</Button>}
    <Button type="button" variant="danger" onClick={() => remove(item)}>삭제</Button>
  </ActionGroup>;

  const renderWorkItem = (item: PlannedWorkDemoItem) => <ActionRow className="planned-item" key={item.id}
    actions={editingId === item.id ? undefined : renderActions(item)}
    details={editingId !== item.id && item.status === '진행 중' ? renderCompletionCheck(item) : undefined}>
    {editingId === item.id ? renderEdit(item) : <div className="planned-item-main"><h3>{item.title}</h3><small className="planned-item-status">{item.status}{item.completedDate && ` · 완료일 ${dateLabel(item.completedDate)}`}</small></div>}
  </ActionRow>;

  return <div className="planned-page">
    <div className="page-head planned-head">
      <div><small>{department}</small><h1>계획 정비</h1></div>
      <Button type="button" onClick={onOpenOverview}>전체 작업 현황</Button>
    </div>

    <section className="planned-date-panel" aria-label="업무 날짜 선택">
      <PlannedDateField label="업무 날짜" value={selectedDate} today={today} showNavigation onChange={value => { setSelectedDate(value); setNotice(''); }} />
    </section>

    <section className="planned-section" aria-labelledby="planned-add-title">
      <div className="row-head"><h2 id="planned-add-title">작업 추가</h2></div>
      <form className="planned-add" onSubmit={addItem}>
        <label className="field"><span>작업 제목</span><input value={title} onChange={event => { setTitle(event.target.value); setNotice(''); }} placeholder="장소를 포함해 입력" maxLength={160} required /></label>
        <Button type="submit" variant="primary" disabled={!title.trim() || !selectedDate}>작업 추가</Button>
      </form>
    </section>

    <section className="planned-section" aria-labelledby="planned-day-title">
      <div className="row-head"><h2 id="planned-day-title">{dateLabel(selectedDate)} 업무 <span className="count">{dayItems.length}</span></h2></div>
      {dayItems.length ? <div className="planned-list">{dayItems.map(renderWorkItem)}</div> : <p className="empty planned-empty">진행 중인 작업이 없습니다.</p>}
    </section>

    <section className="planned-section" aria-labelledby="planned-completed-title">
      <div className="row-head"><h2 id="planned-completed-title">완료 작업 <span className="count">{completedItems.length}</span></h2></div>
      {completedItems.length ? <div className="planned-list">{completedItems.map(renderWorkItem)}</div> : <p className="empty planned-empty">완료된 작업이 없습니다.</p>}
    </section>

    {notice && <p className="planned-feedback" role="status">{notice}</p>}
  </div>;
}
