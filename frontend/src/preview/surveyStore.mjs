import { schedulePreferencesFromInput } from '../api/schedulePreferences.mjs';
import { localInputToUtc } from '../app/dateTime.mjs';
import { documentFixtures } from './documentFixtures.mjs';
// Business fixtures only. Authentication and account selection use the existing application.
let actor = null;
export let teams = [];
const initialRequests = () => [
  { number:'101', owner:'requester', title:'회의실 마이크 연결 지원', detail:'마이크 연결과 음향 점검이 필요합니다.', status:'작업 중', teamIds:['무선반','유선반'], progress:{currentDepartments:2,completedDepartments:0,departments:[{department:'무선반',status:'작업 중'},{department:'유선반',status:'배정'}]}, location:'회의실', category:'장비/체계', systemType:'인트라넷', workType:'지원', teamId:'무선반', contact:'000-0000', registeredAt:'2026-10-22', origin:'assigned' },
  { number:'102', owner:'requester', title:'문서 분석 상태 확인', detail:'첨부 문서 처리 상태를 확인합니다.', status:'문서 대기', location:'사무실', category:'장비/체계', systemType:'인트라넷', workType:'점검', contact:'000-0000', registeredAt:'2026-10-22' },
  { number:'103', owner:'requester', title:'완료 후보고', detail:'전화 연결 점검 완료', status:'완료', location:'사무실', category:'장비/체계', workType:'점검', teamId:'무선반', contact:'000-0000', registeredAt:'2026-10-22', origin:'after-action' },
  { number:'104', owner:'requester', title:'취소한 장비 이전 요청', detail:'이전 요청 취소', status:'취소', location:'사무실', category:'장비/체계', workType:'이전', contact:'000-0000', registeredAt:'2026-10-21' },
  { number:'105', owner:'other', title:'다른 요청자의 신청', detail:'범위 밖 요청', status:'대기', location:'사무실', category:'장비/체계', workType:'고장', contact:'000-0000', registeredAt:'2026-10-22' },
  { number:'106', owner:'requester', title:'PC와 전화 점검', detail:'PC와 전화 상태 점검 요청', status:'배정', progress:{currentDepartments:1,completedDepartments:0,departments:[{department:'무선반',status:'배정'}]}, location:'사무실', category:'장비/체계', workType:'점검', teamId:'무선반', contact:'000-0000', registeredAt:'2026-10-22' }
];
let requests = initialRequests().map(item=>({...item,documents:documentFixtures(item.number)}));
export function bindPreviewContext(serverActor,serverTeams) {
  if(!serverActor?.id || !Array.isArray(serverTeams))throw new Error('FORBIDDEN');
  if(actor?.id!==serverActor.id||actor?.role!==serverActor.role||actor?.teamId!==serverActor.teamId) {
    requests=initialRequests().map(item=>({...item,owner:item.owner==='requester'&&serverActor.role==='requester'?serverActor.id:item.owner,documents:documentFixtures(item.number)}));teamRecords={};
  }
  actor=structuredClone(serverActor);teams=[...serverTeams];
}
export function visibleRequests(subject=actor) {
  return requests.filter(item=>subject&&(subject.role==='bnoc'||subject.role==='requester'&&item.owner===subject.id||subject.role==='team'&&(item.teamIds?.includes(subject.teamId)||item.teamId===subject.teamId))).map(item=>{
    if(subject.role!=='team')return item;
    const own=item.progress?.departments?.find(entry=>entry.department===subject.teamId);
    return {...item,participation:own?'current':'none',myTeamWorkStatus:own?.status??null};
  });
}
export function readRequest(number) { const result=visibleRequests().find(item=>item.number===number); if(!result) throw new Error('NOT_FOUND'); return structuredClone(result); }
export function savePreviewRequest(input,afterAction=false,number) {
  if(!actor || (afterAction?actor.role!=='team':!['requester','bnoc'].includes(actor.role)))throw new Error('FORBIDDEN');
  const existing=number?readRequest(number):null;
  if(existing&& !['대기','문서 대기'].includes(existing.status))throw new Error('INVALID_STATE');
  const record={...existing,schedulePreferences:afterAction?[]:schedulePreferencesFromInput(input),documentRef:input.documentRef,requesterDisplayText:input.requesterDisplayText||existing?.requesterDisplayText||actor.displayName,maintenanceTarget:input.differentTarget?{department:input.targetDepartment,rank:input.targetRank,name:input.targetName,phone:input.targetPhone}:undefined,...(afterAction?{actualRequesterText:input.actualRequesterText,actualStartedAt:localInputToUtc(input.actualStartedAt),actualCompletedAt:localInputToUtc(input.completedAt),reason:input.reason,completionMemo:input.completionMemo,completionConfirmed:input.completionConfirmed}:{}),number:number??String(Math.max(...requests.map(item=>Number(item.number)))+1),owner:existing?.owner??actor.id,title:existing?.title??`${input.category==='회의 지원'?input.meetingType:input.workType} 요청`,detail:input.detail,category:existing?.category??input.category,workType:existing?.workType??(input.category==='회의 지원'?input.meetingType:input.workType),systemType:existing?.systemType??input.systemType,resourceType:existing?.resourceType??input.resourceType,phoneType:existing?.phoneType??input.phoneType,equipmentId:input.equipmentId,location:input.location,contact:input.contact,registeredAt:existing?.registeredAt??new Date().toISOString().slice(0,10),documents:[...(existing?.documents??[]),...(input.files??[]).map(file=>({id:crypto.randomUUID(),name:file.name,format:file.name.split('.').pop().toLowerCase(),status:'pending',blocks:[],metadata:[],originalFile:file}))],status:afterAction?'완료':existing?.status??'대기',origin:afterAction?'after-action':'assigned',teamId:afterAction?actor.teamId:existing?.teamId};
  requests=existing?requests.map(item=>item.number===number?record:item):[...requests,record];return record.number;
}

export function canManageTeam(teamId,subject=actor) { return Boolean(subject?.role==='team'&&subject.teamId===teamId); }
export function readDocument(number,id) {
  const request=readRequest(number);const document=request.documents?.find(row=>row.id===id&&row.linked!==false);
  if(!document)throw new Error('NOT_FOUND');
  const contentExcluded=request.category==='회의 지원'&&['화상회의','일반회의'].includes(request.workType);
  return {...document,contentExcluded,canRetry:!contentExcluded&&['requester','bnoc'].includes(actor.role)&&['대기','문서 대기'].includes(request.status)};
}
export function retryDocument(number,id) {
  if(!readDocument(number,id).canRetry)throw new Error('FORBIDDEN');
  requests=requests.map(row=>row.number===number?{...row,documents:row.documents.map(doc=>doc.id===id?{...doc,status:'pending'}:doc)}:row);
}

let teamRecords={};
export function readTeamManagement(kind,teamId,date) {
  if(!actor||!['team','bnoc','admin'].includes(actor.role))throw new Error('FORBIDDEN');
  const roster=teamRecords[`roster:${teamId}:`]??[];
  if(kind==='roster')return structuredClone(roster);
  const saved=teamRecords[`${kind}:${teamId}:${date}`]??[];
  return roster.filter(person=>person.active).map(person=>({...person,...(saved.find(row=>row.personRef===person.personRef)??{})}));
}
export function saveTeamManagement(kind,teamId,date,rows) {
  if(!canManageTeam(teamId))throw new Error('FORBIDDEN');
  if(!['roster','personnel','night-duty'].includes(kind))throw new Error('VALIDATION');
  teamRecords[`${kind}:${teamId}:${kind==='roster'?'':date}`]=structuredClone(rows);
}
