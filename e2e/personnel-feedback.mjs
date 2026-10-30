// Product UI with isolated memory responses; existing services and storage are never contacted.
import { chromium, firefox, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTestSession, teamIds } from './survey-test-session.mjs';

assert(process.env.BNOC_PERSONNEL_FEEDBACK_EVIDENCE_DIR, 'Set a new dedicated evidence directory');
const evidence = resolve(process.env.BNOC_PERSONNEL_FEEDBACK_EVIDENCE_DIR);
await mkdir(evidence, { recursive: false, mode: 0o700 });
const report = { checks: [], failures: [], errors: [], unexpected: [], commands: [], actualBusinessWrites: 0 };
const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const at = `${date}T00:00:00.000Z`;
const people = Array.from({ length: 8 }, (_, index) => ({
  personRef: `feedback-member-${index}`, department: teamIds[0], displayName: index ? `추가인원${index}` : '담당인원',
  category: '간부', rank: '대위', active: true, complete: true, serviceNumber: `10000${index}`, internalPhone: '1234',
  absences: index < 2 ? [{ absenceRef: `absence-${index}`, absenceType: index ? '출장' : '휴가', startDate: date, endDate: date, revision: 1 }] : []
}));
let server, base;
async function check(name, action) {
  try { await action(); report.checks.push(name); }
  catch (error) { report.failures.push({ name, message: error.stack || String(error) }); }
}
async function install(page, label) {
  await setTestSession(page, 'bnoc');
  let attempts = 0, saved = false;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== base) { report.unexpected.push(request.url()); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/commands' && request.method() === 'POST') {
      const command = request.postDataJSON(); report.commands.push({ label, command });
      assert.equal(command.type, 'saveAbsenceBatch'); attempts++;
      if (attempts === 1) return route.fulfill({ status: 400, json: { errorCode: 'VALIDATION', message: '입력값을 확인하세요.', fieldErrors: { text: '2줄: 선택 부서의 활성 명부와 일치해야 합니다.' } } });
      saved = true;
      return route.fulfill({ json: { ok: true, publicRef: 'absence-batch|' + teamIds[0], revision: 1 } });
    }
    if (request.method() !== 'GET') { report.unexpected.push(`${request.method()} ${path}`); return route.abort(); }
    let data;
    if (path === '/api/personnel-roster') data = { revision: 7, entries: people.map(person => ({ ...person, absences: saved && person.personRef === people[2].personRef ? [{ absenceRef: 'saved-absence', absenceType: '교육', startDate: '2026-12-01', endDate: '2026-12-02', revision: 1 }] : person.absences })) };
    else if (path === '/api/personnel') data = { date: url.searchParams.get('date'), total: 8, absent: 2, current: 6, departments: [{ department: teamIds[0], total: 8, absent: 2, current: 6, byAbsenceType: { 휴가: 1, 출장: 1 } }] };
    else if (path === '/api/duty-schedules') data = { entries: [] };
    else if (['/api/session', '/api/situation', '/api/notifications/unseen', '/api/work-overview'].includes(path)) return route.fallback();
    else { report.unexpected.push(path); return route.fulfill({ status: 404, json: { errorCode: 'NOT_FOUND' } }); }
    return route.fulfill({ json: { data, queriedAt: at } });
  });
}
try {
  server = await createServer({ root: resolve('frontend'), cacheDir: resolve(evidence, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, logLevel: 'error' });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      for (const width of [1280, 1440]) {
        const label = `${engineName}-${width}`;
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block' });
        try {
          const page = await context.newPage(); page.setDefaultTimeout(5000);
          page.on('pageerror', error => report.errors.push({ label, message: error.message }));
          page.on('dialog', dialog => dialog.accept());
          await install(page, label);
          await page.goto(base + '/personnel');
          await check(label + ': daily absence types and people visible', async () => {
            const types = page.getByLabel('부재 구분별 인원'), list = page.getByLabel('부재자 명단');
            await expect(types).toBeVisible(); await expect(types).toContainText('휴가 1명'); await expect(types).toContainText('출장 1명');
            await expect(list).toBeVisible(); await expect(list.locator('li')).toHaveCount(2);
            await expect(list).toContainText('대위 담당인원'); await expect(list).toContainText('대위 추가인원1');
            assert.equal(await list.locator('details:not([open])').count(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          });
          await page.screenshot({ path: resolve(evidence, `${label}-personnel.png`), fullPage: true });
          await page.goto(base + '/roster');
          await page.getByRole('button', { name: '부재 등록', exact: true }).click();
          await page.getByRole('button', { name: '텍스트로 일괄 추가', exact: true }).click();
          await page.getByRole('combobox', { name: /^대상 부서/ }).selectOption(teamIds[0]);
          const text = '대위 담당인원 휴가 20261201 20261202\n대위 추가인원2 교육 2026-12-01 2026-12-02';
          await page.getByLabel('부재 목록', { exact: true }).fill(text);
          await check(label + ': invalid row preserves batch text and shows row feedback', async () => {
            await page.getByRole('button', { name: '입력한 부재 일괄 등록', exact: true }).click();
            await expect(page.getByRole('alert')).toContainText('2줄:');
            await expect(page.getByLabel('부재 목록', { exact: true })).toHaveValue(text);
            const command = report.commands.filter(item => item.label === label).at(-1).command;
            assert.equal(command.expectedRevision, 7); assert.equal(command.payload.department, teamIds[0]); assert.equal(command.payload.text, text);
          });
          await page.screenshot({ path: resolve(evidence, `${label}-absence-error.png`), fullPage: true });
          await check(label + ': batch submit saves and reloads roster', async () => {
            await page.getByRole('button', { name: '입력한 부재 일괄 등록', exact: true }).click();
            await expect(page.getByRole('status')).toContainText('입력한 부재 기간을 일괄 등록했습니다.');
            await expect(page.getByLabel('부재 목록', { exact: true })).toHaveCount(0);
            await expect(page.locator('.personnel-absence').filter({ hasText: '교육' })).toContainText('12-01~12-02');
          });
          await page.goto(base + '/night-duty');
          await page.getByRole('button', { name: '월', exact: true }).click();
          await check(label + ': monthly duty shows four candidates at once', async () => {
            const candidates = page.locator('.duty-candidates'); await expect(candidates.locator('.duty-person')).toHaveCount(8);
            await candidates.scrollIntoViewIfNeeded();
            const size = await candidates.evaluate(element => {
              const box = element.getBoundingClientRect(), editor = element.closest('.duty-editor').getBoundingClientRect();
              const top = Math.max(box.top, editor.top, 0), bottom = Math.min(box.bottom, editor.bottom, innerHeight);
              const visible = [...element.querySelectorAll('.duty-person')].filter(person => { const rect = person.getBoundingClientRect(); return rect.top >= top && rect.bottom <= bottom; }).length;
              return { height: box.height, visible };
            });
            assert(size.height >= 280, JSON.stringify(size)); assert(size.visible >= 4, JSON.stringify(size));
            report.checks.push({ label, candidateGeometry: size });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          });
          await page.screenshot({ path: resolve(evidence, `${label}-duty-candidates.png`) });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} catch (error) { report.failures.push({ name: 'runner', message: error.stack || String(error) }); }
finally {
  if (server) await server.close();
  await rm(resolve(evidence, 'vite-cache'), { recursive: true, force: true });
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, errors: report.errors, unexpected: report.unexpected, commands: report.commands.length, actualBusinessWrites: report.actualBusinessWrites }));
if (report.failures.length || report.errors.length || report.unexpected.length) process.exitCode = 1;
