export const INTAKE_KINDS = ['PC','프린터','회선','전화','비상벨','CCTV','인터컴','기타'];
export const INTAKE_WORKS = ['고장','신설','지원','대여','점검','이전','기타'];
export const INTAKE_INTENTS = ['고장','신설','지원','기타'];
export const INTAKE_SUPPORTS = ['회의 지원','지원','대여','점검','이전'];
export const INTAKE_SYSTEMS = ['인트라넷','인터넷','AFCCS','KJCCS','기타'];
export const intakeKindLabel = kind => ({PC:'컴퓨터',전화:'전화기'}[kind] ?? kind);
export const intakeUnit = kind => kind === '회선' ? '개' : '대';
export function newIntakeItem(kind,quantity=1) {
  return {id:crypto.randomUUID(),kind,quantity,workType:'',location:'',systemType:'',phoneType:'',symptom:'',detail:'',equipmentId:'',errorCode:'',destination:'',attachmentIds:[],answered:[],reviewed:false,splitSourceId:null};
}
export function createIntakeState() {
  return {version:1,splitCount:'1',intent:'',defaultWorkType:'',mode:'equipment',step:'intent',activeId:null,items:[],quantities:{},order:[],history:[],returnTo:null,meeting:{meetingType:'',videoPlatform:'',detail:'',location:'',attachmentIds:[]}};
}
export const activeIntakeItem = state => state.items.find(item=>item.id===state.activeId) ?? null;
export const intakeHasSystem = item => ['PC','프린터','회선','CCTV'].includes(item.kind) || (item.kind==='전화'&&item.phoneType==='IP');
export const intakeHasModel = item => ['PC','프린터','CCTV'].includes(item.kind)&&item.workType!=='신설';
export const intakeHasError = item => item.workType==='고장'&&['오류가 표시돼요','프로그램에 문제가 있어요'].includes(item.symptom);
export function intakeSteps(item) {
  return ['workType',...(item.kind==='전화'?['phoneType']:[]),'location',...(intakeHasSystem(item)?['systemType']:[]),...(item.workType==='고장'?['symptom',...(item.symptom==='직접 설명할게요'?['detail']:[])]:['detail']),...(intakeHasError(item)?['errorCode']:[]),...(intakeHasModel(item)?['equipmentId']:[]),...(item.workType==='이전'?['destination']:[])];
}
export const intakeQuestions = item => intakeSteps(item).filter(key=>['workType','location','symptom','detail'].includes(key));
const pendingQuestion = item => intakeQuestions(item).find(key=>!item.answered.includes(key)||typeof item[key]!=='string'||!item[key].trim()||item[key].trim()==='unknown'||(key==='workType'&&!INTAKE_WORKS.includes(item[key])));
const pendingExtra = item => intakeSteps(item).find(field=>!intakeQuestions(item).includes(field)&&!item.answered.includes(field));
const pendingStep = item => pendingQuestion(item)??(item.extraInformation?pendingExtra(item):undefined);
const requiredFlow = item => intakeQuestions(item).filter(key=>key!=='workType'||!item.inheritedWorkType);
export const intakeComplete = state => state.mode==='meeting'
  ? Boolean(state.meeting.meetingType&&state.meeting.detail.trim()&&state.meeting.location.trim()&&(state.meeting.meetingType!=='화상회의'||state.meeting.videoPlatform)&&(!['화상회의','일반회의'].includes(state.meeting.meetingType)||state.meeting.attachmentIds?.length))
  : state.items.length>0&&state.items.every(item=>!pendingQuestion(item));
