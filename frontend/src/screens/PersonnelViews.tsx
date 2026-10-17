import { useState } from 'react';
import type { Actor, Roster, RosterPerson, PersonnelDay, NightDutyDay } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { seoulDate } from '../app/dateTime.mjs';
import { dailyPersonnelEntries, currentOperationalResource } from '../app/operationDrafts.mjs';
import type { RunCommand } from './RequestRegistrationForm';
import { ResourceStatus } from './ResourceStatus';
import { saveFailureMessage } from '../app/formFeedback.mjs';
const statusLabels: Record<string,string> = { leave:'휴가',trip:'출장',available:'가용' };
function saveMessage(result: Awaited<ReturnType<RunCommand>>, success: string) { return result.ok ? success : saveFailureMessage(result); }
export function RosterView({ actor, api, run, departments, revision }: { actor: Actor; api: ApiClient; run: RunCommand; departments: string[]; revision: number }) {
  const [department, setDepartment] = useState(actor.department);
  const result = useResource<Roster>(signal => api.getRoster(department, signal), [api, department, revision]);
  const [draft, setDraft] = useState<(Omit<RosterPerson,'personRef'> & { personRef?: string })[] | null>(null), [baseRevision, setBaseRevision] = useState(0), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false);
  const [failed,setFailed] = useState(false);
  const { saving, submit } = useSubmission(run);
  useUnsavedChanges(draft !== null);
  const entries = draft ?? result.data?.entries ?? [];
  const current = currentOperationalResource(result,'department',department);
  const canWrite = actor.departmentManager && department === actor.department && current;
  const change = (next: typeof entries) => { if (!canWrite) return; if (draft === null) setBaseRevision(result.data?.revision ?? 0); setDraft(next); setMessage(''); setFailed(false); };
  const save = async () => {
    if (!canWrite || !current) return;
    setMessage(''); setFailed(false);
    const response = await submit('savePersonnelRoster', { department, entries: entries.map(entry => ({ ...(entry.personRef ? { personRef: entry.personRef } : {}), displayName: entry.displayName, active: entry.active !== false })) }, undefined, draft === null ? result.data?.revision ?? 0 : baseRevision);
    if (!response) return;
    setMessage(saveMessage(response, `${department} 명부를 저장했습니다.`)); setFailed(!response.ok); setConflict(!response.ok && response.errorCode === 'CONFLICT');
    if (response.ok) { setDraft(null); result.reload(); }
  };
  return <><div className="page-head"><h1>부서 명부</h1><button onClick={result.reload}>새로고침</button></div><label className="field limited-field"><span>부서</span><select value={department} onChange={e => { if (draft && !window.confirm('저장하지 않은 명부 변경이 있습니다. 다른 부서로 이동할까요?')) return; setDraft(null); setConflict(false); setDepartment(e.target.value); setMessage(''); }}>{departments.map(item => <option key={item}>{item}</option>)}</select></label><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {result.data && <section className="card section-gap"><h2>{result.data.department}</h2>{!current && <p className="notice">마지막 성공 조회: {result.data.department}. 선택한 부서의 조회가 성공하기 전에는 수정할 수 없습니다.</p>}<p className="muted">담당 부서가 명부를 관리합니다. 비활성화한 인원의 과거 현황과 작업 기록은 보존됩니다.</p><fieldset disabled={saving || !canWrite}>
      {entries.length ? entries.map((entry,index) => <div className="roster-row" key={entry.personRef ?? 'new-' + index}><label className="field"><span>인원 표시명</span><input maxLength={100} value={entry.displayName} onChange={e => change(entries.map((item,itemIndex) => itemIndex === index ? { ...item, displayName: e.target.value } : item))} /></label><label className="check"><input type="checkbox" checked={entry.active !== false} onChange={e => change(entries.map((item,itemIndex) => itemIndex === index ? { ...item, active: e.target.checked } : item))} />활성</label>{!entry.personRef && <button onClick={() => change(entries.filter((_,itemIndex) => index !== itemIndex))}>추가 취소</button>}</div>) : <p className="empty">등록된 명부가 없습니다.</p>}
      {canWrite && <div className="save-context"><p className="muted">저장 대상: {department} 명부</p><div className="actions"><button onClick={() => change([...entries, { displayName:'',active:true }])}>인원 추가</button><button className="primary" onClick={() => void save()} disabled={conflict || saving || result.loading}>{saving ? '저장 중…' : '명부 저장'}</button></div></div>}
    </fieldset>{!canWrite && <p className="muted">명부 수정은 해당 부서 담당자 권한이 필요합니다.</p>}{message && <p className={failed ? 'error' : 'notice'} role={failed ? 'alert' : 'status'}>{message}</p>}{draft !== null && !message && <p className="draft-status" role="status">저장하지 않은 명부 변경이 있습니다.</p>}{conflict && <button onClick={() => { setDraft(null); setConflict(false); setMessage(''); setFailed(false); result.reload(); }}>입력 취소 후 최신 명부 조회</button>}</section>}
  </>;
}
export function PersonnelView({ actor, api, run, revision }: { actor: Actor; api: ApiClient; run: RunCommand; revision: number }) {
  const [date, setDate] = useState(seoulDate());
  const result = useResource<PersonnelDay>(signal => api.getPersonnel({ date }, signal), [api, date, revision]);
  const [draft, setDraft] = useState<Record<string,string|null> | null>(null), [baseRevision, setBaseRevision] = useState(0), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false);
  const [failed,setFailed] = useState(false);
  const { saving, submit } = useSubmission(run);
  useUnsavedChanges(draft !== null);
  const own = result.data?.departments.find(item => item.department === actor.department);
  const current = currentOperationalResource(result,'date',date);
  const save = async () => {
    if (!own || !current || !actor.departmentManager) return;
    setMessage(''); setFailed(false);
    const response = await submit('saveDailyPersonnel', { department: actor.department, date, entries: dailyPersonnelEntries(own.entries,draft) }, undefined, draft === null ? own.revision : baseRevision);
    if (!response) return;
    setMessage(saveMessage(response, `${actor.department} · ${date} 병력 현황을 저장했습니다.`)); setFailed(!response.ok); setConflict(!response.ok && response.errorCode === 'CONFLICT'); if (response.ok) { setDraft(null); result.reload(); }
  };
  return <><div className="page-head"><h1>일일 병력 현황</h1><button onClick={result.reload}>새로고침</button></div><label className="field limited-field"><span>기준 날짜</span><input type="date" value={date} onChange={e => { if (!e.target.value || (draft && !window.confirm('저장하지 않은 현황이 있습니다. 날짜를 바꿀까요?'))) return; setDraft(null); setConflict(false); setDate(e.target.value); setMessage(''); }} /></label><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {result.data && <p className={current ? 'muted' : 'notice'}>표시 기준일: {result.data.date}{!current ? ' · 마지막 성공 조회 결과입니다. 선택한 날짜의 조회가 성공하기 전에는 수정할 수 없습니다.' : ''}</p>}
    {result.data?.departments.map(department => <section className="card section-gap" key={department.department}>
      <div className="row-head"><h2>{department.department}</h2><span className="badge">{department.submitted ? '입력됨' : '미입력'}</span></div>
      {department.entries.length ? <><p className="muted">{['leave','trip','available'].map(status => statusLabels[status] + ' ' + department.entries.filter(entry => entry.status === status).length).join(' · ')} · 미입력 {department.entries.filter(entry => !entry.status).length}</p><div className="table-wrap"><table><thead><tr><th>인원</th><th>현황</th></tr></thead><tbody>{department.entries.map(entry => <tr key={entry.personRef}><td>{entry.displayName}</td><td>{actor.departmentManager && department.department === actor.department ? <select aria-label={entry.displayName + ' 현황'} disabled={saving || conflict || !current} value={(draft && Object.hasOwn(draft,entry.personRef) ? draft[entry.personRef] : entry.status) ?? ''} onChange={e => { if (draft === null) setBaseRevision(department.revision); setDraft({ ...draft, [entry.personRef]:e.target.value || null }); setMessage(''); setFailed(false); }}><option value="">미입력</option>{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select> : statusLabels[entry.status ?? ''] ?? '미입력'}</td></tr>)}</tbody></table></div></> : <p className="empty">등록된 명부가 없습니다. 입력 상태를 가용으로 추정하지 않습니다.</p>}
      {actor.departmentManager && department.department === actor.department && <div className="save-context">
        <p className="muted">저장 대상: {actor.department} · 기준일 {date}</p>
        {department.entries.length > 0 && <button className="primary" onClick={() => void save()} disabled={saving || conflict || !current}>{saving ? '저장 중…' : '현황 저장'}</button>}
        {message && <p className={failed ? 'error' : 'notice'} role={failed ? 'alert' : 'status'}>{message}</p>}
        {draft !== null && !message && <p className="draft-status" role="status">저장하지 않은 병력 현황 변경이 있습니다.</p>}
        {conflict && <button onClick={() => { setDraft(null); setConflict(false); setMessage(''); setFailed(false); result.reload(); }}>입력 취소 후 최신 현황 조회</button>}
      </div>}
    </section>)}
  </>;
}
export function NightDutyView({ actor, api, run, revision }: { actor: Actor; api: ApiClient; run: RunCommand; revision: number }) {
  const [date, setDate] = useState(seoulDate());
  const result = useResource<NightDutyDay>(signal => api.getNightDuty({ date }, signal), [api, date, revision]);
  const roster = useResource<Roster>(signal => api.getRoster(actor.department, signal), [api, actor.department, revision]);
  const [draft, setDraft] = useState<string[] | null>(null), [baseRevision, setBaseRevision] = useState(0), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false);
  const [failed,setFailed] = useState(false);
  const { saving, submit } = useSubmission(run); useUnsavedChanges(draft !== null);
  const own = result.data?.departments.find(item => item.department === actor.department);
  const current = currentOperationalResource(result,'date',date);
  const currentRoster = currentOperationalResource(roster,'department',actor.department);
  const selected = draft ?? own?.entries.map(entry => entry.personRef) ?? [];
  const people = [...(roster.data?.entries.filter(person => person.active !== false) ?? []), ...(own?.entries ?? []).filter(person => !roster.data?.entries.some(entry => entry.personRef === person.personRef && entry.active !== false))];
  const save = async () => {
    if (!own || !current || !currentRoster || !actor.departmentManager) return;
    setMessage(''); setFailed(false);
    const response = await submit('saveNightDuty', { department:actor.department, date, personRefs:selected }, undefined, draft === null ? own.revision : baseRevision);
    if (!response) return;
    setMessage(saveMessage(response, `${actor.department} · ${date} 야간 근무 현황을 저장했습니다.`)); setFailed(!response.ok); setConflict(!response.ok && response.errorCode === 'CONFLICT'); if (response.ok) { setDraft(null); result.reload(); }
  };
  return <><div className="page-head"><h1>야간 근무자 현황</h1><button onClick={result.reload}>새로고침</button></div><label className="field limited-field"><span>근무 시작일</span><input type="date" value={date} onChange={e => { if (!e.target.value || (draft && !window.confirm('저장하지 않은 근무자 변경이 있습니다. 날짜를 바꿀까요?'))) return; setDraft(null); setConflict(false); setDate(e.target.value); setMessage(''); }} /></label><p className="muted">야간 근무가 없는 부서는 입력을 생략할 수 있습니다. 미입력은 근무 없음 확인과 구별됩니다.</p><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />
    {result.data && <p className={current ? 'muted' : 'notice'}>표시 기준일: {result.data.date}{!current ? ' · 마지막 성공 조회 결과입니다. 선택한 날짜의 조회가 성공하기 전에는 수정할 수 없습니다.' : ''}</p>}
    {result.data?.departments.map(department => <section className="card section-gap" key={department.department}>
      <div className="row-head"><h2>{department.department}</h2><span className="badge">{department.submitted ? '입력됨' : '미입력'}</span></div>
      {department.entries.length ? <p>{department.entries.map(person => person.displayName).join(', ')}</p> : <p className="muted">{department.submitted ? '등록된 근무자 없음' : '현황 미입력'}</p>}
      {actor.departmentManager && department.department === actor.department && <>
        <fieldset disabled={saving || conflict || !current || !currentRoster}><legend>근무자</legend><ResourceStatus loading={roster.loading} error={roster.error} retry={roster.reload} />{people.map(person => <label className="check" key={person.personRef}><input type="checkbox" checked={selected.includes(person.personRef)} onChange={e => { if (draft === null) setBaseRevision(department.revision); setDraft(e.target.checked ? [...selected,person.personRef] : selected.filter(ref => ref !== person.personRef)); setMessage(''); setFailed(false); }} />{person.displayName}{person.active === false ? ' · 비활성' : ''}</label>)}{!roster.loading && !roster.error && !people.length && <p className="empty">등록된 명부가 없습니다.</p>}</fieldset>
        <div className="save-context"><p className="muted">저장 대상: {actor.department} · 근무 시작일 {date}</p><button className="primary" onClick={() => void save()} disabled={saving || conflict || !current || !currentRoster}>{saving ? '저장 중…' : '야간 근무 저장'}</button>
          {message && <p className={failed ? 'error' : 'notice'} role={failed ? 'alert' : 'status'}>{message}</p>}
          {draft !== null && !message && <p className="draft-status" role="status">저장하지 않은 야간 근무 변경이 있습니다.</p>}
          {conflict && <button onClick={() => { setDraft(null); setConflict(false); setMessage(''); setFailed(false); result.reload(); }}>입력 취소 후 최신 현황 조회</button>}
        </div>
      </>}
    </section>)}
  </>;
}
