import {PhoneInput} from '../ui/PhoneInput';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Actor } from '../types';
import type { ApiClient } from '../api/apiClient.mjs';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/DateInput';
import { ActionGroup } from '../ui/ActionGroup';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { clearCommandRetry, commandForRetry, commandResultUnknown } from '../api/commandRetry.mjs';
import { absenceKinds, absenceOn, seoulDate } from './mainFunctionsModel.mjs';
import { personCategories, personnelCategories, ranksByCategory, sortPersonnel, type Person, type Absence, type PersonCategory, type PersonnelSort } from './personnelModel';

type DirectoryEntry = { personRef:string;department:string;displayName:string;active:boolean;category?:PersonCategory|null;rank?:string|null;complete:boolean;serviceNumber?:string;internalPhone?:string;absences:{absenceRef:string;absenceType:string;startDate:string;endDate:string;revision:number}[] };
type AbsenceDraft = { absenceRef?:string;revision?:number;department:string;personId:string;kind:string;start:string;end:string };
type PersonDraft = { personRef?:string;category:PersonCategory|'';rank:string;name:string;serviceNumber:string;phone:string;team:string;active:boolean };
type Props = { actor:Actor;api:ApiClient;departments:string[];mode:'roster'|'personnel';revision?:number };
const emptyPerson = (team:string):PersonDraft => ({category:'병',rank:'이병',name:'',serviceNumber:'',phone:'',team,active:true});
const emptyAbsence = (department:string,date:string):AbsenceDraft => ({department,personId:'',kind:'휴가',start:date,end:date});

