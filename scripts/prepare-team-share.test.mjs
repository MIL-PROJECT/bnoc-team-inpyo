import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { allowedPath, prepareTeamShare, secretFindings, shareText } from './prepare-team-share.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bnoc-team-share-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Snapshot Test');
  for (const [path, content] of Object.entries({ 'README.md': '# BNOC\n\nGuide.\n', ...files })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

test('allowlist excludes tracked runtime, raw documents, secrets and generated files', () => {
  for (const path of ['.local/secrets.json', 'runtime/data/db', 'docs/sources/original.pdf',
    'docs/설문조사및스크린샷/1.pdf', 'backend/build/app.jar', 'frontend/node_modules/a.js',
    '요구사항.md', 'docs/업무검증기록.md', 'frontend/.env', 'frontend/.env.local', '.codex/private.pem', '.git/config', '../README.md']) assert.equal(allowedPath(path), false, path);
  for (const path of ['Dockerfile', 'compose.yaml', 'design/tokens.css', '.github/workflows/team-ci.yml',
    '.codex/agents/verifier.toml', 'scripts/bnoc-team.mjs', 'docker/entrypoint.mjs',
    'backend/src/main/kotlin/bnoc/Application.kt', 'docs/records/업무검증기록.md']) assert.equal(allowedPath(path), true, path);
});

test('known credential formats and local personal paths rejected without printing their values', () => {
  const cases = [
    ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['github-token', 'gh' + 'p_' + 'a'.repeat(36)],
    ['openai-token', 'sk-' + 'proj-' + 'a'.repeat(30)],
    ['aws-key', 'AK' + 'IA' + 'A'.repeat(16)],
    ['credential-url', 'https://' + 'account:secret@example.invalid'],
    ['local-user-path', '/Users' + '/someone/project/file'],
    ['local-user-path', 'C:' + '\\Users\\someone\\project'],
    ['personal-phone', '010' + '-1234-5678'],
  ];
  for (const [kind, value] of cases) assert.ok(secretFindings('README.md', value).includes(kind), kind);
  assert.deepEqual(secretFindings('backend/application.properties', 'password=${BNOC_DB_PASSWORD:}\nhttp://127.0.0.1:8081'), []);
});

test('snapshot omits raw files and history, retains product bytes and private evidence provenance', async t => {
  const root = await fixture(t, {
    'frontend/src/app.ts': 'export const value = 1;\n',
    'runtime/evidence/private.json': 'raw evidence',
    'docs/sources/source.pdf': 'private original',
    'docs/records/업무검증기록.md': '[검증](../../runtime/evidence/private.json)\n[요구](../spec/요구사항.md)\n',
    'docs/spec/요구사항.md': '# 요구\n',
  });
  await writeFile(join(root, 'frontend/untracked.ts'), 'untracked');
  const manifest = await prepareTeamShare({ root, name: 'success', require: ['README.md'] });
  const output = join(root, manifest.output);
  assert.equal(await readFile(join(output, 'frontend/src/app.ts'), 'utf8'), 'export const value = 1;\n');
  const log = await readFile(join(output, 'docs/records/업무검증기록.md'), 'utf8');
  assert.match(log, /비공개 원본 이력/);
  assert.match(log, /\[요구\]\(\.\.\/spec\/요구사항.md\)/);
  assert.ok(!(await readdir(output)).includes('.git'));
  assert.ok(!(await readdir(output)).includes('runtime'));
  assert.ok(!(await readdir(join(output, 'frontend'))).includes('untracked.ts'));
  const product = manifest.manifest.find(file => file.path === 'frontend/src/app.ts');
  assert.equal(product.sourceSha256, product.shareSha256);
  assert.equal(manifest.rawGitHistoryIncluded, false);
});

test('missing required file and modified committed files stop packaging', async t => {
  const root = await fixture(t);
  await assert.rejects(prepareTeamShare({ root, name: 'missing', require: ['Dockerfile'] }), /TEAM_SHARE_REQUIRED_FILE_MISSING/);
  await writeFile(join(root, 'README.md'), '# Changed\n');
  await assert.rejects(prepareTeamShare({ root, name: 'dirty', require: ['README.md'] }), /TEAM_SHARE_COMMIT_CHANGES_FIRST/);
});

test('tracked secret injection fails preflight and leaves no output snapshot', async t => {
  const root = await fixture(t, { 'frontend/secret.txt': 'gh' + 'p_' + 'a'.repeat(36) });
  await assert.rejects(prepareTeamShare({ root, name: 'secret', require: ['README.md'] }), /TEAM_SHARE_SENSITIVE_CONTENT: frontend\/secret.txt: github-token/);
  await assert.rejects(readdir(join(root, '.local/team-share/secret')), { code: 'ENOENT' });
});

test('tracked symlink cannot copy outside source', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'frontend'));
  await symlink('../README.md', join(root, 'frontend/link.md'));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'symlink');
  await assert.rejects(prepareTeamShare({ root, name: 'symlink', require: ['README.md'] }), /TEAM_SHARE_UNSAFE_FILE/);
});

test('existing snapshot never overwritten and path traversal rejected', async t => {
  const root = await fixture(t);
  await prepareTeamShare({ root, name: 'repeat', require: ['README.md'] });
  await assert.rejects(prepareTeamShare({ root, name: 'repeat', require: ['README.md'] }), /TEAM_SHARE_OUTPUT_EXISTS/);
  await assert.rejects(prepareTeamShare({ root, name: '../../elsewhere', require: ['README.md'] }), /TEAM_SHARE_INVALID_NAME/);
});

test('personal preparation data generalized only in share text and references stay historical', () => {
  const original = '# 대회\n\n참가 희망자: 공군 병사.\n**사용자 확인(2026-09-10):** 본인은 공군 병사이며 30110 특기.\n**추가 작업 전제:** 본인은 BNOC 소속이며 하루 3시간·주 21시간.\n### 본인의 개발환경 계획\n집에 있는 개인 PC\n## 8. 제출물\n';
  const { text, changes } = shareText('docs/reference/대회정보.md', original, new Set());
  assert.deepEqual(secretFindings('docs/reference/대회정보.md', text), []);
  assert.match(text, /## 8\. 제출물/);
  assert.ok(changes.includes('personal-preparation-generalized'));
  assert.match(original, /30110/);
});
