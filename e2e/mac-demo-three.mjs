// Real product UI, isolated localhost and memory responses only.
import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTestSession } from './survey-test-session.mjs';
import { previewPdf } from './document-preview-fixture.mjs';

assert(process.env.BNOC_MAC_THREE_EVIDENCE_DIR, 'Use a new dedicated evidence directory');
const before = process.argv.includes('--before');
const evidence = resolve(process.env.BNOC_MAC_THREE_EVIDENCE_DIR, before ? 'before' : 'after');
await mkdir(evidence, { recursive: false, mode: 0o700 });
const report = { before, passed: [], failures: [], errors: [], unexpected: [], writes: [], external: [], observations: [] };
const at = '2026-10-29T00:00:00Z';
const attachments = ['A', 'B'].map(id => ({ id, fileName: `${id}.pdf`, size: 1024, type: 'application/pdf' }));
const summary = { requestNumber: '100', requesterDisplayText: '요청자', category: '장비/체계', status: '대기', teamIds: [], updatedAt: at };
const detail = { ...summary, registeredAt: at, registeredBy: 'requester', revision: 1, detail: '회의실 장비 점검', location: '회의실', subcategories: {}, schedulePreferences: [], workItems: [], attachments, history: [] };
let server, base;
async function check(name, action) {
  try { await action(); report.passed.push(name); }
  catch (error) { report.failures.push({ name, message: error.message }); }
}
async function install(page, state) {
  await setTestSession(page, 'requester');
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== base) { report.external.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { report.writes.push({ method: request.method(), path }); return route.abort(); }
    let data;
    if (path === '/api/requests') data = { items: [{ ...summary, matches: [{ source: 'document', attachmentRef: 'A', text: '마이크 블록', blockIndex: 55 }, { source: 'document', attachmentRef: 'A', text: '마이크 정보', metadataIndex: 0 }] }], total: 1 };
    else if (path === '/api/requests/100') data = detail;
    else if (path === '/api/requests/100/history') data = { items: [], total: 0 };
    else if (/^\/api\/attachments\/[AB]\/document$/.test(path)) {
      const id = path.split('/')[3], offset = Number(url.searchParams.get('offset') || 0);
      state.documents.push({ id, offset });
      data = { attachmentRef: id, fileName: `${id}.pdf`, status: 'ready', parserVersion: 'fixture', offset, limit: 50, totalBlocks: 60, canRetry: false, blocks: Array.from({ length: Math.min(50, 60 - offset) }, (_, index) => ({ id: `${id}-${offset + index}`, type: 'paragraph', text: `${id} 마이크 본문 ${offset + index}` })), metadata: [{ label: '마이크 정보', rawValue: '회의실', blockId: 'A-55', source: 'fixture', evidence: '마이크 원문 근거' }] };
    } else if (/^\/api\/attachments\/[AB]\/inline$/.test(path)) return route.fulfill({ contentType: 'application/pdf', body: previewPdf() });
    else if (path === '/api/notifications') {
      const pageIndex = Number(url.searchParams.get('page') || 0);
      state.notifications.push(pageIndex);
      if (pageIndex === 1 && state.notificationMode === 'hold') {
        await new Promise(done => { state.releaseNotification = done; });
        return route.fulfill({ status: 503, json: { errorCode: 'SAVE_FAILED', message: '알림 조회 실패' } });
      }
      data = { items: Array.from({ length: pageIndex ? 1 : 20 }, (_, index) => ({ notificationId: `notification-${pageIndex * 20 + index}`, event: `확인한 알림 ${pageIndex * 20 + index + 1}`, at, read: true })), total: 21 };
    } else if (['/api/session', '/api/situation', '/api/notifications/unseen'].includes(path)) return route.fallback();
    else { report.unexpected.push(path); return route.fulfill({ status: 404, json: { errorCode: 'NOT_FOUND' } }); }
    return route.fulfill({ json: { data, queriedAt: at } });
  });
}
try {
  server = await createServer({ root: resolve('frontend'), cacheDir: resolve(evidence, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      for (const width of [1280, 1440]) {
        const label = `${engineName}-${width}`, state = { documents: [], notifications: [], notificationMode: 'hold' };
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block' });
        try {
          const page = await context.newPage(); page.setDefaultTimeout(5000);
          page.on('pageerror', error => report.errors.push({ label, message: error.message }));
          await install(page, state);
          const searchOpen = async text => {
            await page.goto(`${base}/requests`);
            await page.getByLabel('내용·문서 검색', { exact: true }).fill('마이크');
            await page.getByRole('button', { name: '검색', exact: true }).click();
            await page.getByRole('button', { name: `${text} · 문서 보기`, exact: true }).click();
            await expect(page.getByRole('dialog')).toBeVisible();
            await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toHaveText('A.pdf');
            await expect(page.locator('[data-document-search-hit]').first()).toBeVisible();
          };
          const close = async () => { await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); };
          const directOpen = async id => { await page.locator('.request-content p').filter({ has: page.getByRole('link', { name: `${id}.pdf`, exact: true }) }).getByRole('button', { name: '문서 보기', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toHaveText(`${id}.pdf`); await expect.poll(() => state.documents.at(-1)?.id).toBe(id); };
          await searchOpen('마이크 블록');
          await check(`${label}: search opens matching block`, async () => {
            assert.equal(state.documents.at(-1).offset, 50);
            await expect(page.locator('[data-document-block-index="55"]')).toHaveAttribute('data-document-search-target', 'true');
          });
          await close(); await directOpen('B');
          await check(`${label}: direct B clears prior search`, async () => {
            await expect(page.getByTitle('원본 PDF')).toBeVisible({ timeout: 1000 });
            assert.equal(state.documents.at(-1).offset, 0);
            await expect(page.locator('[data-document-search-hit]')).toHaveCount(0);
          });
          await close(); await directOpen('A');
          await check(`${label}: direct A clears prior search`, async () => {
            await expect(page.getByTitle('원본 PDF')).toBeVisible({ timeout: 1000 });
            assert.equal(state.documents.at(-1).offset, 0);
          });
          await page.getByRole('dialog').getByRole('button', { name: '원본 보기', exact: true }).click();
          await expect(page.getByTitle('원본 PDF')).toBeVisible();
          await check(`${label}: original hides extracted pagination`, async () => { await expect(page.locator('.document-dialog__footer')).toHaveCount(0, { timeout: 1000 }); });
          await page.screenshot({ path: resolve(evidence, `${label}-original.png`), fullPage: true });
          await page.getByRole('dialog').getByRole('button', { name: '추출 본문', exact: true }).click();
          // A stale search starts at 50 in the old implementation; reset through the real Previous action.
          if (await page.locator('.document-dialog__footer').getByRole('button', { name: '이전', exact: true }).isEnabled()) await page.locator('.document-dialog__footer').getByRole('button', { name: '이전', exact: true }).click();
          await expect(page.locator('.document-dialog__footer')).toContainText('1~50 / 60');
          await page.locator('.document-dialog__footer').getByRole('button', { name: '다음', exact: true }).click();
          await check(`${label}: extracted page and view roundtrip`, async () => {
            await expect(page.locator('.document-dialog__footer')).toContainText('51~60 / 60');
            await expect(page.locator('[data-document-block-index="59"]')).toBeVisible();
            await page.getByRole('dialog').getByRole('button', { name: '원본 보기', exact: true }).click();
            await expect(page.getByTitle('원본 PDF')).toBeVisible();
            await page.getByRole('dialog').getByRole('button', { name: '추출 본문', exact: true }).click();
            await expect(page.locator('.document-dialog__footer')).toContainText('51~60 / 60');
          });
          await close(); await searchOpen('마이크 정보');
          await check(`${label}: metadata search preserved`, async () => { await expect(page.locator('[data-document-metadata-index="0"]')).toHaveAttribute('data-document-metadata-target', 'true'); });
          await close();

          await page.goto(`${base}/notifications`);
          await expect(page.locator('.notification')).toHaveCount(20);
          await page.getByRole('button', { name: '다음 알림', exact: true }).click();
          await expect.poll(() => state.releaseNotification !== undefined).toBe(true);
          await check(`${label}: pending page identifies displayed data`, async () => {
            await expect(page.locator('.pagination')).toContainText('1페이지 · 21건', { timeout: 1000 });
            await expect(page.locator('.pagination')).toContainText('조회 선택 2페이지', { timeout: 1000 });
            await expect(page.locator('.notification').first()).toContainText('확인한 알림 1');
          });
          state.releaseNotification();
          await expect(page.getByRole('alert')).toContainText('알림 조회 실패');
          await check(`${label}: failed page identifies displayed data`, async () => {
            await expect(page.locator('.pagination')).toContainText('1페이지 · 21건', { timeout: 1000 });
            await expect(page.locator('.pagination')).toContainText('조회 선택 2페이지', { timeout: 1000 });
            await expect(page.locator('.notification')).toHaveCount(20);
          });
          await page.screenshot({ path: resolve(evidence, `${label}-notification-failed.png`), fullPage: true });
          state.notificationMode = 'success';
          await page.getByRole('button', { name: '다시 조회', exact: true }).click();
          await check(`${label}: retry displays actual second page`, async () => {
            await expect(page.locator('.notification')).toHaveCount(1);
            await expect(page.locator('.notification')).toContainText('확인한 알림 21');
            await expect(page.locator('.pagination')).toContainText('2페이지 · 21건');
            await expect(page.locator('.pagination')).not.toContainText('조회 선택');
          });
          report.observations.push({ label, documents: state.documents, notifications: state.notifications });
        } finally { state.releaseNotification?.(); await context.close(); }
      }
    } finally { await browser.close(); }
  }
} catch (error) { report.errors.push({ scope: 'harness', message: error.stack }); }
finally {
  await server?.close(); await rm(resolve(evidence, 'vite-cache'), { recursive: true, force: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ before, passed: report.passed.length, failures: report.failures.map(item => item.name), errors: report.errors, unexpected: report.unexpected, writes: report.writes, external: report.external }));
if (report.errors.length || report.unexpected.length || report.writes.length || report.external.length || (!before && report.failures.length)) process.exitCode = 1;
if (before && (report.failures.length !== 20 || report.failures.some(item => !/direct [AB] clears|original hides|pending page identifies|failed page identifies/.test(item.name)))) process.exitCode = 1;