export function PersonnelRosterPreview({actor,api,departments:allDepartments,mode,revision=0}:Props) {
  const isBnoc=actor.role==='bnoc';
  const ownTeam=actor.teamId||actor.department;
  const departments=isBnoc?allDepartments:[ownTeam];
  const [department,setDepartment]=useState(isBnoc?'':ownTeam);
  const [date,setDate]=useState(seoulDate());
  const [people,setPeople]=useState<Person[]>([]);
  const [directoryEntries,setDirectoryEntries]=useState<DirectoryEntry[]>([]);
  const [absences,setAbsences]=useState<Absence[]>([]);
  const [directoryRevision,setDirectoryRevision]=useState(0);
  const [draftRevision,setDraftRevision]=useState(0);
  const [uncertain,setUncertain]=useState(false);
  const [summaryResult,setSummaryResult]=useState<{date:string;department:string|undefined;data:any}|null>(null);
  const latestReload=useRef(0);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState('');
  const [category,setCategory]=useState<PersonCategory|''>('');
  const [search,setSearch]=useState('');
  const [order,setOrder]=useState<PersonnelSort>('rank-desc');
  const editor=useRef<HTMLFormElement>(null);
  const focusEditor=()=>requestAnimationFrame(()=>editor.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled)')?.focus());
  const [panel,setPanel]=useState<'person'|'absence'|null>(null);
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState<PersonDraft>(()=>emptyPerson(departments[0]||''));
  const [absence,setAbsence]=useState<AbsenceDraft>(()=>emptyAbsence(departments[0]||'',date));
  const [error,setError]=useState('');
  const [receipt,setReceipt]=useState('');
  const [saving,setSaving]=useState(false);
  const [dirty,setDirty]=useState(false);
  const pendingPerson=useRef<{signature:string;operationId:string}|null>(null);const pendingAbsence=useRef<{signature:string;operationId:string}|null>(null);
  useUnsavedChanges(dirty||uncertain,uncertain);

  const reload=useCallback(async()=>{
    const request=++latestReload.current;
    setLoading(true);setLoadError('');
    try {
      const [directory,summary]=await Promise.all([api.getRoster(),mode==='personnel'?api.getPersonnel({date,department:department||undefined}):Promise.resolve(null)]);
      if(request!==latestReload.current)return;
      const entries=directory.entries as DirectoryEntry[];
      const rows=entries.filter(item=>item.category&&item.rank).map(item=>({
        id:item.personRef,team:item.department,name:item.displayName,rank:item.rank!,category:item.category!,
        serviceNumber:item.serviceNumber||'',phone:item.internalPhone||'',active:item.active,complete:item.complete
      } as Person&{active:boolean;complete:boolean}));
      setPeople(rows);
      setDirectoryEntries(entries);
      setAbsences(entries.flatMap(item=>item.absences.map(record=>({id:record.absenceRef,revision:record.revision,personId:item.personRef,kind:record.absenceType,start:record.startDate,end:record.endDate}))));
      setDirectoryRevision(Number(directory.revision)||0);
      setSummaryResult(mode==='personnel'&&summary?{date,department:department||undefined,data:summary}:null);
    } catch(failure) { if(request===latestReload.current)setLoadError(failure instanceof Error?failure.message:'명부를 불러오지 못했습니다.'); }
    finally { if(request===latestReload.current)setLoading(false); }
  },[api,date,department,mode]);
  useEffect(()=>{void reload();},[reload,revision]);

  const scoped=useMemo(()=>people.filter(person=>!department||person.team===department),[people,department]);
  const searched=scoped.filter(person=>`${person.rank} ${person.name} ${person.serviceNumber}`.toLocaleLowerCase('ko').includes(search.trim().toLocaleLowerCase('ko')));
  const filtered=sortPersonnel(searched.filter(person=>!category||person.category===category),order);
  const visibleAbsencePeople=sortPersonnel(people.filter(person=>person.team===absence.department));
  const resetPerson=()=>{setDraftRevision(directoryRevision);setDraft(emptyPerson(department||departments[0]||''));setEditing(false);setDirty(false);setError('');};
  const openPanel=(next:'person'|'absence')=>{
    if(uncertain||saving||loading||loadError)return;
    if(dirty&&!window.confirm('입력한 내용을 취소할까요?'))return;
    setPanel(current=>current===next?null:next);setReceipt('');setError('');setDirty(false);
    if(next==='person')resetPerson();
    else setAbsence(emptyAbsence(department||departments[0]||'',date));
    focusEditor();
  };
  const savePerson=async(event:FormEvent)=>{
    event.preventDefault();if(!isBnoc||saving)return;
    if(!draft.category||!draft.rank){setError('구분과 계급·직급을 선택하세요.');return;}
    setSaving(true);setError('');
    try {
      const command=commandForRetry(pendingPerson,{type:'saveCentralPerson',expectedRevision:draftRevision,payload:{...(draft.personRef?{personRef:draft.personRef}:{}),department:draft.team,category:draft.category,rank:draft.rank,displayName:draft.name.trim(),serviceNumber:draft.serviceNumber.trim(),internalPhone:draft.phone.trim(),active:draft.active}});
      await api.dispatch(command);clearCommandRetry(pendingPerson);setUncertain(false);
      setReceipt(`${draft.rank} ${draft.name.trim()} ${draft.personRef?'수정':'등록'}됨`);setPanel(null);setDirty(false);await reload();
    } catch(failure) { const unknown=commandResultUnknown(failure);setUncertain(unknown);if(!unknown)clearCommandRetry(pendingPerson);setError(failure instanceof Error?failure.message:'저장하지 못했습니다.'); }
    finally {setSaving(false);}
  };
  const saveAbsence=async(event:FormEvent)=>{
    event.preventDefault();if(!isBnoc||saving)return;
    if(!absence.personId||absence.end<absence.start){setError('인원과 부재 기간을 확인하세요.');return;}
    setSaving(true);setError('');
    try {
      const command=commandForRetry(pendingAbsence,{type:'saveAbsence',expectedRevision:absence.revision??0,payload:{...(absence.absenceRef?{absenceRef:absence.absenceRef}:{}),personRef:absence.personId,absenceType:absence.kind,startDate:absence.start,endDate:absence.end}});
      await api.dispatch(command);clearCommandRetry(pendingAbsence);setUncertain(false);
      setReceipt(absence.absenceRef?'부재 기간을 수정했습니다.':'부재 기간을 등록했습니다.');setPanel(null);setDirty(false);await reload();
    } catch(failure) { const unknown=commandResultUnknown(failure);setUncertain(unknown);if(!unknown)clearCommandRetry(pendingAbsence);setError(failure instanceof Error?failure.message:'저장하지 못했습니다.'); }
    finally {setSaving(false);}
  };
  const summary=summaryResult?.date===date&&summaryResult.department===(department||undefined)?summaryResult.data:null;
  const counts=summary?.departments as {department:string;total:number;current:number;absent:number;byAbsenceType:Record<string,number>}[]|undefined;
  const groupedDepartments=departments.filter(team=>filtered.some(person=>person.team===team));
  const incompleteEntries=directoryEntries.filter(item=>!item.category||!item.rank||!item.complete);
  const editAbsence=(person:DirectoryEntry,record:DirectoryEntry['absences'][number])=>{
    if(uncertain||saving||loading||loadError)return;
    if(dirty&&!window.confirm('입력한 내용을 취소할까요?'))return;
    setAbsence({absenceRef:record.absenceRef,revision:record.revision,department:person.department,personId:person.personRef,kind:record.absenceType,start:record.startDate,end:record.endDate});
    setPanel('absence');setReceipt('');setError('');setDirty(false);focusEditor();
  };
  return <div className="main-preview-stack">
    <div className="page-head"><h1>{mode==='personnel'?'일일 병력 현황':'부대 인원 명부'}</h1><Button disabled={uncertain||saving||dirty} onClick={()=>void reload()}>새로고침</Button></div>
    <div className="personnel-toolbar">
      <label className="field"><span>부서</span><select value={department} onChange={event=>setDepartment(event.target.value)}><option value="">{isBnoc?'전체 부서':ownTeam}</option>{isBnoc&&departments.map(team=><option key={team}>{team}</option>)}</select></label>
      <label className="field personnel-search"><span>인원 검색</span><input type="search" placeholder={isBnoc?'이름·계급·군번':'이름·계급'} value={search} onChange={event=>setSearch(event.target.value)}/></label>
      <label className="field"><span>정렬</span><select aria-label="정렬" value={order} onChange={event=>setOrder(event.target.value as PersonnelSort)}><option value="rank-desc">계급 높은 순</option><option value="rank-asc">계급 낮은 순</option><option value="name">이름순</option></select></label>
      {mode==='personnel'&&<label className="field"><span>기준일</span><DateInput required value={date} onChange={event=>{if(event.target.value)setDate(event.target.value);}}/></label>}
      {isBnoc&&<ActionGroup className="personnel-tools"><Button aria-expanded={panel==='person'} disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>openPanel('person')}>인원 등록</Button><Button aria-expanded={panel==='absence'} disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>openPanel('absence')}>부재 등록</Button></ActionGroup>}
    </div>
    {mode==='personnel'&&summary&&counts&&<section className="personnel-summary" aria-label={`${summaryResult?.date} 일일 병력 현황`}><div className="personnel-counts"><span>총원 <strong>{summary.total}</strong></span><span>현재원 <strong>{summary.current}</strong></span>{summary.absent>0&&<span className="exception">결원 <strong>{summary.absent}</strong></span>}</div>{!department&&counts.length>1&&<details><summary>부서별 병력</summary><div className="table-wrap"><table><thead><tr><th>부서</th><th>총원</th><th>현재원</th><th>부재</th></tr></thead><tbody>{counts.map(item=><tr key={item.department}><th scope="row">{item.department}</th><td>{item.total}</td><td>{item.current}</td><td>{absenceKinds.filter(kind=>item.byAbsenceType[kind]).map(kind=>`${kind} ${item.byAbsenceType[kind]}`).join(' · ')||'—'}</td></tr>)}</tbody></table></div></details>}</section>}

    <div className="personnel-categories" role="group" aria-label="인원 구분">{(['',...personCategories] as const).map(value=><Button key={value||'all'} aria-pressed={category===value} onClick={()=>setCategory(value)}>{value||'전체'} <span className="count">{searched.filter(person=>!value||person.category===value).length}</span></Button>)}</div>
    {receipt&&<p className="summary-strip" role="status">{receipt}</p>}
    {loadError&&<p role="alert" className="error">{loadError} <Button onClick={()=>void reload()}>다시 불러오기</Button></p>}
    {loading&&!people.length&&<p role="status">불러오는 중…</p>}
    {panel==='person'&&isBnoc&&<form ref={editor} className="card personnel-editor" onSubmit={savePerson} onChangeCapture={()=>setDirty(true)}><div className="row-head"><h2>{editing?'인원 정보 수정':'인원 등록'}</h2><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{setPanel(null);resetPerson();}}>닫기</Button></div><fieldset className="personnel-inputs" disabled={saving||uncertain} style={{border:0,padding:0,minWidth:0}}>
      <label className="field"><span>구분</span><select required value={draft.category} onChange={event=>{const value=event.target.value as PersonCategory|'';setDraft({...draft,category:value,rank:''});}}><option value="">구분 선택</option>{personCategories.map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>{draft.category==='군무원'?'직급':'계급'}</span><select required disabled={!draft.category} value={draft.rank} onChange={event=>setDraft({...draft,rank:event.target.value})}><option value="">계급·직급 선택</option>{draft.category&&ranksByCategory[draft.category].map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>이름</span><input required value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
      <label className="field"><span>소속 부서</span><select required value={draft.team} onChange={event=>setDraft({...draft,team:event.target.value})}>{departments.map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>군번</span><input required value={draft.serviceNumber} onChange={event=>setDraft({...draft,serviceNumber:event.target.value})}/></label>
      <label className="field"><span>군내전화</span><PhoneInput value={draft.phone} onChange={event=>setDraft({...draft,phone:event.target.value})}/></label>
      <label className="check"><input type="checkbox" checked={draft.active} onChange={event=>setDraft({...draft,active:event.target.checked})}/>활성 인원</label>
    </fieldset>{error&&<p className="error" role="alert">{error}</p>}<ActionGroup><Button type="submit" variant="primary" disabled={saving}>{saving?'저장 중…':uncertain?'저장 결과 다시 확인':'저장'}</Button><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{setPanel(null);resetPerson();}}>취소</Button></ActionGroup></form>}
    {panel==='absence'&&isBnoc&&<form ref={editor} className="card personnel-editor" onSubmit={saveAbsence} onChangeCapture={()=>setDirty(true)}><div className="row-head"><h2>{absence.absenceRef?'부재 기간 수정':'부재 기간 등록'}</h2><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{setPanel(null);setDirty(false);}}>닫기</Button></div><fieldset className="personnel-inputs" disabled={saving||uncertain} style={{border:0,padding:0,minWidth:0}}>
      <label className="field"><span>대상 부서</span><select disabled={Boolean(absence.absenceRef)} value={absence.department} onChange={event=>setAbsence({...absence,department:event.target.value,personId:''})}>{departments.map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>인원</span><select required value={absence.personId} onChange={event=>setAbsence({...absence,personId:event.target.value})}><option value="">인원 선택</option>{visibleAbsencePeople.map(person=><option key={person.id} value={person.id}>{person.rank} {person.name} · {person.category}</option>)}</select></label>
      <label className="field"><span>구분</span><select value={absence.kind} onChange={event=>setAbsence({...absence,kind:event.target.value})}>{absenceKinds.map(value=><option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>시작일</span><DateInput required value={absence.start} onChange={event=>setAbsence({...absence,start:event.target.value})}/></label>
      <label className="field"><span>종료일</span><DateInput required min={absence.start} value={absence.end} onChange={event=>setAbsence({...absence,end:event.target.value})}/></label>
    </fieldset>{error&&<p className="error" role="alert">{error}</p>}<ActionGroup><Button type="submit" variant="primary" disabled={saving}>{saving?'저장 중…':uncertain?'저장 결과 다시 확인':absence.absenceRef?'수정':'등록'}</Button><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{setPanel(null);setDirty(false);}}>취소</Button></ActionGroup></form>}
    {!loading&&!filtered.length&&<p className="empty">{people.length?'검색 결과 없음':'등록된 인원이 없습니다.'}</p>}
    {groupedDepartments.map(team=><section className="card personnel-department" key={team} aria-label={`${team} 인원`}><div className="row-head"><h2>{team}</h2><span className="count">{filtered.filter(person=>person.team===team).length}명</span></div><div className="table-wrap"><table><thead><tr><th>계급·직급</th><th>이름</th>{isBnoc&&<th>군번</th>}<th>군내전화</th><th>{mode==='personnel'?`${date} 부재`:'부재 기간'}</th>{isBnoc&&<th>관리</th>}</tr></thead>{personnelCategories(order).map(group=>{
      const rows=filtered.filter(person=>person.team===team&&person.category===group);
      return rows.length>0&&<tbody key={group} aria-label={`${team} ${group}`}><tr className="personnel-group"><th colSpan={isBnoc?6:4} scope="rowgroup">{group} <span>{rows.length}명</span></th></tr>{rows.map(person=>{
        const records=mode==='personnel'?[absenceOn(absences,person.id,date)].filter(Boolean) as Absence[]:absences.filter(item=>item.personId===person.id).sort((a,b)=>a.start.localeCompare(b.start));
        const active=(person as Person&{active?:boolean}).active!==false;
        const directoryPerson=directoryEntries.find(item=>item.personRef===person.id);
        return <tr key={person.id} className={!active?'personnel-inactive':''}><td>{person.rank}</td><td>{person.name}{!active&&<small className="badge">비활성</small>}</td>{isBnoc&&<td>{person.serviceNumber||'—'}</td>}<td>{person.phone||'—'}</td><td>{records.length?records.map(record=>{const source=directoryPerson?.absences.find(item=>item.absenceRef===record.id);return <span className="personnel-absence" key={record.id}>{record.kind}{mode==='roster'&&` · ${record.start.slice(5)}~${record.end.slice(5)}`}{isBnoc&&directoryPerson&&source&&<Button disabled={uncertain||saving||loading||Boolean(loadError)} aria-label={`${record.kind} ${record.start} 부재 수정`} onClick={()=>editAbsence(directoryPerson,source)}>수정</Button>}</span>;}):'—'}</td>{isBnoc&&<td><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{if(dirty&&!window.confirm('입력한 내용을 취소할까요?'))return;setDirty(false);setDraftRevision(directoryRevision);setDraft({personRef:person.id,category:person.category,rank:person.rank,name:person.name,serviceNumber:person.serviceNumber,phone:person.phone,team:person.team,active});setEditing(true);setPanel('person');setError('');setReceipt('');focusEditor();}}>수정</Button></td>}</tr>;
      })}</tbody>;
    })}</table></div></section>)}
    {isBnoc&&incompleteEntries.length>0&&<section className="card personnel-department" aria-label="정보 보완이 필요한 인원"><div className="row-head"><h2>정보 보완 필요</h2><span className="count">{incompleteEntries.length}명</span></div><div className="table-wrap"><table><thead><tr><th>소속 부서</th><th>이름</th><th>계급·직급</th><th>군번</th><th>관리</th></tr></thead><tbody>{incompleteEntries.map(person=><tr key={person.personRef}><td>{person.department}</td><td>{person.displayName}</td><td>{person.rank||'미입력'}</td><td>{person.serviceNumber||'미입력'}</td><td><Button disabled={uncertain||saving||loading||Boolean(loadError)} onClick={()=>{if(dirty&&!window.confirm('입력한 내용을 취소할까요?'))return;setDirty(false);setDraftRevision(directoryRevision);setDraft({personRef:person.personRef,category:person.category||'',rank:person.rank||'',name:person.displayName,serviceNumber:person.serviceNumber||'',phone:person.internalPhone||'',team:departments.includes(person.department)?person.department:departments[0]||'',active:person.active});setEditing(true);setPanel('person');setError('');setReceipt('');focusEditor();}}>정보 입력</Button></td></tr>)}</tbody></table></div></section>}
  </div>;
}
