/** @param {{current:{signature:string,operationId:string}|null}} pending @param {Record<string,unknown>} command */
export function commandForRetry(pending,command) {
  const signature=JSON.stringify(command);
  if(pending.current&&pending.current.signature!==signature)throw new Error('먼저 이전 저장 결과를 같은 입력으로 확인하세요.');
  if(!pending.current)pending.current={signature,operationId:crypto.randomUUID()};
  return {...command,operationId:pending.current.operationId};
}

/** @param {{current:{signature:string,operationId:string}|null}} pending */
export function clearCommandRetry(pending) { pending.current=null; }

/** A network failure may follow a committed write. Confirm that receipt before editing. */
export function commandResultUnknown(error) { return !error?.code||['NETWORK','INVALID_RESPONSE','PROCESSING','SAVE_FAILED','UNAUTHENTICATED'].includes(error.code); }
