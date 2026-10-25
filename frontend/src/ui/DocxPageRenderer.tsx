import { useEffect, useMemo, useRef, useState } from 'react';
import zipScript from '../../node_modules/jszip/dist/jszip.min.js?raw';
import docxScript from '../../node_modules/docx-preview/dist/docx-preview.js?raw';

// The document renderer runs in an opaque-origin sandbox. Document links,
// styles and embedded content cannot access the application or the network.
export function DocxPageRenderer({ bytes, fileName }: { bytes: Uint8Array; fileName: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const channel = useMemo(() => crypto.randomUUID(), [bytes]);
  const source = useMemo(() => {
    const script = (value: string) => value.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${channel}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;color:#172033;background:#f2f4f7;font-family:Arial,sans-serif}#pages{overflow:auto}#pages .docx-wrapper{padding:16px}#pages section.docx{margin:0 auto 16px;box-shadow:0 1px 5px #0002}a{pointer-events:none}</style>
<script nonce="${channel}">${script(zipScript)}</script><script nonce="${channel}">${script(docxScript)}</script></head><body><main id="pages"></main>
<script nonce="${channel}">
let rendered=false;
addEventListener('message',async event=>{
  if(rendered||event.source!==parent||event.data?.channel!==${JSON.stringify(channel)}||!(event.data.buffer instanceof ArrayBuffer))return;
  rendered=true;
  try{
    await docx.renderAsync(event.data.buffer,document.getElementById('pages'),undefined,{useBase64URL:true,ignoreFonts:true,renderAltChunks:false,renderComments:false,breakPages:true,ignoreLastRenderedPageBreak:false});
    const pages=document.querySelectorAll('section.docx');
    if(!pages.length)throw new Error('empty');
    document.querySelectorAll('a').forEach(link=>{link.removeAttribute('href');link.removeAttribute('target');});
    parent.postMessage({channel:${JSON.stringify(channel)},status:'ready'},'*');
  }catch{parent.postMessage({channel:${JSON.stringify(channel)},status:'failed'},'*');}
});
</script></body></html>`;
  }, [channel]);

  useEffect(() => {
    setStatus('loading');
    const timer = window.setTimeout(() => setStatus('failed'), 30000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return;
      if (event.data.status === 'ready' || event.data.status === 'failed') {
        window.clearTimeout(timer); setStatus(event.data.status);
      }
    };
    window.addEventListener('message', receive);
    return () => { window.clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [channel]);

  return <div className="docx-page-view">
    {status === 'loading' && <p className="muted" role="status">Word 문서를 표시하는 중…</p>}
    {status === 'failed' && <p className="field-error" role="alert">이 Word 문서를 미리 볼 수 없습니다. 파일이 손상되었거나 지원하지 않는 구성일 수 있습니다. 원본 다운로드를 이용하세요.</p>}
    {status !== 'failed' && <iframe key={channel} ref={frame} title={`${fileName} 원본 미리보기`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} onLoad={() => {
      const buffer = bytes.slice().buffer;
      frame.current?.contentWindow?.postMessage({ channel, buffer }, '*', [buffer]);
    }} />}
  </div>;
}
