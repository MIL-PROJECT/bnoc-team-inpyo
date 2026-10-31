import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';

// Only public executable code is shared; document bytes stay in their own worker.
let prepared: Promise<WebAssembly.Module | undefined> | undefined;
export function prepareHwpEngine(): Promise<WebAssembly.Module | undefined> {
  if(prepared)return prepared;
  const controller=new AbortController();let timer:number|undefined;
  const compile=(async()=>{
    const response=await fetch(wasmUrl,{credentials:'same-origin',signal:controller.signal});
    if(!response.ok)throw new Error('HwpEngineUnavailable');
    try{return await WebAssembly.compileStreaming(response.clone());}
    catch{return WebAssembly.compile(await response.arrayBuffer());}
  })();
  const deadline=new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>{controller.abort();reject(new Error('HwpEngineTimeout'));},30000);});
  const pending=Promise.race([compile,deadline]).catch(()=>{
    if(prepared===pending)prepared=undefined;
    return undefined;
  }).finally(()=>window.clearTimeout(timer));
  prepared=pending;return pending;
}
