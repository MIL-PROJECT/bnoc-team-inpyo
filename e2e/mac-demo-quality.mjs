// Isolated product UI with memory responses. Never connects to existing services or storage.
import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTestSession, teamIds } from './survey-test-session.mjs';

const before = process.argv.includes('--before');
assert(process.env.BNOC_MAC_DEMO_EVIDENCE_DIR, 'Set a new, dedicated evidence directory');
const evidence = resolve(process.env.BNOC_MAC_DEMO_EVIDENCE_DIR, before ? 'before' : 'after');
await mkdir(evidence, { recursive: false, mode: 0o700 });
const report = { before, checks: [], failures: [], pageErrors: [], unexpected: [], writes: [], external: [], workQueries: [] };
const at = '2026-10-29T00:00:00.000Z';
const preview = '회의실 마이크 음성 끊김 확인 요청';
const location = '본관 2층 회의실';
const summaries = [
  { requestNumber: '20', detailPreview: preview, location, canReuse: true },
  { requestNumber: '19', detailPreview: '장비 점검 '.repeat(24), location: '길이가긴위치'.repeat(24), canReuse: true },
  { requestNumber: '18', canReuse: false }
].map(item => ({ requesterDisplayText: '요청자', category: '장비/체계', status: '대기', teamIds: [], updatedAt: at, ...item }));
const works = Array.from({ length: 42 }, (_, index) => ({
  workNumber: `RETURN-${index}`, requestNumber: String(index + 100), teamId: teamIds[index % 2],
  category: '장비/체계', workType: '고장', status: '반환', source: 'assigned', canOpenDetail: true,
  requesterContact: '000-1001', scheduleIntervals: [], priority: 'general'
}));
const counts = { assigned: 43, completed: 0, remaining: 43, returned: 42, unassigned: 0, planned: 0, all: 43, allCompleted: 0, allRemaining: 43 };
let server, base;
async function check(name, action) {
  try { await action(); report.checks.push(name); }
  catch (error) { report.failures.push({ name, message: error.message }); }
}
async function install(page, role, workQueries = []) {
  await setTestSession(page, role);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== base) { report.external.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { report.writes.push({ path, method: request.method() }); return route.abort(); }
    let data;
    if (path === '/api/requests') data = { items: summaries.map(item => role === 'requester' ? item : { ...item, detailPreview: undefined, location: undefined, canReuse: false }), total: 3 };
    else if (path === '/api/work-overview') {
      const bucket = url.searchParams.get('bucket'), pageIndex = Number(url.searchParams.get('page') || 0), selectedTeams = (url.searchParams.get('teamIds') || '').split(',').filter(Boolean);
      if (url.searchParams.get('size') === '20') { const criteria = Object.fromEntries(url.searchParams); workQueries.push(criteria); report.workQueries.push(criteria); }
      let items = bucket === 'returned' ? works : [{ ...works[0], workNumber: 'ASSIGNED-1', status: '배정' }, ...works];
      if (selectedTeams.length) items = items.filter(item => selectedTeams.includes(item.teamId));
      const status = url.searchParams.get('status');
      if (status) items = items.filter(item => item.status === status);
      data = { counts, byDepartment: teamIds.map((department, index) => ({ department, assigned: index < 2 ? 22 - index : 0, completed: 0, remaining: index < 2 ? 22 - index : 0, returned: index < 2 ? 21 : 0 })), items: items.slice(pageIndex * 20, pageIndex * 20 + 20), total: items.length };
    } else if (path === '/api/request-draft') data = { revision: 0, draft: null };
    else if (path === '/api/requesters') data = { items: [{ requesterRef: 'requester', displayName: '요청자', department: '요청 부서' }], total: 1 };
    else if (['/api/session', '/api/notifications/unseen', '/api/situation'].includes(path)) return route.fallback();
    else { report.unexpected.push(path); return route.fulfill({ status: 404, json: { errorCode: 'NOT_FOUND' } }); }
    return route.fulfill({ json: { data, queriedAt: at } });
  });
}
async function menu(page, label) {
  await page.getByRole('navigation', { name: '주 메뉴' }).locator('summary').filter({ hasText: '부대 현황' }).click();
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: label, exact: true }).click();
}
try {
  server = await createServer({
    root: resolve('frontend'), cacheDir: resolve(evidence, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: 'error'
  });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      for (const width of [1280, 1440]) {
        const label = `${engineName}-${width}`;
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(3000);
          page.on('pageerror', error => report.pageErrors.push({ label, message: error.message }));
          await install(page, 'requester');
          await page.goto(`${base}/requests`);
          await expect(page.locator('tbody tr')).toHaveCount(3);
          await check(`${label}: request preview and location`, async () => {
            await expect(page.locator('tbody tr').first()).toContainText(preview);
            await expect(page.locator('tbody tr').first()).toContainText(location);
            await expect(page.locator('tbody tr').last()).not.toContainText('undefined');
          });
          await check(`${label}: list controls and layout`, async () => {
            assert.deepEqual(await page.locator('tbody td:first-child button.link').allTextContents(), ['20', '19', '18']);
            await expect(page.getByRole('button', { name: '신청 20 내용 불러오기' })).toBeVisible();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.getByLabel('내용·문서 검색', { exact: true }).fill('마이크');
            await page.getByRole('button', { name: '검색', exact: true }).click();
            await expect(page.getByLabel('내용·문서 검색', { exact: true })).toHaveValue('마이크');
            await page.getByRole('button', { name: '초기화', exact: true }).click();
          });
          await page.screenshot({ path: resolve(evidence, `${label}-request-list.png`), fullPage: true });
        } finally { await context.close(); }

        const contextBnoc = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block' });
        try {
          const page = await contextBnoc.newPage();
          page.setDefaultTimeout(3000);
          page.on('pageerror', error => report.pageErrors.push({ label, message: error.message }));
          const workQueries = [];
          await install(page, 'bnoc', workQueries);
          await page.goto(`${base}/requests`);
          await expect(page.locator('tbody tr')).toHaveCount(3);
          await check(`${label}: missing previews stay absent`, async () => {
            await expect(page.locator('tbody')).not.toContainText(preview);
            await expect(page.locator('tbody')).not.toContainText(location);
            await expect(page.locator('tbody')).not.toContainText('undefined');
          });
          await expect(page.getByRole('button', { name: '반환 처리 대기 42', exact: true })).toBeVisible();
          await page.getByRole('button', { name: '반환 처리 대기 42', exact: true }).click();
          await check(`${label}: returned shortcut from another page`, async () => {
            await expect(page.locator('#shared-work-list-title')).toHaveText('반환 대기 작업 목록');
            await expect(page.getByRole('combobox', { name: /^목록 종류/ })).toHaveValue('returned');
            await expect(page.getByRole('group', { name: '부서 선택' }).getByRole('checkbox', { name: '전체', exact: true })).toBeChecked();
          });
          await page.getByRole('combobox', { name: /^목록 종류/ }).selectOption('assigned');
          await expect(page.locator('#shared-work-list-title')).toHaveText('할당 작업 목록');
          await page.getByRole('group', { name: '부서 선택' }).getByLabel(teamIds[0], { exact: true }).check();
          await page.getByLabel('작업 상태', { exact: true }).selectOption('반환');
          await page.getByRole('button', { name: '상세 조회 조건', exact: true }).click();
          await page.getByRole('combobox', { name: /^지원 유형/ }).selectOption('장비/체계');
          await page.getByRole('combobox', { name: /^체계 종류/ }).selectOption('인터넷');
          await page.getByRole('combobox', { name: /^작업 유형/ }).selectOption('고장');
          await page.getByRole('combobox', { name: /^일반·긴급/ }).selectOption('general');
          await page.getByRole('button', { name: '검색', exact: true }).click();
          await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(20);
          assert.equal(workQueries.at(-1).teamIds, teamIds[0]);
          assert.equal(workQueries.at(-1).status, '반환');
          assert.deepEqual(Object.fromEntries(['teamIds', 'category', 'workType', 'systemType', 'status', 'priority'].map(key => [key, workQueries.at(-1)[key]])), { teamIds: teamIds[0], category: '장비/체계', workType: '고장', systemType: '인터넷', status: '반환', priority: 'general' });
          await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
          await expect(page.locator('.pagination')).toContainText('2페이지');
          await page.getByRole('group', { name: '부서 선택' }).getByLabel(teamIds[0], { exact: true }).uncheck();await page.getByRole('group', { name: '부서 선택' }).getByLabel(teamIds[1], { exact: true }).check();
          await page.getByRole('button', { name: '반환 처리 대기 42', exact: true }).click();
          await check(`${label}: returned shortcut resets existing overview`, async () => {
            await expect(page.locator('#shared-work-list-title')).toHaveText('반환 대기 작업 목록');
            await expect(page.getByRole('combobox', { name: /^목록 종류/ })).toHaveValue('returned');
            await expect(page.getByRole('group', { name: '부서 선택' }).getByRole('checkbox', { name: '전체', exact: true })).toBeChecked();
            await expect(page.getByLabel('작업 상태', { exact: true })).toHaveValue('');
            await expect(page.locator('.pagination')).toContainText('1페이지');
            await expect(page.locator('.shared-work-detail tbody tr')).toHaveCount(20);
            const request = workQueries.at(-1);
            assert.equal(request.bucket, 'returned'); assert.equal(request.page, '0');
            for (const field of ['teamIds', 'category', 'workType', 'systemType', 'status', 'priority']) assert(!request[field], `residual filter ${field}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          });
          await page.screenshot({ path: resolve(evidence, `${label}-returned.png`), fullPage: true });
          await page.getByRole('button', { name: 'BNOC 업무 관리', exact: true }).click();
          await menu(page, '부서별 작업 현황');
          await check(`${label}: normal overview entry unchanged`, async () => {
            await expect(page.locator('#shared-work-list-title')).toHaveText('할당 작업 목록');
            await expect(page.getByRole('combobox', { name: /^목록 종류/ })).toHaveValue('assigned');
          });
        } finally { await contextBnoc.close(); }
      }
    } finally { await browser.close(); }
  }
} catch (error) { report.failures.push({ name: 'harness', message: error.stack }); }
finally {
  await server?.close();
  await rm(resolve(evidence, 'vite-cache'), { recursive: true, force: true });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ before, passed: report.checks.length, failures: report.failures.map(item => item.name), pageErrors: report.pageErrors, unexpected: report.unexpected, writes: report.writes, external: report.external }));
if (report.pageErrors.length || report.unexpected.length || report.writes.length || report.external.length || (!before && report.failures.length)) process.exitCode = 1;
if (before && (report.failures.length !== 12 || report.failures.some(item => !/request preview|returned shortcut/.test(item.name)))) process.exitCode = 1;
