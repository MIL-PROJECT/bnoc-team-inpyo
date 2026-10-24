export const requestFlow = ['대기','배정','작업 중','완료'];
export function statusGuide(status, work=false, afterAction=false) {
  const scope=work?'개별 작업':'요청 전체';
  if(afterAction)return {status,title:'완료 후보고',scope,kind:'afterAction',tone:'success',flow:[],currentIndex:-1,summary:'이미 끝낸 작업의 보고입니다.'};
  const flow=(work?requestFlow.slice(1):requestFlow).map(value=>({status:value}));
  const descriptions={
    대기:'요청과 담당 부서 배정 상태를 확인하고 있습니다.',
    배정:'작업을 담당할 부서가 배정된 상태입니다.',
    '작업 중':work?'이 작업을 진행하고 있습니다.':'현재 담당 부서의 작업이 진행되고 있습니다.',
    완료:work?'이 작업이 완료됐습니다.':'현재 담당 작업이 모두 완료됐습니다.',
    '문서 대기':'요청 내용을 보완하고 있습니다.',
    반환:'담당 부서를 조정하고 있습니다.',
    기각:'BNOC 담당 범위 밖 요청으로 처리하지 않습니다.',
    취소:'취소된 요청입니다.'
  };
  const summary=descriptions[status],currentIndex=flow.findIndex(step=>step.status===status);
  const kind=summary?(currentIndex>=0?'normal':'exception'):'unknown';
  const tone=status==='완료'?'success':['문서 대기','반환'].includes(status)?'warning':kind!=='normal'||status==='대기'?'neutral':'info';
  return {status,title:status,scope,kind,tone,flow:currentIndex>=0?flow:[],currentIndex,summary:summary??'현재 상태 정보를 확인하세요.'};
}
