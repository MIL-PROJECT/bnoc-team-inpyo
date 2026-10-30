import { useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorCode, ServerSession, ViewCommandResult, SituationSnapshot, RequestDetail } from '../types';
import { ApiClient, ApiError } from '../api/apiClient.mjs';
import { errorMessage } from './useResource';
import { UnsavedChangesContext } from './useUnsavedChanges';
import { DepartmentContactApiContext } from '../ui/WorkflowStatus';
import { RequestRegistrationForm, initialInput, type RequestInput, type RunCommand } from '../screens/RequestRegistrationForm';
import { requestReuseFields } from './requestReuse.mjs';
import { AfterActionReportForm } from '../screens/AfterActionReportForm';
import {RequestReusePicker} from '../screens/RequestReusePicker';
import { RequestListAndSearch, initialRequestSearchState } from '../screens/RequestListAndSearch';
import { RequestDetailWorkspace } from '../screens/RequestDetailWorkspace';
import { TeamScheduleView, initialTeamScheduleSelection } from '../screens/TeamScheduleView';
import { BnocOverviewView } from '../screens/BnocOverviewView';
import { NotificationInbox } from '../screens/NotificationInbox';
import { SharedWorkOverview } from '../screens/SharedWorkOverview';
import { PersonnelView, NightDutyView, RosterView } from '../screens/PersonnelViews';
import { NoticeList, NoticeDetail, NoticeEditor } from '../screens/NoticeViews';
import { AccessManagementView } from '../screens/AccessManagementView';
import { PlannedMaintenanceView, clearPendingPlannedCreateRecovery } from '../screens/PlannedMaintenanceView';
import { LoginPanel } from '../screens/LoginPanel';
import { cpconStageValue } from './situationStage';
import { SurveyWorkspace } from '../preview/SurveyWorkspace';
import { MainFunctionsPreview } from '../preview/MainFunctionsPreview';
import { PersonnelRosterPreview } from '../preview/PersonnelRosterPreview';
import { MonthlyDutyPreview } from '../preview/MonthlyDutyPreview';
const surveyPreview = new URLSearchParams(window.location.search).get('preview') === 'survey';
const mainPreview = new URLSearchParams(window.location.search).get('preview') === 'main';
const api = new ApiClient();
type GlobalContext={ gps?:SituationSnapshot;cpcon?:SituationSnapshot;situationError:boolean;unseen?:number;unseenError:boolean;returned?:number;returnedError:boolean };
const emptyGlobalContext:GlobalContext={situationError:false,unseenError:false,returnedError:false};
const situationStateLabel:Record<string,string>={not_collected:'미수집',ok:'정상',failed:'갱신 실패',stale:'유효시간 초과',unconfigured:'미설정'};
const routeUrl = (path: string) => { const url = new URL(path === 'planned-maintenance' ? '/requests?view=planned-maintenance' : '/' + path, window.location.origin); if (surveyPreview) url.searchParams.set('preview','survey'); if (mainPreview) url.searchParams.set('preview','main'); return url.pathname + url.search; };
const routeFromPath = () => {
  if (new URLSearchParams(window.location.search).get('view') === 'planned-maintenance') return 'planned-maintenance';
  try { const path = decodeURIComponent(window.location.pathname).replace(/^\//,'').replace(/\/$/,''); return !path || path === 'login' ? 'requests' : path; }
  catch { return 'not-found'; }
};
export function App() {
  const [session,setSession] = useState<ServerSession | null>(null), [loading,setLoading] = useState(true), [sessionError,setSessionError] = useState('');
  const [expired,setExpired] = useState(false), [route,setRoute] = useState(routeFromPath), [revision,setRevision] = useState(0), [notice,setNotice] = useState('');
  const [choosingPrevious,setChoosingPrevious]=useState(false);
  const [requestSearchState,setRequestSearchState]=useState(initialRequestSearchState);
  const [scheduleSelection,setScheduleSelection]=useState(initialTeamScheduleSelection);
  const [overviewEntry,setOverviewEntry]=useState<{bucket:'assigned'|'returned';version:number}>({bucket:'assigned',version:0});
  const [globalContext,setGlobalContext]=useState<GlobalContext>(emptyGlobalContext);
  const requestContextVersion=useRef(0);
  const [routeReceipt,setRouteReceipt] = useState<{path:string;message:string} | null>(null);
  const [requestDraft,setRequestDraft]=useState<{key:string;actorId:string;sourceNumber:string;input:RequestInput}|null>(null);
  const [attachmentNavigation,setAttachmentNavigation] = useState<{requestNumber:string;attachmentId:string;searchTerm?:string;blockIndex?:number|null;metadataIndex?:number|null}|null>(null);
  const sessionRef = useRef<ServerSession | null>(null), expiredRef = useRef(false), dirty = useRef(new Set<string>()), blocked = useRef(new Set<string>()), routeRef = useRef(route);
  const expiryDialog = useRef<HTMLDialogElement | null>(null);
  const loadRequesters = useCallback(() => api.getRequesters(), []);
  const registerDirty = useCallback((id: string, value: boolean, blockLeaving = false) => {
    if (value) dirty.current.add(id); else dirty.current.delete(id);
    if (blockLeaving) blocked.current.add(id); else blocked.current.delete(id);
  }, []);
  const acceptSession = useCallback(async (next: ServerSession) => {
    const changingActor = sessionRef.current && (next.actor.id !== sessionRef.current.actor.id || next.actor.role !== sessionRef.current.actor.role);
    if (changingActor && blocked.current.size > 0) {
      await api.logout(); setNotice('저장 결과를 계획 화면에서 확인한 뒤 계정이나 권한을 바꿀 수 있습니다. 로그인 정보를 확인하세요.'); expiredRef.current = true; setExpired(true); return;
    }
    if (changingActor && dirty.current.size > 0 && !window.confirm('계정 또는 권한이 변경됐습니다. 저장하지 않은 입력을 버리고 계속할까요?')) {
      await api.logout(); setNotice('입력을 유지했습니다. 계정과 권한을 확인한 뒤 다시 로그인하세요.'); expiredRef.current = true; setExpired(true); return;
    }
    const changedUser = sessionRef.current?.actor.id !== next.actor.id;
    requestContextVersion.current++;
    if(changedUser || sessionRef.current?.actor.role!==next.actor.role) {setRequestDraft(null);setChoosingPrevious(false);setRequestSearchState(initialRequestSearchState());setScheduleSelection(initialTeamScheduleSelection());setOverviewEntry(previous=>({bucket:'assigned',version:previous.version+1}));}
    if (sessionRef.current && changedUser) clearPendingPlannedCreateRecovery();
    if (changingActor) { setRouteReceipt(null);setGlobalContext(emptyGlobalContext);setAttachmentNavigation(null); }
    sessionRef.current = next; setSession(next); expiredRef.current = false; setExpired(false); setSessionError(''); setLoading(false); setRevision(value => value + 1);
    if (changedUser && routeRef.current === 'after-action' && next.actor.role !== 'team') { window.history.replaceState({},'', '/requests'); routeRef.current = 'requests'; setRoute('requests'); }
  }, []);
  const loadSession = useCallback(async () => {
    setLoading(true); setSessionError('');
    try { await acceptSession(await api.session() as ServerSession); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) setSessionError(errorMessage(error instanceof Error ? error : new Error('서버 상태를 확인하지 못했습니다.'))); }
    finally { setLoading(false); }
  }, [acceptSession]);
  useEffect(() => {
    api.onUnauthenticated = () => { if (sessionRef.current) { expiredRef.current = true; setExpired(true); } };
    void loadSession();
    return () => { api.onUnauthenticated = null; };
  }, [loadSession]);
  useEffect(() => {
    const pop = () => {
      const next = routeFromPath();
      if (blocked.current.size > 0) { window.history.pushState({},'', routeUrl(routeRef.current)); setNotice('저장 결과를 계획 화면에서 확인한 뒤 이동할 수 있습니다.'); return; }
      if (dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 페이지를 이동할까요?')) { window.history.pushState({},'', routeUrl(routeRef.current)); return; }
      requestContextVersion.current++;routeRef.current = next; setRoute(next); setNotice(''); setRouteReceipt(null);setRequestDraft(null);setOverviewEntry(previous=>({bucket:'assigned',version:previous.version+1}));
    };
    const leave = (event: BeforeUnloadEvent) => { if (dirty.current.size > 0) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('popstate',pop); window.addEventListener('beforeunload',leave);
    return () => { window.removeEventListener('popstate',pop); window.removeEventListener('beforeunload',leave); };
  }, []);
  useEffect(() => { if (expired && expiryDialog.current && !expiryDialog.current.open) expiryDialog.current.showModal(); else if (!expired) expiryDialog.current?.close(); }, [expired]);
  const go = useCallback((path: string, saved = false, serverDetail = false, overviewBucket:'assigned'|'returned' = 'assigned') => {
    const sameRoute=path === routeRef.current;
    if (sameRoute && !serverDetail && overviewBucket!=='returned') return false;
    if (!saved && blocked.current.size > 0) { setNotice('저장 결과를 계획 화면에서 확인한 뒤 이동할 수 있습니다.'); return false; }
    if (!saved && dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 페이지를 이동할까요?')) return false;
    requestContextVersion.current++;
    if (serverDetail && surveyPreview) { window.location.assign('/' + path); return true; }
    if(!sameRoute || serverDetail) window.history.pushState({},'', routeUrl(path));
    setOverviewEntry(previous=>({bucket:overviewBucket,version:previous.version+1}));routeRef.current = path; setRoute(path); setNotice(''); setRouteReceipt(null); setRequestDraft(null);window.scrollTo(0,0);
    return true;
  }, []);
  const reuseRequest=useCallback(async(number:string)=>{
    const current=sessionRef.current,sourceRoute=routeRef.current,contextVersion=requestContextVersion.current;
    if(!current || current.actor.role!=='requester' || expiredRef.current) throw new Error('다시 로그인한 뒤 불러오세요.');
    const source=await api.getRequestDetail(number) as RequestDetail;
    if(requestContextVersion.current!==contextVersion || sessionRef.current?.actor.id!==current.actor.id || sessionRef.current?.actor.role!==current.actor.role || routeRef.current!==sourceRoute || expiredRef.current) return;
    if(!source.canReuse) throw new Error('본인이 직접 작성한 요청만 불러올 수 있습니다.');
    const input={...initialInput(current.actor),...requestReuseFields(source)} as RequestInput;
    if(sourceRoute==='new'){
      if(dirty.current.size>0&&!window.confirm('작성 중인 내용을 이전 신청 내용으로 바꿀까요?'))return;
      requestContextVersion.current++;
    }else if(!go('new'))return;
    setRequestDraft({key:crypto.randomUUID(),actorId:current.actor.id,sourceNumber:number,input});
  },[go]);
  const openSaved = (path:string,message?:string) => { go(path,true); setRouteReceipt(message ? {path,message} : null); };
  const run: RunCommand = useCallback(async (type,payload,target,expectedRevision,operationId) => {
    if (expiredRef.current || !sessionRef.current) return { ok:false,errorCode:'UNAUTHENTICATED',message:'다시 로그인한 뒤 저장을 눌러주세요. 입력은 유지됩니다.' };
    try {
      const response = await api.dispatch({ type,payload,requestNumber:target?.requestNumber,workNumber:target?.workNumber,expectedRevision,operationId:operationId ?? crypto.randomUUID() }) as ViewCommandResult;
      if (!response.ok) return response;
      setRevision(value => value + 1); setNotice(''); return response;
    } catch (error) {
      if (error instanceof ApiError) return { ok:false,errorCode:error.code as ErrorCode,message:error.message,fieldErrors:error.fieldErrors,refreshRequired:error.refreshRequired };
      return { ok:false,errorCode:'SAVE_FAILED',message:'저장 결과를 확인하지 못했습니다. 입력을 유지하고 같은 제출로 다시 시도하세요.' };
    }
  }, []);
  const refreshGlobalContext=useCallback(async()=>{
    const current=sessionRef.current;if(!current)return;
    const subject=current.actor.id,isBnoc=current.actor.role==='bnoc';
    const [situation,unseen,returned]=await Promise.allSettled([
      api.getSituation(),api.getNotificationUnseen(),isBnoc?api.getWorkOverview({bucket:'returned',page:0,size:1}):Promise.resolve(null)
    ]);
    if(sessionRef.current?.actor.id!==subject)return;
    setGlobalContext(previous=>({
      gps:situation.status==='fulfilled'?situation.value.gps:previous.gps,
      cpcon:situation.status==='fulfilled'?situation.value.cpcon:previous.cpcon,
      situationError:situation.status==='rejected',
      unseen:unseen.status==='fulfilled'?unseen.value.unseen:previous.unseen,
      unseenError:unseen.status==='rejected',
      returned:isBnoc?(returned.status==='fulfilled'?(returned.value?.counts?.returned ?? 0):previous.returned):undefined,
      returnedError:isBnoc && returned.status==='rejected'
    }));
  },[]);
  useEffect(()=>{
    if(!session)return;
    void refreshGlobalContext();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refreshGlobalContext();},30000);
    const refresh=()=>{if(document.visibilityState==='visible')void refreshGlobalContext();};
    document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);};
  },[session?.actor.id,revision,refreshGlobalContext]);
  const logout = async () => {
    if (blocked.current.size > 0) { setNotice('저장 결과를 계획 화면에서 확인한 뒤 로그아웃할 수 있습니다.'); return; }
    if (dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 로그아웃할까요?')) return;
    try { await api.logout(); setChoosingPrevious(false); clearPendingPlannedCreateRecovery(); requestContextVersion.current++;setRequestDraft(null);setRequestSearchState(initialRequestSearchState());setScheduleSelection(initialTeamScheduleSelection());setOverviewEntry(previous=>({bucket:'assigned',version:previous.version+1}));sessionRef.current = null; setSession(null);setGlobalContext(emptyGlobalContext); expiredRef.current = false; setExpired(false); dirty.current.clear(); setNotice(''); setRouteReceipt(null); const nextRoute = 'requests'; setRoute(nextRoute); routeRef.current = nextRoute; window.history.replaceState({},'', routeUrl(nextRoute)); }
    catch (error) { setNotice(errorMessage(error instanceof Error ? error : new Error('로그아웃하지 못했습니다.'))); }
  };
  if (loading && !session) return <main><p role="status">서비스 상태를 확인하는 중…</p></main>;
  if (!session) return <main>{sessionError ? <section className="card"><h1>서비스에 연결하지 못했습니다</h1><p className="error" role="alert">{sessionError}</p><button onClick={() => void loadSession()}>다시 연결</button></section> : <LoginPanel api={api} onAuthenticated={acceptSession} />}</main>;
  const actor = session.actor;
  const departmentAccess = actor.role === 'bnoc' || actor.role === 'team' || actor.role === 'admin' || actor.departmentManager;
  const menu = [
    ...(['requester','bnoc','team'].includes(actor.role) ? [['requests',actor.role === 'requester' ? '내 신청' : actor.role === 'bnoc' ? '신청 관리' : '관련 신청']] : []),
    ...(actor.role === 'requester' || actor.role === 'bnoc' ? [['new',actor.role === 'bnoc' ? '대리 등록' : '작업 신청']] : []),
    ...(actor.role === 'bnoc' ? [['overview','요청 현황(BNOC)']] : []),
    ...(actor.role === 'team' ? [['after-action','선조치 후보고']] : []),
    ...(actor.role === 'team' ? [['planned-maintenance','계획 정비']] : []),
    ['operations-status','정보통신 운용현황'],
    ['operations','부서별 작업 현황'],
    ['schedule',actor.role === 'bnoc' ? '정비 일정' : actor.role === 'team' ? '우리 반 일정' : '정비 달력'],
    ...(actor.role === 'bnoc' || actor.role === 'team' ? [['personnel','일일 병력 현황'],['night-duty','당직 야간근무 현황'],['roster','부대 인원 명부']] : []),
    ...(actor.role === 'requester' || actor.role === 'admin' ? [['night-duty','당직 야간근무 현황']] : []),
    ['notices','공지게시판'],['notifications','알림함'],
    ...(actor.accessAdmin || actor.role === 'admin' ? [['access','권한 관리']] : [])
  ];
  const navGroups = [
    { label: '업무', paths: ['requests','new','overview','after-action','planned-maintenance'] },
    { label: '부대 현황', paths: ['operations-status','operations','schedule','personnel','night-duty','roster'] },
    { label: '소통', paths: ['notices','notifications'] },
    { label: '관리', paths: ['access'] }
  ].map(group => ({ ...group, items: menu.filter(([path]) => group.paths.includes(path)) })).filter(group => group.items.length);
  const routeMatches = (path: string) => route === path || (path === 'requests' && route.startsWith('requests/')) || (path === 'notices' && route.startsWith('notices/'));
  const upload = (file: File) => api.uploadAttachment(file,'request');
  const onOpen = (number: string) => go('requests/' + encodeURIComponent(number),false,true);
  const forbidden = <section className="card"><h1>접근 권한이 없습니다</h1><p>현재 사용자의 허용 범위를 확인하세요.</p><button onClick={() => go('operations')}>부서별 작업 현황</button></section>;
  let content;
  if (route === 'operations-status') content = <MainFunctionsPreview actor={actor} api={api} />;
  else if (route === 'personnel' || route === 'roster') content = actor.role === 'bnoc' || actor.role === 'team' ? <PersonnelRosterPreview actor={actor} api={api} departments={session.departments} mode={route} revision={revision} /> : forbidden;
  else if (route === 'night-duty') content = ['bnoc','team','requester','admin'].includes(actor.role) ? <MonthlyDutyPreview actor={actor} api={api} teams={session.teams} revision={revision} /> : forbidden;
  else if (route.startsWith('requests/')) { const requestNumber=decodeURIComponent(route.slice('requests/'.length));content = <RequestDetailWorkspace key={route} onReuseRequest={reuseRequest} actor={actor} requestNumber={requestNumber} api={api} teams={session.teams} run={run} upload={upload} revision={revision} onBack={() => go('requests')} onAssigned={message => openSaved('overview',message)} initialMessage={routeReceipt?.path === route ? routeReceipt.message : undefined} initialAttachmentId={attachmentNavigation?.requestNumber===requestNumber?attachmentNavigation.attachmentId:undefined} initialAttachmentSearchTerm={attachmentNavigation?.requestNumber===requestNumber?attachmentNavigation.searchTerm:undefined} initialAttachmentBlockIndex={attachmentNavigation?.requestNumber===requestNumber?attachmentNavigation.blockIndex??undefined:undefined} initialAttachmentMetadataIndex={attachmentNavigation?.requestNumber===requestNumber?attachmentNavigation.metadataIndex??undefined:undefined} onAttachmentOpened={()=>setAttachmentNavigation(null)} />; }
  else if (route === 'new') content = actor.role === 'requester' || actor.role === 'bnoc' ? <RequestRegistrationForm onBrowsePrevious={()=>setChoosingPrevious(true)} key={`${actor.id}:${actor.role}:${requestDraft?.key??'new'}`} draftApi={api} initialDraft={requestDraft?.actorId===actor.id?requestDraft.input:null} sourceRequestNumber={requestDraft?.actorId===actor.id?requestDraft.sourceNumber:undefined} actor={actor} run={run} upload={upload} getRequesters={loadRequesters} onSaved={(number,message) => openSaved('requests/' + encodeURIComponent(number),message)} /> : forbidden;
  else if (route === 'after-action') content = actor.role === 'team' ? <AfterActionReportForm actor={actor} api={api} run={run} upload={upload} onSaved={(number,message) => openSaved('requests/' + encodeURIComponent(number),message)} /> : forbidden;
  else if (route === 'schedule') content = <TeamScheduleView key={`${actor.id}:${actor.role}`} actor={actor} query={api} revision={revision} onOpen={onOpen} selection={scheduleSelection} onSelectionChange={setScheduleSelection} />;
  else if (route === 'overview') content = actor.role === 'bnoc' ? <BnocOverviewView query={api} teams={session.teams} revision={revision} onOpen={onOpen} initialMessage={routeReceipt?.path === route ? routeReceipt.message : undefined} /> : forbidden;
  else if (route === 'operations') content = <SharedWorkOverview key={overviewEntry.version} initialBucket={overviewEntry.bucket} actor={actor} run={run} api={api} teams={session.teams} revision={revision} onOpen={onOpen} />;
  else if (route === 'planned-maintenance') content = actor.role === 'team' ? <PlannedMaintenanceView api={api} revision={revision} department={actor.department} onChanged={() => setRevision(value => value + 1)} onOpenOverview={() => go('operations')} /> : forbidden;
  else if (route === 'personnel') content = departmentAccess ? <PersonnelView actor={actor} api={api} run={run} revision={revision} /> : forbidden;
  else if (route === 'night-duty') content = departmentAccess ? <NightDutyView actor={actor} api={api} run={run} revision={revision} /> : forbidden;
  else if (route === 'roster') content = departmentAccess ? <RosterView actor={actor} api={api} run={run} departments={session.departments} revision={revision} /> : forbidden;
  else if (route === 'notices') content = <NoticeList actor={actor} api={api} revision={revision} onOpen={ref => go('notices/' + ref)} onNew={() => go('notices/new')} />;
  else if (route === 'notices/new') content = actor.role === 'bnoc' ? <NoticeEditor api={api} run={run} onSaved={(ref,message) => openSaved(ref ? 'notices/' + ref : 'notices',message)} onBack={() => go('notices')} /> : forbidden;
  else if (route.startsWith('notices/')) content = <NoticeDetail key={route} actor={actor} api={api} run={run} refNumber={route.slice('notices/'.length)} revision={revision} onBack={() => go('notices')} initialMessage={routeReceipt?.path === route ? routeReceipt.message : undefined} />;
  else if (route === 'notifications') content = <NotificationInbox actor={actor} query={api} run={run} revision={revision} onOpen={onOpen} />;
  else if (route === 'access') content = actor.accessAdmin || actor.role === 'admin' ? <AccessManagementView actor={actor} api={api} run={run} teams={session.teams} departments={session.departments} revision={revision} /> : forbidden;
  else if (route === 'requests') content = actor.role === 'admin' ? <SharedWorkOverview actor={actor} run={run} api={api} teams={session.teams} revision={revision} onOpen={onOpen} /> : <RequestListAndSearch key={`${actor.id}:${actor.role}`} searchState={requestSearchState} onSearchStateChange={setRequestSearchState} onReuse={reuseRequest} actor={actor} query={api} teams={session.teams} revision={revision} onOpen={onOpen} onOpenAttachment={(number,id,searchTerm,blockIndex,metadataIndex)=>{setAttachmentNavigation({requestNumber:number,attachmentId:id,searchTerm,blockIndex,metadataIndex});go('requests/'+encodeURIComponent(number),false,true);}} onNew={() => go('new')} />;
  else content = <section className="card"><h1>페이지를 찾을 수 없습니다</h1><button onClick={() => go('requests')}>신청 목록</button></section>;
  if (surveyPreview) content = <SurveyWorkspace key={route} route={route} actor={actor} teams={session.teams} go={go} fallback={content} />;
  const situationButton=(kind:'gps'|'cpcon',label:string,value?:SituationSnapshot)=>{
    const status=globalContext.situationError?(value?'조회 오류 · 마지막 값':'조회 오류'):value?situationStateLabel[value.collectionState]??'상태 확인':'불러오는 중';
    const stage=kind==='cpcon' ? cpconStageValue(value?.stageCode) ?? '자료 없음' : value?.stageLabel ?? (value?.stageCode==null?'자료 없음':`${value.stageCode}단계`);
    const openExternalSystem=()=>{
      const url=new URL(`/external-systems/${kind}/index.html`,window.location.origin);
      const popup=window.open(url.toString(),`bnoc-${kind}`,'popup,width=720,height=600');
      if(!popup){setNotice(`${label} 정보를 새 창으로 열지 못했습니다. 브라우저의 팝업 허용을 확인하세요.`);return;}
      popup.opener=null;
    };
    return <button key={kind} onClick={openExternalSystem} aria-label={`${label} ${stage}, ${status}`}><strong>{label} · {stage}</strong><small>{status}</small></button>;
  };
  const unseenCount=globalContext.unseen;
  const notificationBadge=globalContext.unseenError
    ? <span className="nav-badge nav-badge--error" aria-label="알림 조회 오류">!</span>
    : typeof unseenCount==='number'&&unseenCount>0
      ? <span className="nav-badge" aria-label={`미확인 ${unseenCount}건`}>{unseenCount>99?'99+':unseenCount}</span>
      : null;
  return <DepartmentContactApiContext.Provider value={api}><UnsavedChangesContext.Provider value={registerDirty}>
    {choosingPrevious&&actor.role==='requester'&&<RequestReusePicker key={`${actor.id}:${actor.role}`} api={api} onChoose={reuseRequest} onClose={()=>setChoosingPrevious(false)}/>}
    <div inert={expired}><a className="skip" href="#main">본문으로 건너뛰기</a><header><div className="header-main"><button className="brand" onClick={() => go('requests')}>BNOC <span>업무 관리</span></button><div className="header-context" aria-label="공통 현황">{situationButton('gps','GPS',globalContext.gps)}{situationButton('cpcon','CPCON',globalContext.cpcon)}{actor.role==='bnoc'&&<button onClick={()=>go('operations',false,false,'returned')} aria-label={`반환 처리 대기 ${globalContext.returnedError?'조회 오류':globalContext.returned??'불러오는 중'}`}><strong>반환 대기 · {globalContext.returnedError?'조회 오류':globalContext.returned??'—'}</strong><small>{globalContext.returnedError?'조회에 실패했습니다.':''}</small></button>}</div><div className="header-actions"><div className="identity"><strong>{actor.displayName}</strong>{actor.department!==actor.displayName&&<small>{actor.department}</small>}</div><button onClick={() => void logout()}>로그아웃</button></div></div><nav aria-label="주 메뉴">{navGroups.map(group => <details className="nav-group" name="bnoc-primary-nav" key={group.label} data-active={group.items.some(([path]) => routeMatches(path)) || undefined}><summary>{group.label}{group.label === '소통' && notificationBadge}<span className="nav-group__chevron" aria-hidden="true">⌄</span></summary><div className="nav-group__panel">{group.items.map(([path,label]) => <button key={path} aria-current={routeMatches(path) ? 'page' : undefined} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); go(path); }}>{label}{path==='notifications'&&notificationBadge}</button>)}</div></details>)}</nav></header>
      <main id="main" tabIndex={-1}>{notice && <p className="error" role="alert">{notice}</p>}<div key={`${actor.id}:${actor.role}`} data-screen={route} data-role={actor.role}>{content}</div></main>
    </div>
    {expired && <dialog ref={expiryDialog} className="reauth-dialog" aria-label="로그인 만료" onCancel={event => event.preventDefault()}>{notice && <p className="notice">{notice}</p>}<LoginPanel api={api} expired onAuthenticated={acceptSession} /></dialog>}
  </UnsavedChangesContext.Provider></DepartmentContactApiContext.Provider>;
}
