import { useEffect, useRef, useState } from 'react';
import { ApiClient } from '../api/apiClient.mjs';
import { acceptsLoginMessage } from '../api/loginProof.mjs';
import { errorMessage } from '../app/useResource';
import type { ServerSession } from '../types';

export function LoginPanel({ api, expired = false, onAuthenticated }: { api: ApiClient; expired?: boolean; onAuthenticated: (session: ServerSession) => void | Promise<void> }) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const popup = useRef<Window | null>(null);
  const challenge = useRef<{ providerUrl: string; loginAttempt: string } | null>(null);
  const completing = useRef(false);
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (completing.current || !acceptsLoginMessage(event, popup.current, challenge.current)) return;
      completing.current = true;
      try {
        await api.completeLogin(event.data.ticket, event.data.loginAttempt);
        const session = await api.session();
        await onAuthenticated(session as ServerSession);
      } catch (error) { setMessage(errorMessage(error instanceof Error ? error : new Error('로그인하지 못했습니다. 다시 시도하세요.'))); }
      finally { popup.current?.close(); popup.current = null; challenge.current = null; completing.current = false; setPending(false); }
    };
    window.addEventListener('message', receive);
    const timer = window.setInterval(() => {
      if (popup.current?.closed && !completing.current) { popup.current = null; challenge.current = null; setPending(false); setMessage('인증 창이 닫혔습니다. 다시 로그인할 수 있습니다.'); }
    }, 1000);
    return () => { window.removeEventListener('message', receive); window.clearInterval(timer); popup.current?.close(); };
  }, [api, onAuthenticated]);
  const start = async () => {
    if (pending) return;
    const opened = window.open('about:blank', 'bnoc-auth-' + crypto.randomUUID(), 'popup,width=520,height=640');
    if (!opened) { setMessage('인증 창을 열지 못했습니다. 이 사이트의 팝업을 허용하고 다시 시도하세요.'); return; }
    popup.current = opened; setPending(true); setMessage('');
    try {
      const next = await api.startLogin();
      if (opened.closed) { setPending(false); return; }
      const providerUrl = new URL(next.providerUrl);
      if (!['http:','https:'].includes(providerUrl.protocol) || !next.loginAttempt) throw new Error('인증 제공자 주소를 확인하지 못했습니다.');
      challenge.current = { providerUrl: next.providerUrl, loginAttempt: next.loginAttempt };
      opened.location.href = next.providerUrl;
    } catch (error) { opened.close(); popup.current = null; challenge.current = null; setPending(false); setMessage(errorMessage(error instanceof Error ? error : new Error('인증을 시작하지 못했습니다.'))); }
  };
  return <section className={`auth-shell ${expired ? 'compact' : ''}`} aria-label="로그인">
    <div className="auth-panel"><small className="eyebrow">BNOC 업무 관리</small><h1>{expired ? '다시 로그인' : '업무를 한곳에서'}</h1>
      <p>{expired ? '로그인이 만료됐습니다. 입력 내용은 유지됩니다. 같은 사용자로 다시 로그인한 뒤 저장을 눌러주세요.' : '요청·작업 진행과 부대 운영 현황을 확인하세요.'}</p>
      <button className="primary auth-button" onClick={() => void start()} disabled={pending}>{pending ? '인증 창에서 계속해 주세요' : 'SSO 로그인'}</button>
      {message && <p className="error" role="alert">{message}</p>}
    </div>{!expired && <aside className="auth-aside" aria-hidden="true"><strong>BNOC</strong><span>신청과 작업</span><i /><span>일정과 운영 현황</span></aside>}
  </section>;
}
