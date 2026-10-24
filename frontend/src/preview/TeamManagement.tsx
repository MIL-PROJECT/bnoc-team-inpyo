import { useEffect, useState } from 'react';
import type { Actor } from '../types';
import { Button } from '../ui/Button';
import { ActionGroup } from '../ui/ActionGroup';
import { DateInput } from '../ui/DateInput';
import { useUnsavedChanges } from '../app/useUnsavedChanges';
import { canManageTeam, teams, readTeamManagement, saveTeamManagement } from './surveyStore.mjs';
export function TeamManagement({kind,actor,go}:{kind:string;actor:Actor;go:(path:string)=>void}) {
  const [team,setTeam]=useState(actor.teamId??teams[0]),[date,setDate]=useState(new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'})),[rows,setRows]=useState<any[]>([]),[name,setName]=useState(''),[dirty,setDirty]=useState(false),[message,setMessage]=useState('');
  const writable=canManageTeam(team,actor);useUnsavedChanges(dirty);
  useEffect(()=>{if(!['team','bnoc','admin'].includes(actor.role)){setRows([]);return;}setRows(readTeamManagement(kind,team,date));setDirty(false);setMessage('');setName('');},[kind,team,date,actor.id]);
  const select=(next:string,isDate=false)=>{if(dirty&&!window.confirm('저장하지 않은 변경을 버리고 조회 대상을 바꿀까요?'))return;isDate?setDate(next):setTeam(next);};
  const change=(index:number,key:string,value:any)=>{setRows(rows.map((row,i)=>index===i?{...row,[key]:value}:row));setDirty(true);setMessage('');};
  const save=()=>{try{saveTeamManagement(kind,team,date,rows);setDirty(false);setMessage(`${team} ${kind==='roster'?'명부를':date+' 현황을'} 저장했습니다.`);}catch{setMessage('현재 역할과 소속 부서를 확인하세요.');}};
  const title=kind==='roster'?'부서 명부':kind==='personnel'?'병력 현황':'야간 근무';
  if(!['team','bnoc','admin'].includes(actor.role))return <p role="alert">현재 역할로 조회할 수 없습니다.</p>;
  return <><div className="page-head"><div><small>{writable?'자기 반 관리':'부서 현황 조회'}</small><h1>{title}</h1></div>{writable&&<Button variant="primary" disabled={!dirty} onClick={save}>변경 저장</Button>}</div><section className="card"><div className="form-grid"><label className="field"><span>조회 부서</span><select value={team} onChange={event=>select(event.target.value)}>{teams.map(value=><option key={value}>{value}</option>)}</select></label>{kind!=='roster'&&<label className="field"><span>기준일</span><DateInput value={date} onChange={event=>{if(event.target.value)select(event.target.value,true);}}/></label>}</div><p className="notice">{writable?`${team} 소속 작업반 계정으로 관리합니다.`:'다른 부서의 현황을 조회합니다. 수정은 해당 작업반만 할 수 있습니다.'}</p>{dirty&&<p role="status">저장하지 않은 변경이 있습니다.</p>}{message&&<p role="status">{message}</p>}
    {writable&&kind==='roster'&&<form className="section-gap" onSubmit={event=>{event.preventDefault();if(!name.trim())return;setRows([...rows,{personRef:crypto.randomUUID(),displayName:name.trim(),active:true}]);setName('');setDirty(true);}}><label className="field"><span>명부 인원 성명</span><input value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></label><Button type="submit" disabled={!name.trim()}>명부에 추가</Button></form>}
    {rows.length?<div className="table-wrap section-gap"><table><thead><tr><th>성명</th><th>{kind==='roster'?'명부 상태':kind==='personnel'?'병력 상태':'야간 근무'}</th></tr></thead><tbody>{rows.map((row,index)=><tr key={row.personRef}><td>{row.displayName}</td><td>{kind==='roster'?<label className="check"><input disabled={!writable} type="checkbox" checked={row.active} onChange={event=>change(index,'active',event.target.checked)}/>활성</label>:kind==='personnel'?<label><span className="sr-only">{row.displayName} 병력 상태</span><select disabled={!writable} value={row.status??''} onChange={event=>change(index,'status',event.target.value||null)}><option value="">미입력</option><option value="available">현재원</option><option value="leave">휴가</option><option value="trip">출장</option></select></label>:<label className="check"><input disabled={!writable} type="checkbox" checked={row.selected??false} onChange={event=>change(index,'selected',event.target.checked)}/>야간 근무</label>}</td></tr>)}</tbody></table></div>:<div className="empty"><p>등록된 명부가 없습니다.</p>{kind!=='roster'&&writable&&<Button onClick={()=>go('roster')}>부서 명부 등록</Button>}</div>}
  </section></>;
}