const copy = state => structuredClone(state);
const frame = state => ({step:state.step,activeId:state.activeId,mode:state.mode,returnTo:state.returnTo});
function move(state,step,activeId=state.activeId) {
  const result=copy(state);
  if(result.step!==step||result.activeId!==activeId)result.history=[...result.history,frame(result)].slice(-128);
  result.step=step;result.activeId=activeId;return result;
}
export const navigateIntake = move;
export function jumpIntake(state,step,activeId=state.activeId) {
  const result=copy(state);
  const itemFlow=state.items.flatMap(item=>{
    const extras=intakeSteps(item).filter(key=>!intakeQuestions(item).includes(key));
    const revisitingExtra=item.id===state.activeId&&(state.returnTo==='optional'||extras.includes(state.step));
    return [...requiredFlow(item),...(item.extraInformation||revisitingExtra?extras:[])].map(key=>({step:key,activeId:item.id}));
  });
  const questions=state.mode==='meeting'
    ? ['meetingType',...(state.meeting.meetingType==='화상회의'?['videoPlatform']:[]),'meetingDetail','meetingLocation','meetingAttachment']
    : ['pick',...itemFlow];
  const hasRequesterStep=state.step==='requester'||state.history.some(entry=>entry.step==='requester');
  const flow=['intent',...(state.intent==='지원'?['supportKind']:[]),...questions,'contact',...(hasRequesterStep?['requester']:[]),'review']
    .map(entry=>typeof entry==='string'?{step:entry,activeId:null,mode:state.mode,returnTo:null}:{...entry,mode:state.mode,returnTo:null});
  const index=step==='itemReview'?flow.findLastIndex(entry=>entry.activeId===activeId)+1:flow.findIndex(entry=>entry.step===step&&(!entry.activeId||entry.activeId===activeId));
  result.history=index>=0?flow.slice(0,index).slice(-128):['splitCount','difference'].includes(step)?[{step:'itemReview',activeId,mode:state.mode,returnTo:null}]:[];
  result.step=step;result.activeId=activeId;result.returnTo=null;
  return result;
}
function chooseEquipment(state,workType) {
  const result=move({...state,mode:'equipment'},'pick');result.returnTo=null;
  for(const item of result.items){
    if(!item.workType||(item.inheritedWorkType&&item.workType!==workType)){
      setItemField(item,'workType',workType);
      item.inheritedWorkType=true;
      if(!item.answered.includes('workType'))item.answered.push('workType');
    }
  }
  result.defaultWorkType=workType;return result;
}
export function chooseIntakeIntent(state,intent) {
  if(!INTAKE_INTENTS.includes(intent))return state;
  const result={...state,intent};
  return intent==='지원'?move(result,'supportKind'):chooseEquipment(result,intent);
}
export function chooseIntakeSupport(state,support) {
  if(!INTAKE_SUPPORTS.includes(support))return state;
  if(support!=='회의 지원')return chooseEquipment(state,support);
  const result=move({...state,mode:'meeting'},'meetingType');result.returnTo=null;return result;
}
export function changeIntakeCount(state,kind,delta) {
  if(!INTAKE_KINDS.includes(kind)||![1,-1].includes(delta))return state;
  const result=copy(state),old=result.quantities[kind]??0,next=Math.max(0,Math.min(999,old+delta));
  if(next===old)return state;
  if(delta>0){
    const existing=result.items.filter(item=>item.kind===kind).at(-1);
    if(existing){existing.quantity++;existing.reviewed=false;}else{const item=newIntakeItem(kind);if(result.defaultWorkType){item.workType=result.defaultWorkType;item.inheritedWorkType=true;item.answered=['workType'];}result.items.push(item);result.order.push(kind);}
  }else{
    const last=result.items.filter(item=>item.kind===kind).at(-1);last.quantity--;
    if(last.quantity===0)result.items=result.items.filter(item=>item.id!==last.id);
  }
  if(next===0){delete result.quantities[kind];result.order=result.order.filter(value=>value!==kind);}else result.quantities[kind]=next;
  result.history=result.history.filter(value=>!value.activeId||result.items.some(item=>item.id===value.activeId));
  if(result.activeId&&!result.items.some(item=>item.id===result.activeId))result.activeId=result.items[0]?.id??null;
  return result;
}
function continueIntake(state,completionStep) {
  const result=copy(state),next=result.items.find(item=>pendingStep(item));
  for(const item of result.items)if(!pendingStep(item))item.reviewed=true;
  const moved=next?move(result,pendingStep(next),next.id):move(result,completionStep);
  moved.returnTo=next?.extraInformation?'optional':null;return moved;
}
export function startIntake(state,completionStep='contact') {
  if(!state.items.length)return state;
  if(state.step!=='pick')return continueIntake({...state,mode:'equipment',returnTo:null},completionStep);
  const first=state.items[0];
  const result=move({...state,mode:'equipment',returnTo:null},requiredFlow(first)[0]??completionStep,first.id);
  result.returnTo=first.extraInformation?'optional':null;
  return result;
}
function setItemField(item,key,value) {
  const changed=item[key]!==value;
  item[key]=value;item.reviewed=false;
  if(key==='workType'){if(value==='신설')item.equipmentId='';if(value!=='고장'){item.symptom='';item.errorCode='';}if(value!=='이전')item.destination='';}
  if(key==='phoneType'&&value!=='IP'){item.systemType='';item.answered=item.answered.filter(field=>field!=='systemType');}
  if(key==='workType'&&changed){const active=new Set(intakeSteps(item));item.answered=item.answered.filter(field=>active.has(field));}
}
export function updateIntakeField(state,key,value) {
  const result=copy(state),item=activeIntakeItem(result);if(!item)return state;
  if(!['workType','location','systemType','phoneType','symptom','detail','equipmentId','errorCode','destination','attachmentIds'].includes(key))return state;
  setItemField(item,key,value);
  if(key==='workType')item.inheritedWorkType=false;
  return result;
}
export function setIntakeExtras(state,enabled) {
  const result=copy(state),item=activeIntakeItem(result);if(!item||typeof enabled!=='boolean')return state;
  item.extraInformation=enabled;result.returnTo=enabled?'optional':null;return result;
}
export function answerIntake(state,key,value,completionStep='contact') {
  let result=updateIntakeField(state,key,value);const item=activeIntakeItem(result);if(!item)return state;
  if(result.returnTo==='optional'&&item.extraInformation===undefined)item.extraInformation=true;
  if(!item.answered.includes(key))item.answered.push(key);
  if(key==='workType'){
    const active=new Set(intakeSteps(item));item.answered=item.answered.filter(field=>active.has(field));
  }
  const editing=['itemReview','review'].includes(result.returnTo);
  const required=requiredFlow(item),index=required.indexOf(key);
  const next=editing?pendingQuestion(item):index>=0?required[index+1]??pendingQuestion(item):pendingQuestion(item);
  if(next)return move(result,next);
  if(result.returnTo==='optional'){
    const extras=intakeSteps(item).filter(field=>!intakeQuestions(item).includes(field));
    const optional=extras.includes(key)?extras[extras.indexOf(key)+1]:pendingExtra(item);
    if(optional)return move(result,optional);
  }
  if(['itemReview','review'].includes(result.returnTo)){
    const destination=result.returnTo;
    if(destination==='review')item.reviewed=true;
    const next=move(result,destination);next.returnTo=null;return next;
  }
  if(state.step===key){
    const nextItem=result.items[result.items.findIndex(entry=>entry.id===item.id)+1];
    if(nextItem){
      item.reviewed=true;item.splitSourceId=null;
      const moved=move(result,requiredFlow(nextItem)[0]??completionStep,nextItem.id);
      moved.returnTo=nextItem.extraInformation?'optional':null;
      return moved;
    }
  }
  return completeIntakeItem(result,completionStep);
}
export function editIntakeItem(state,id) {
  const result=move(state,'itemReview',id);result.returnTo='review';return result;
}
export function editIntakeField(state,key,id=state.activeId,returnTo=state.returnTo==='review'?'review':'itemReview') {
  const result=move(state,key,id);result.returnTo=returnTo;return result;
}
export function completeIntakeItem(state,completionStep='contact') {
  const result=copy(state),item=activeIntakeItem(result);if(!item)return state;
  const pending=pendingQuestion(item);if(pending)return move(result,pending);
  item.reviewed=true;item.splitSourceId=null;
  return continueIntake(result,completionStep);
}
export const canBackIntake=state=>state.history.length>0||jumpIntake(state,state.step).history.length>0;
export function backIntake(state) {
  let result=copy(state);
  const current=activeIntakeItem(result);if(current&&result.returnTo==='optional'&&current.extraInformation===undefined)current.extraInformation=true;
  if(!result.history.length)result=jumpIntake(result,result.step);
  while(result.history.length){
    const previous=result.history.pop();
    if(previous.activeId&&!result.items.some(item=>item.id===previous.activeId))continue;
    const item=result.items.find(value=>value.id===previous.activeId);
    if(item&&['workType','phoneType','location','systemType','symptom','detail','errorCode','equipmentId','destination'].includes(previous.step)&&!intakeSteps(item).includes(previous.step))continue;
    Object.assign(result,previous);
    if(result.mode==='equipment'&&!result.activeId)result.activeId=current?.id??result.items.at(-1)?.id??null;
    if(item&&intakeSteps(item).includes(previous.step)&&[null,'optional'].includes(previous.returnTo)&&typeof item.extraInformation==='boolean')result.returnTo=item.extraInformation?'optional':null;
    return result;
  }
  return result;
}
export function splitIntakeItem(state,count) {
  const result=copy(state),source=activeIntakeItem(result);
  if(!source||!Number.isInteger(count)||count<1||count>=source.quantity||result.items.length>=50)return state;
  source.quantity-=count;
  const child={...copy(source),id:crypto.randomUUID(),quantity:count,equipmentId:'',errorCode:'',attachmentIds:[],reviewed:false,splitSourceId:source.id,extraInformation:false};
  result.items.splice(result.items.findIndex(item=>item.id===source.id)+1,0,child);
  result.returnTo='itemReview';
  return move(result,'difference',child.id);
}
export function cancelIntakeSplit(state) {
  const result=copy(state),child=activeIntakeItem(result),source=result.items.find(item=>item.id===child?.splitSourceId);
  if(!source)return state;
  source.quantity+=child.quantity;source.reviewed=false;result.items.forEach(item=>{if(item.splitSourceId===child.id)item.splitSourceId=source.id;});result.items=result.items.filter(item=>item.id!==child.id);result.history=result.history.filter(value=>value.activeId!==child.id);
  result.activeId=source.id;result.step='itemReview';result.returnTo=null;return result;
}
export function removeIntakeItem(state,id) {
  const result=copy(state),removed=result.items.find(item=>item.id===id);if(!removed)return state;
  result.items=result.items.filter(item=>item.id!==id);result.quantities[removed.kind]-=removed.quantity;
  if(result.quantities[removed.kind]===0){delete result.quantities[removed.kind];result.order=result.order.filter(kind=>kind!==removed.kind);}
  result.items.forEach(item=>{if(item.splitSourceId===id)item.splitSourceId=null;});
  result.history=result.history.filter(value=>value.activeId!==id);
  if(result.activeId===id||!result.items.length){result.activeId=result.items[0]?.id??null;result.step=result.items.length?'itemReview':'pick';result.returnTo=null;}
  return result;
}
export function normalizedIntakeItem(item) {
  const text=value=>typeof value==='string'&&value.trim()&&value!=='unknown'?value.trim():undefined;
  return {id:item.id,kind:item.kind,workType:item.workType,quantity:item.quantity,location:item.location.trim(),
    ...(intakeHasSystem(item)&&text(item.systemType)?{systemType:text(item.systemType)}:{}),
    ...(item.kind==='전화'&&text(item.phoneType)?{phoneType:text(item.phoneType)}:{}),
    ...(item.workType==='고장'&&text(item.symptom)?{symptom:text(item.symptom)}:{}),
    ...(text(item.detail)?{detail:text(item.detail)}:{}),
    ...(intakeHasModel(item)&&text(item.equipmentId)?{equipmentId:text(item.equipmentId)}:{}),
    ...(intakeHasError(item)&&text(item.errorCode)?{errorCode:text(item.errorCode)}:{}),
    ...(item.workType==='이전'&&text(item.destination)?{destination:text(item.destination)}:{}),attachmentIds:[...new Set(item.attachmentIds)]};
}
export function intakePayload(state) {return {intakeVersion:1,itemQuantities:{...state.quantities},requestItems:state.items.map(normalizedIntakeItem)};}
export function intakeItemText(item) {
  const value=normalizedIntakeItem(item);
  return [`${intakeKindLabel(value.kind)} ${value.workType} ${value.quantity}${intakeUnit(value.kind)}`,value.location,value.systemType,value.phoneType,value.symptom,value.detail,value.equipmentId,value.errorCode,value.destination].filter(Boolean).join(' / ');
}
export function intakeFromRequest(source,{keepAttachments=false}={}) {
  const result=createIntakeState();
  if(source.category==='회의 지원'){
    result.mode='meeting';result.step='meetingType';result.meeting={meetingType:source.subcategories?.meetingType??'',videoPlatform:source.subcategories?.videoPlatform??'',detail:source.detail??'',location:source.location??'',attachmentIds:keepAttachments?(source.attachments??[]).map(file=>file.id):[]};return result;
  }
  const sub=source.subcategories??{};
  const old=source.requestItems?.length?source.requestItems:[{kind:sub.resourceType==='전화'&&['인터컴','비상벨'].includes(sub.phoneType)?sub.phoneType:sub.resourceType==='컴퓨터'?'PC':sub.resourceType||'기타',workType:sub.workType||'기타',quantity:1,location:source.location??'',systemType:sub.systemType??'',phoneType:['IP','아날로그'].includes(sub.phoneType)?sub.phoneType:'',detail:source.detail??'',equipmentId:source.equipmentId??'',attachmentIds:[]}];
  for(const value of old){
    const item={...newIntakeItem(value.kind,value.quantity),...(keepAttachments&&value.id?{id:value.id}:{}),...Object.fromEntries(['workType','location','systemType','phoneType','symptom','detail','equipmentId','errorCode','destination'].map(key=>[key,value[key]??''])),attachmentIds:keepAttachments?[...(value.attachmentIds??[])]:[]};
    item.answered=intakeSteps(item).filter(key=>Boolean(item[key])||['phoneType','systemType','equipmentId','errorCode','destination'].includes(key));
    result.items.push(item);result.quantities[item.kind]=(result.quantities[item.kind]??0)+item.quantity;if(!result.order.includes(item.kind))result.order.push(item.kind);
  }
  result.activeId=result.items[0]?.id??null;result.step='itemReview';return result;
}
export function validGuidedDraft(value) {
  return value!==null&&typeof value==='object'&&value.version===1&&(value.intent===undefined||value.intent===''||INTAKE_INTENTS.includes(value.intent))&&(value.defaultWorkType===undefined||value.defaultWorkType===''||INTAKE_WORKS.includes(value.defaultWorkType))&&['equipment','meeting'].includes(value.mode)&&typeof value.step==='string'&&Array.isArray(value.items)&&value.items.length<=50&&(value.activeId===null||value.items.some(item=>item&&item.id===value.activeId))&&value.items.every(item=>item&&typeof item.id==='string'&&INTAKE_KINDS.includes(item.kind)&&Number.isInteger(item.quantity)&&item.quantity>0&&item.quantity<=999&&Array.isArray(item.answered)&&Array.isArray(item.attachmentIds)&&(item.inheritedWorkType===undefined||typeof item.inheritedWorkType==='boolean')&&(item.extraInformation===undefined||typeof item.extraInformation==='boolean'))&&Array.isArray(value.history)&&value.history.length<=128&&value.quantities&&typeof value.quantities==='object';
}
