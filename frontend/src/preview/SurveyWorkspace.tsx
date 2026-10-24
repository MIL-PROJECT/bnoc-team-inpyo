import { displayTime } from '../app/dateTime.mjs';
import { useState, type ReactNode } from 'react';
import type { Actor } from '../types';
import { Button } from '../ui/Button';
import { StatusGuide, StatusProcess } from './StatusGuide';
import { readRequest, bindPreviewContext } from './surveyStore.mjs';
import './survey.css';
import { TeamManagement } from './TeamManagement';
import { DocumentViewer } from './DocumentViewer';
import { PreviewDialog } from './PreviewDialog';
import { SurveyRequestList } from './SurveyRequestList';
import { SurveyRequestForm } from './SurveyRequestForm';
export function SurveyWorkspace({route,actor,teams,go,fallback}:{route:string;actor:Actor;teams:string[];go:(path:string,saved?:boolean)=>void;fallback:ReactNode}) {
  bindPreviewContext(actor,teams);
  const [editing,setEditing]=useState(false),[documentId,setDocumentId]=useState('');
  if(['roster','personnel','night-duty'].includes(route))return <TeamManagement key={route} kind={route} actor={actor} go={go}/>;
  if(route==='new'||route==='after-action') { const allowed=route==='after-action'?actor.role==='team':['requester','bnoc'].includes(actor.role); return allowed?<SurveyRequestForm key={route} actor={actor} afterAction={route==='after-action'} onSaved={number=>go('requests/'+number,true)}/>:<p role="alert">현재 역할로 신청을 등록할 수 없습니다.</p>; }
  if(route==='requests') return <SurveyRequestList actor={actor} go={go}/>;
  if(route.startsWith('requests/')) {
    let item:any;try {item=readRequest(route.slice(9));}catch{return <section className="card"><h1>신청을 조회할 수 없습니다</h1><Button onClick={()=>go('requests')}>목록으로</Button></section>;}
    if(editing) return <SurveyRequestForm actor={actor} existing={item} onSaved={()=>{setEditing(false);}}/>;
    const ownWorkStatus=actor.role==='team'&&item.participation==='current'?item.myTeamWorkStatus:null;
    const departments=item.progress?.departments??[];
    const showDepartmentProgress=!ownWorkStatus&&departments.length>0;
    const requestClassification=[item.category,item.systemType,item.resourceType,item.workType].filter(Boolean).join(' · ');
    return <>{documentId&&<PreviewDialog title="첨부문서" onClose={()=>setDocumentId('')}><DocumentViewer number={item.number} documentId={documentId}/></PreviewDialog>}<div className="page-head"><div><small>요청 {item.number}</small><h1>{item.title}</h1></div><Button onClick={()=>go('requests')}>목록으로</Button></div><div className={ownWorkStatus?'survey-progress-pair':undefined}><StatusProcess status={item.status} afterAction={item.origin==='after-action'}/>{ownWorkStatus&&<StatusProcess status={ownWorkStatus} work/>}</div>{ownWorkStatus&&departments.some((entry:any)=>entry.department!==actor.teamId)&&<p className="muted survey-other-progress" role="group" aria-label="다른 부서 진행">다른 부서: {departments.filter((entry:any)=>entry.department!==actor.teamId).map((entry:any)=><span key={entry.department}>{entry.department} <StatusGuide status={entry.status} work afterAction={item.origin==='after-action'} department={entry.department}/></span>)}</p>}{showDepartmentProgress&&<section className="card section-gap" aria-label="부서별 진행"><h2>부서 진행</h2><ul>{departments.map((entry:any)=><li key={entry.department}>{entry.department} <StatusGuide status={entry.status} work afterAction={item.origin==='after-action'} department={entry.department}/></li>)}</ul></section>}<section className="card section-gap"><h2>요청 내용</h2>{requestClassification&&<p className="survey-request-classification">요청 분류: {requestClassification}</p>}<p className="survey-preformatted">{item.detail}</p>{['requester','bnoc'].includes(actor.role)&&['대기','문서 대기'].includes(item.status)&&<Button onClick={()=>setEditing(true)}>신청 수정</Button>}<p>작업 위치: {item.location}</p><p>연락처: {item.contact}</p>{item.schedulePreferences?.map((choice:any)=><p key={choice.rank}>희망 일정 {choice.rank}지망: {choice.date} {choice.period==='AM'?'오전':'오후'}</p>)}{item.documentRef&&<p>관련 문서: {item.documentRef}</p>}{item.requesterDisplayText&&<p>실제 요청자: {item.requesterDisplayText}</p>}{item.maintenanceTarget&&<p>정비대상자: {Object.values(item.maintenanceTarget).join(' · ')}</p>}{item.origin==='after-action'&&<div><p>실제 시작 시각: {item.actualStartedAt?displayTime(item.actualStartedAt):'기록 없음'}</p><p>실제 완료 시각: {item.actualCompletedAt?displayTime(item.actualCompletedAt):'기록 없음'}</p>{item.reason&&<p>선조치 사유: {item.reason}</p>}{item.completionMemo&&<p>완료 메모: {item.completionMemo}</p>}<p>실제 요청자: {item.actualRequesterText??'기존 기록'}</p></div>}{(item.teamIds?.length||item.teamId)&&<p>담당 부서: {(item.teamIds??[item.teamId]).filter(Boolean).join(' · ')}</p>}</section>{Boolean(item.documents?.length)&&<section className="card section-gap"><h2>첨부문서</h2><p className="muted">파일을 열면 본문과 문서 정보를 함께 확인할 수 있습니다.</p>{item.documents.map((document:any)=><div className="section-gap" key={document.id}><Button onClick={()=>setDocumentId(document.id)}>{document.name} · 문서 보기</Button></div>)}</section>}</>;
  }
  return <>{fallback}</>;
}
