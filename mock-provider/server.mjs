import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const identities = [
  { subject: 'requester', label: '요청자' },
  { subject: 'requester-secondary', label: '요청자', interactive: false },
  { subject: 'bnoc', label: 'BNOC' },
  { subject: 'bnoc-secondary', label: 'BNOC', interactive: false },
  { subject: 'team-wireless', label: '무선반' },
  { subject: 'team-wired', label: '유선반' },
  { subject: 'team-display', label: '전장반' },
  { subject: 'team-info', label: '정체반' },
  { subject: 'team-crypto', label: '암호반' },
  { subject: 'access-admin', label: '권한 관리자' }
];
const hash = text => createHash('sha256').update(text).digest();
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const initialFeed = () => ({ scenario: 'normal', stageCode: '5' });
const scenarios = new Set(['normal', 'error', 'timeout', 'invalid-stage', 'wrong-kind', 'missing-field', 'stale', 'future']);
const operationItems = [
  { itemId: 'posture-transmission', kind: 'posture', displayName: '전송망 운용태세', stageCode: '5' },
  { itemId: 'posture-computing', kind: 'posture', displayName: '전산체계 운용태세', stageCode: '5' },
  { itemId: 'alarm-facility', kind: 'alarm', displayName: '통신시설 장애경보', groupId: null, health: 'normal' },
  { itemId: 'alarm-network', kind: 'alarm', displayName: '통신망 이상경보', groupId: null, health: 'normal' },
  { itemId: 'asset-facility-main', kind: 'asset', groupId: '통신시설', displayName: '주 통신실', health: 'normal' },
  { itemId: 'asset-facility-reserve', kind: 'asset', groupId: '통신시설', displayName: '예비 통신실', health: 'normal' },
  { itemId: 'asset-equipment-optical', kind: 'asset', groupId: '전송장비', displayName: '광전송 장비', health: 'normal' },
  { itemId: 'asset-equipment-wireless', kind: 'asset', groupId: '전송장비', displayName: '무선중계 장비', health: 'normal' },
  { itemId: 'asset-system-support', kind: 'asset', groupId: '업무체계', displayName: '업무지원 체계', health: 'normal' },
  { itemId: 'asset-system-situation', kind: 'asset', groupId: '업무체계', displayName: '상황공유 체계', health: 'normal' },
  { itemId: 'asset-network-internal', kind: 'asset', groupId: '통신망', displayName: '내부 업무망', health: 'normal' },
  { itemId: 'asset-network-facility', kind: 'asset', groupId: '통신망', displayName: '시설 관리망', health: 'normal' },
  { itemId: 'asset-computer-server', kind: 'asset', groupId: '전산장비', displayName: '업무 서버', health: 'normal' },
  { itemId: 'asset-computer-storage', kind: 'asset', groupId: '전산장비', displayName: '자료 보관 서버', health: 'normal' }
];

