import { useRef, useState } from 'react';
import { focusFormError } from '../app/formFeedback.mjs';
import type { AccessAssignment, Actor, Role } from '../types';
import { ApiClient } from '../api/apiClient.mjs';
import { useResource } from '../app/useResource';
import { useSubmission } from '../app/useSubmission';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import type { RunCommand } from './RequestRegistrationForm';
import { ResourceStatus } from './ResourceStatus';
const roleLabels: Record<Role,string> = { requester:'요청자',bnoc:'BNOC',team:'작업반',admin:'권한 관리자' };
export function AccessManagementView({ actor, api, run, teams, departments, revision }: { actor: Actor; api: ApiClient; run: RunCommand; teams: string[]; departments: string[]; revision: number }) {
  const [page,setPage] = useState(0);
  const result = useResource<{ items: AccessAssignment[]; total: number }>(signal => api.getAccess(signal,{ page,size:20 }), [api,revision,page]);
  const [draft,setDraft] = useState<AccessAssignment | null>(null), [message,setMessage] = useState(''), [conflict,setConflict] = useState(false);
  const editor=useRef<HTMLElement>(null),feedback=useRef<HTMLParagraphElement>(null);
  const [failed,setFailed]=useState(false);
  const { saving,submit } = useSubmission(run); useUnsavedChanges(draft !== null);
  const save = async () => {
    if (!draft) return;
    setMessage('');setFailed(false);
    const response = await submit('changeAccess', { subjectRef:draft.subjectRef, role:draft.role, department:draft.department, ...(draft.teamId ? { teamId:draft.teamId } : {}), departmentManager:draft.departmentManager, active:draft.active }, undefined,draft.revision);
    if (!response) return;
    if (response.ok) { setDraft(null); setConflict(false); setMessage('권한을 저장했습니다. 다음 요청부터 적용됩니다.'); result.reload(); }
    else { setFailed(true);setConflict(response.errorCode === 'CONFLICT'); setMessage(response.message ?? '권한을 저장하지 못했습니다. 입력은 유지됩니다.'); }
    requestAnimationFrame(()=>{focusFormError(response.ok?null:editor.current,feedback.current);feedback.current?.scrollIntoView({block:'center'});});
  };
  return <><div className="page-head"><h1>서비스 권한 관리</h1><button onClick={result.reload}>새로고침</button></div><p className="muted">SSO 인증과 서비스 권한은 별도로 관리합니다. 자기 권한 상승은 허용되지 않습니다.</p><ResourceStatus loading={result.loading} error={result.error} retry={result.reload} />{message && !draft && <p ref={feedback} tabIndex={-1} className={failed?'error':'notice'} role={failed?'alert':'status'}>{message}</p>}
    {result.data && <div className="table-wrap access-list"><table><thead><tr><th>사용자</th><th>역할</th><th>부서</th><th>부서 관리</th><th>서비스 사용</th><th>변경</th></tr></thead><tbody>{result.data.items.map(item => <tr key={item.subjectRef}><td>{item.displayName}{item.subjectRef === actor.id && <small>현재 사용자</small>}</td><td>{roleLabels[item.role]}</td><td>{item.department}{item.teamId && item.teamId !== item.department ? ' · ' + item.teamId : ''}</td><td>{item.departmentManager ? '가능' : '없음'}</td><td>{item.active ? '허용' : '회수됨'}</td><td><button onClick={() => { if (draft && !window.confirm('저장하지 않은 권한 변경이 있습니다. 다른 사용자를 선택할까요?')) return; setDraft({ ...item }); setConflict(false);setFailed(false); setMessage('');requestAnimationFrame(()=>editor.current?.querySelector<HTMLElement>('select')?.focus()); }}>권한 변경</button></td></tr>)}</tbody></table></div>}
    {result.data && <div className="actions pagination"><button disabled={page === 0 || result.loading} onClick={() => setPage(value => value - 1)}>이전 페이지</button><span>{page + 1}페이지</span><button disabled={(page + 1) * 20 >= result.data.total || result.loading} onClick={() => setPage(value => value + 1)}>다음 페이지</button></div>}
    {draft && <section ref={editor} className="card section-gap access-editor"><h2>{draft.displayName} 권한</h2><fieldset disabled={saving}><div className="form-grid"><label className="field"><span>서비스 역할</span><select value={draft.role} onChange={e => { const role = e.target.value as Role; setDraft({ ...draft,role,teamId:role === 'team' ? draft.teamId : undefined }); }}>{Object.entries(roleLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>소속 부서</span><select value={draft.department} onChange={e => setDraft({ ...draft,department:e.target.value })}>{departments.map(item => <option key={item}>{item}</option>)}</select></label>{draft.role === 'team' && <label className="field"><span>작업반</span><select value={draft.teamId ?? ''} onChange={e => setDraft({ ...draft,teamId:e.target.value })}><option value="">선택</option>{teams.map(team => <option key={team}>{team}</option>)}</select></label>}</div><label className="check"><input type="checkbox" checked={draft.departmentManager} onChange={e => setDraft({ ...draft,departmentManager:e.target.checked })} />자기 부서 명부·현황 관리</label><label className="check"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft,active:e.target.checked })} />서비스 사용 허용</label><div className="actions"><button className="primary" onClick={() => void save()} disabled={saving || conflict}>{saving ? '저장 중…' : '권한 저장'}</button><button onClick={() => setDraft(null)}>변경 취소</button></div></fieldset>{(message||conflict) && <p ref={feedback} tabIndex={-1} className={failed?'error':'notice'} role={failed?'alert':'status'}>{conflict?'다른 권한 변경이 반영됐습니다. 입력 취소 후 최신 내용을 확인하세요.':message}</p>}</section>}
  </>;
}
