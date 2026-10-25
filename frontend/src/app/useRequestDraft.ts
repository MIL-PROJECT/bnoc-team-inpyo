import {useEffect,useRef,useState} from 'react';
import type {Actor} from '../types';
import type {RequestInput} from '../screens/RequestRegistrationForm';
import {errorMessage} from './useResource';

type Draft = {id:string;revision:number;savedAt:string;input:RequestInput};
type DraftState = {draft:Draft|null;revision:number};
export type DraftReference = {id:string;revision:number};
export type RequestDraftApi = {
  getRequestDraft:()=>Promise<unknown>;
  saveRequestDraft:(body:Record<string,unknown>)=>Promise<unknown>;
  deleteRequestDraft:(body:Record<string,unknown>)=>Promise<unknown>;
};
function decode(value:unknown,empty:RequestInput):DraftState {
  if(!value||typeof value!=='object')throw new Error('임시저장 응답을 확인하지 못했습니다.');
  const state=value as DraftState;
  if(!Number.isSafeInteger(state.revision)||state.revision<0)throw new Error('임시저장 버전을 확인하지 못했습니다.');
  if(state.draft===null)return {draft:null,revision:state.revision};
  const draft=state.draft;
  if(!draft||typeof draft.id!=='string'||draft.id.length!==36||draft.revision!==state.revision||!Number.isFinite(Date.parse(draft.savedAt))||!draft.input||typeof draft.input!=='object'||Array.isArray(draft.input))throw new Error('임시저장 내용을 확인하지 못했습니다.');
  const input={...empty,...draft.input};
  if(Object.keys(input).some(key=>!(key in empty))||Object.entries(empty).some(([key,initial])=>key!=='attachments'&&typeof input[key as keyof RequestInput]!==typeof initial)||!Array.isArray(input.attachments)||input.attachments.some(file=>!file||typeof file.id!=='string'||typeof file.fileName!=='string'||typeof file.type!=='string'||!Number.isFinite(file.size)))throw new Error('임시저장 입력의 형식을 확인하지 못했습니다.');
  return {draft:{...draft,input},revision:state.revision};
}
export function useRequestDraft({actor,input,empty,api,onRestore,onSaved}:{actor:Actor;input:RequestInput;empty:RequestInput;api:RequestDraftApi;onRestore:(input:RequestInput)=>void;onSaved:()=>void}) {
  const [state,setState]=useState<DraftState>({draft:null,revision:0});
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [reference,setReference]=useState<DraftReference|null>(null),[baseline,setBaseline]=useState<string|null>(null);
  const [uncertain,setUncertain]=useState<'save'|'delete'|null>(null);
  const generation=useRef(0),alive=useRef(false),working=useRef(false);
  const pending=useRef<{key:string;operationId:string}|null>(null);
  const latest=useRef({actor,input,empty,api,onRestore,onSaved,baseline});latest.current={actor,input,empty,api,onRestore,onSaved,baseline};
  const valid=(token:number)=>alive.current&&generation.current===token;
  const failure=(cause:unknown)=>cause instanceof Error?errorMessage(cause):'임시저장 결과를 확인하지 못했습니다.';
  useEffect(()=>{
    alive.current=true;const token=++generation.current;
    void api.getRequestDraft().then(value=>{if(valid(token)){setState(decode(value,latest.current.empty));setReady(true);}}).catch(cause=>{if(valid(token))setError(failure(cause));});
    return()=>{alive.current=false;generation.current++;};
  },[actor.id,actor.role,api]);
  const start=()=>{if(working.current)return null;working.current=true;const token=++generation.current;setBusy(true);setError('');setNotice('');return token;};
  const finish=(token:number)=>{if(valid(token)){working.current=false;setBusy(false);}};
  const refresh=async(restore=false)=>{
    const current=latest.current;
    const dirty=JSON.stringify(current.input)!==(current.baseline??JSON.stringify(current.empty));
    if(restore&&dirty&&!window.confirm('현재 입력을 임시저장한 내용으로 바꿀까요? 저장하지 않은 변경은 사라집니다.'))return;
    const token=start();if(token===null)return;
    try{
      const next=decode(await latest.current.api.getRequestDraft(),latest.current.empty);
      if(!valid(token))return;
      setState(next);setReady(true);
      if(restore){
        setUncertain(null);pending.current=null;
        if(!next.draft){setReference(null);setBaseline(null);latest.current.onSaved();setNotice('임시저장한 신청서가 없습니다. 현재 입력은 유지했습니다. 새로 임시저장하거나 신청을 등록할 수 있습니다.');return;}
        setReference({id:next.draft.id,revision:next.draft.revision});setBaseline(JSON.stringify(next.draft.input));
        latest.current.onRestore(next.draft.input);setNotice('임시저장한 신청서를 불러왔습니다. 확인 후 신청을 등록하세요.');
      }
    }catch(cause){if(valid(token))setError(failure(cause));}finally{finish(token);}
  };
  const mutate=async(action:'save'|'delete')=>{
    if(!ready||working.current||(uncertain&&uncertain!==action))return;
    if(action==='save'&&state.draft&&!reference&&!uncertain&&!window.confirm('기존 임시저장 내용을 현재 입력으로 바꿀까요?'))return;
    if(action==='delete'&&!uncertain&&!window.confirm('임시저장한 신청서를 삭제할까요? 현재 화면 입력은 유지됩니다.'))return;
    const token=start();if(token===null)return;
    const snapshot=structuredClone(latest.current.input);
    const revision=reference?.revision??state.revision;
    const body:Record<string,unknown>={role:actor.role,expectedRevision:revision,...(action==='save'?{input:snapshot}:{})};
    const key=JSON.stringify({action,...body});
    if(pending.current?.key!==key)pending.current={key,operationId:crypto.randomUUID()};
    body.operationId=pending.current.operationId;
    try{
      const result=action==='save'?await latest.current.api.saveRequestDraft(body):await latest.current.api.deleteRequestDraft(body);
      const next=decode(result,latest.current.empty);
      if(action==='save'&&!next.draft)throw new Error('임시저장 완료 내용을 확인하지 못했습니다.');
      if(!valid(token))return;
      setState(next);setUncertain(null);pending.current=null;
      if(action==='save'){
        setReference({id:next.draft!.id,revision:next.draft!.revision});setBaseline(JSON.stringify(snapshot));latest.current.onSaved();
        setNotice('신청서를 임시저장했습니다. 창을 닫거나 다시 로그인해도 불러올 수 있습니다.');
      }else{setReference(null);setBaseline(null);setNotice('임시저장한 신청서를 삭제했습니다. 현재 입력은 유지했습니다.');}
    }catch(cause){if(valid(token)){
      const code=(cause as {code?:string})?.code;
      if(!code||['NETWORK','INVALID_RESPONSE','SAVE_FAILED','PROCESSING'].includes(code))setUncertain(action);
      setError(code==='CONFLICT'?'다른 화면에서 임시저장이 변경됐습니다. 현재 입력을 유지했습니다. 임시저장 불러오기로 최신 내용을 확인하세요.':failure(cause));
    }}finally{finish(token);}
  };
  return {state,ready,busy,error,notice,reference,baseline,uncertain,
    clearFeedback:()=>{setError('');setNotice('');},
    refresh:()=>refresh(false),restore:()=>refresh(true),save:()=>mutate('save'),remove:()=>mutate('delete')};
}