export function createProvider({ secret, allowedOrigins = ['http://127.0.0.1:8081'], now = Date.now } = {}) {
  if (typeof secret !== 'string' || secret.length < 24) throw new Error('BNOC_MOCK_SECRET_REQUIRED');
  const origins = new Set(allowedOrigins);
  const tickets = new Map();
  const state = { identity: 'normal', gps: initialFeed(), cpcon: initialFeed(), operations: { scenario: 'normal' } };
  const authorized = request => timingSafeEqual(hash(request.headers['x-mock-key'] ?? ''), hash(secret));
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  const html = (response, title, body, script = '') => {
    const nonce = randomBytes(18).toString('base64');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
    response.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
/* Hallmark v2.0.0 · shape: app screen · theme: BNOC (brand) · scope: app · redesign: full · signature: authentication form · copy: verbatim */
/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V3 · weakest: V, use the same BNOC controls through authentication. */
:root {
  color-scheme: light; --color-bg: #F5F6F7; --color-surface: #FFFFFF; --color-text: #18212F; --color-muted: #515D6B;
  --color-divider: #D8DDE3; --color-control-border: #73808F; --color-primary: #1D4ED8; --color-primary-hover: #1E40AF;
  --color-primary-active: #19398F; --color-focus: #1D4ED8; --color-on-primary: #FFFFFF; --color-neutral-bg: #EDF0F3;
  --font-family: system-ui, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px; --space-12: 48px;
  --control-height: 44px; --control-height-login: 52px; --radius-control: 3px; --radius-card: 4px;
}
* { box-sizing: border-box; }
html,body { overflow-x: clip; }
body { margin: 0; color: var(--color-text); background: var(--color-bg); font: 16px/1.6 var(--font-family); }
main { width: min(480px,calc(100% - 2 * var(--space-6))); margin: var(--space-12) auto; padding: var(--space-8); background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-card); }
h1 { margin: 0 0 var(--space-2); font-size: 28px; line-height: 1.2; text-wrap: balance; overflow-wrap: break-word; min-width: 0; }
p { margin: 0 0 var(--space-6); color: var(--color-muted); }
form { display: grid; gap: var(--space-4); }
label { display: block; font-size: 14px; font-weight: 600; }
select,button { box-sizing: border-box; width: 100%; margin: 0; padding: 0 var(--space-3); font: inherit; border: 1px solid var(--color-control-border); border-radius: var(--radius-control); }
select { height: var(--control-height); background: var(--color-surface); color: var(--color-text); }
button { height: var(--control-height-login); margin-top: var(--space-2); background: var(--color-primary); color: var(--color-on-primary); border-color: var(--color-primary); font-weight: 600; cursor: pointer; }
button:hover { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }
button:active { background: var(--color-primary-active); border-color: var(--color-primary-active); }
select:hover { border-color: var(--color-primary); }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }
button:disabled,select:disabled { opacity: .55; cursor: not-allowed; }
</style><main><h1>${escapeHtml(title)}</h1>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`);
  };
  async function body(request) {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    return request.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || '{}');
  }
  function challenge(input) {
    for (const key of ['loginAttempt', 'browserBinding']) if (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input[key])) throw new Error('INVALID_LOGIN_ATTEMPT');
    const returnUrl = new URL(input.returnUrl ?? `${allowedOrigins[0]}/auth/callback`);
    if (!origins.has(returnUrl.origin) || returnUrl.pathname !== '/auth/callback' || returnUrl.search || returnUrl.hash) throw new Error('INVALID_RETURN_URL');
    return returnUrl;
  }
  function issue(input) {
    const returnUrl = challenge(input);
    if (!identities.some(identity => identity.subject === input.subject)) throw new Error('UNKNOWN_IDENTITY');
    for (const [key, value] of tickets) if (value.expiresAt <= now()) tickets.delete(key);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { subject: input.subject, loginAttempt: input.loginAttempt, browserBinding: input.browserBinding, expiresAt: now() + (state.identity === 'expired' ? -1 : 60000) });
    return { ticket, loginAttempt: input.loginAttempt, sourceMode: 'simulation', returnOrigin: returnUrl.origin };
  }
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { ok: true, sourceMode: 'simulation' });
      if (url.pathname === '/identity' && request.method === 'GET') {
        const input = Object.fromEntries(url.searchParams); challenge(input);
        const options = identities.filter(identity => identity.interactive !== false).map(identity => `<option value="${identity.subject}">${identity.label}</option>`).join('');
        const hidden = ['loginAttempt', 'browserBinding', 'returnUrl'].map(key => `<input type="hidden" name="${key}" value="${escapeHtml(input[key])}">`).join('');
        return html(response, '사용자 인증', `<p>사용자 역할을 선택해 로그인하세요.</p><form method="post" action="/identity">${hidden}<label for="subject">사용자 역할</label><select id="subject" name="subject">${options}</select><button type="submit">로그인</button></form>`);
      }
      if ((url.pathname === '/identity' || url.pathname === '/identity/issue') && request.method === 'POST') {
        const input = await body(request); const result = issue(input);
        if (url.pathname === '/identity/issue') return json(response, 200, { ticket: result.ticket, loginAttempt: result.loginAttempt, sourceMode: result.sourceMode });
        const message = JSON.stringify({ type: 'bnoc-auth', ticket: result.ticket, loginAttempt: result.loginAttempt }).replaceAll('<', '\\u003c');
        const origin = JSON.stringify(result.returnOrigin);
        return html(response, '로그인 처리', '<p>로그인 중입니다.</p>', `if(window.opener){window.opener.postMessage(${message},${origin});window.close();}`);
      }
      if (url.pathname === '/identity/verify' && request.method === 'POST') {
        if (!authorized(request)) return json(response, 403, { code: 'FORBIDDEN' });
        if (state.identity === 'unavailable') return json(response, 503, { code: 'PROVIDER_UNAVAILABLE' });
        const input = await body(request); const proof = tickets.get(input.ticket);
        if (!proof || proof.expiresAt <= now() || proof.loginAttempt !== input.loginAttempt || proof.browserBinding !== input.browserBinding) return json(response, 403, { code: 'INVALID_PROOF' });
        tickets.delete(input.ticket);
        return json(response, 200, { subject: proof.subject, sourceMode: 'simulation' });
      }
      if (url.pathname === '/control' && request.method === 'POST') {
        if (!authorized(request)) return json(response, 403, { code: 'FORBIDDEN' });
        const input = await body(request);
        if (input.reset === true) { state.identity = 'normal'; state.gps = initialFeed(); state.cpcon = initialFeed(); state.operations = { scenario: 'normal' }; }
        if (input.identity !== undefined) {
          if (!['normal', 'expired', 'unavailable'].includes(input.identity)) throw new Error('INVALID_SCENARIO');
          state.identity = input.identity;
        }
        for (const kind of ['gps', 'cpcon']) if (input[kind]) {
          const feed = input[kind];
          if (feed.scenario && !scenarios.has(feed.scenario)) throw new Error('INVALID_SCENARIO');
          if (feed.stageCode !== undefined && !/^[1-5]$/.test(String(feed.stageCode))) throw new Error('INVALID_STAGE');
          state[kind] = { ...state[kind], ...feed };
        }
        if (input.operations) {
          const feed = input.operations;
          if (feed.scenario && !scenarios.has(feed.scenario)) throw new Error('INVALID_SCENARIO');
          state.operations = { ...state.operations, ...feed };
        }
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/feeds/operations' && request.method === 'GET') {
        if (!authorized(request)) return json(response, 403, { code: 'FORBIDDEN' });
        const feed = state.operations;
        if (feed.scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 6500));
        if (response.destroyed) return;
        if (feed.scenario === 'error') return json(response, 503, { code: 'FEED_UNAVAILABLE' });
        const offset = feed.scenario === 'stale' ? -300000 : feed.scenario === 'future' ? 120000 : 0;
        const observedAt = new Date(now() + offset).toISOString();
        const items = operationItems.map(item => ({ ...item, ...(item.kind === 'posture' ? { stageCode: feed.scenario === 'invalid-stage' ? '9' : item.stageCode } : {}), observedAt }));
        if (feed.scenario === 'missing-field') delete items[0].observedAt;
        return json(response, 200, { kind: feed.scenario === 'wrong-kind' ? 'gps' : 'operations', sourceMode: 'simulation', observedAt, items });
      }
      const matched = url.pathname.match(/^\/feeds\/(gps|cpcon)$/);
      if (matched && request.method === 'GET') {
        if (!authorized(request)) return json(response, 403, { code: 'FORBIDDEN' });
        const kind = matched[1], feed = state[kind];
        if (feed.scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 6500));
        if (response.destroyed) return;
        if (feed.scenario === 'error') return json(response, 503, { code: 'FEED_UNAVAILABLE' });
        const stageCode = feed.scenario === 'invalid-stage' ? '9' : String(feed.stageCode);
        const stageLabel = kind === 'gps' ? (stageCode === '5' ? '양호' : `${stageCode}단계`) : `CPCON${['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'][Number(stageCode) - 1] ?? ''}급`;
        const offset = feed.scenario === 'stale' ? -300000 : feed.scenario === 'future' ? 120000 : 0;
        const result = { kind: feed.scenario === 'wrong-kind' ? (kind === 'gps' ? 'cpcon' : 'gps') : kind, sourceMode: 'simulation', scopeKey: kind === 'gps' ? 'unit' : 'source', stageCode, stageLabel, observedAt: new Date(now() + offset).toISOString() };
        if (feed.scenario === 'missing-field') delete result.observedAt;
        return json(response, 200, result);
      }
      return json(response, 404, { code: 'NOT_FOUND' });
    } catch {
      return json(response, 400, { code: 'VALIDATION', message: '입력값을 확인하세요.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const allowedOrigins = (process.env.BNOC_MOCK_ALLOWED_ORIGINS ?? 'http://127.0.0.1:8081,http://127.0.0.1:8083').split(',');
  const server = createProvider({ secret: process.env.BNOC_MOCK_SECRET, allowedOrigins });
  server.listen(Number(process.env.BNOC_MOCK_PORT ?? 8082), '127.0.0.1', () => process.stdout.write('BNOC mock provider listening on loopback\n'));
}
