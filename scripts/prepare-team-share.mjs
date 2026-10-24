import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFiles = new Set([
  '.gitignore', '.dockerignore', '.gitattributes', 'Dockerfile', 'compose.yaml', 'compose.dev.yaml', 'design/tokens.css',
  'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'playwright.config.ts',
]);
const documents = new Set([
  'docs/spec/요구사항.md', 'docs/spec/유스케이스.md', 'docs/spec/시스템요구사항.md',
  'docs/spec/아키텍처설계.md', 'docs/spec/아키텍처설계.html', 'docs/spec/개발명세서.md',
  'docs/reference/대회정보.md', 'docs/reference/조사근거.md', 'docs/records/개발진행.md', 'docs/records/작업기록.md',
  'docs/records/AI활용기록.md', 'docs/records/업무검증기록.md', 'docs/reference/AI개발방식_비교와도입안.md',
]);
const prefixes = ['frontend/', 'backend/', 'mock-provider/', 'scripts/', 'e2e/',
  'experiments/ai-workflow/', '.agents/', '.codex/', '.github/', 'docker/'];
const excludedParts = new Set(['node_modules', '.git', '.gradle', 'build', 'dist',
  'coverage', 'playwright-report', 'test-results', '.local', 'runtime']);
const hwpFixturePath = 'frontend/src/preview/fixtures/support.hwp';
const hwpFixtureSha256 = 'fe13916c67f52be612f9301296af2c015ad609b644c47dad6f9f739198085bd8';
export const requiredFiles = [
  'README.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'Dockerfile',
  'compose.yaml', 'compose.dev.yaml', '.dockerignore', 'design/tokens.css', 'backend/build.gradle.kts',
  'backend/src/main/resources/application.properties', 'frontend/package.json',
  'frontend/pnpm-lock.yaml', 'mock-provider/server.mjs',
  '.agents/skills/bnoc-workflow/SKILL.md', '.codex/config.toml',
  '.github/workflows/team-ci.yml', 'scripts/check-team-handoff.mjs',
  'docker/development.mjs', 'docker/development-backend.mjs', 'docker/development.gradle', 'docker/vite.dev.config.mjs', 'docker/development.test.mjs',
  ...documents,
];

export function allowedPath(path) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part =>
    part === '..' || excludedParts.has(part) || /^\.env(?:\.|$)/.test(part) ||
    /\.(?:pem|p12|pfx|jks|keystore|sql|dump|pdf|zip|jar|war|class|log)$/i.test(part))) return false;
  return rootFiles.has(path) || documents.has(path) || prefixes.some(prefix => path.startsWith(prefix));
}

// These checks stop known credential formats; they do not replace a human review.
export function secretFindings(path, content) {
  // These invalid subscriber numbers are deliberate test values, never contact data.
  if (/^(?:backend\/src\/test\/|frontend\/src\/.*\.test\.mjs$|e2e\/server-ui\.spec\.ts$)/.test(path)) {
    content = content.replace(/\b010-0000-000[01]\b/g, '');
  }
  const patterns = [
    ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['openai-token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
    ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['credential-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
    ['local-user-path', /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/i],
    ['personal-phone', /\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b/],
  ];
  const found = patterns.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
  if (path === 'docs/reference/대회정보.md' && /30110|본인은 BNOC|하루 3시간|주 21시간|집에 있는 개인 PC/.test(content)) found.push('personal-preparation');
  return found;
}

export function shareText(path, text, selected) {
  const changes = [];
  if (path === 'docs/reference/대회정보.md') {
    const before = text;
    text = text.replace('참가 희망자: 공군 병사.', '개인 참가 준비 정보는 공유본에서 제외했다.')
      .replaceAll('본인에게 필요한 확인', '참가팀 확인 사항')
      .replace('공군 병사라는 사실만으로 종목 자격 확정 불가', '종목 자격은 참가팀별 확인')
      .replace('본인 **30110** 특기 확인. 장교 참가 예정으로 전달받음', '참가자 특기와 장교 포함 여부 확인')
      .replace('부서 간부 참가 예정. 최종 3인 명단·팀장·부대 출전 절차 정리', '최종 3인 명단·팀장·부대 출전 절차 확인')
      .replace(/^\*\*사용자 확인\(2026-09-10\):\*\* 본인은.*$/m, '개인 특기·소속·참가 준비 현황은 공유본에서 제외했다.')
      .replace(/^\*\*추가 작업 전제:\*\*.*$/m, '개인 소속·작업시간·인터뷰 접근 경로는 공유본에서 제외했다.')
      .replace(/### 본인의 개발환경 계획[\s\S]*?(?=\n## 8\.)/, '### 개발환경 준비\n\n개인 개발 PC·원격접속 준비 정보는 공유본에서 제외했다. 개발 환경과 현장 시연 환경은 별도로 확인한다.\n')
      .replace('30110 특기·장교 참가 예정 반영 후 제외부대 여부, 최종 3인 명단·팀장 정리', '참가자 자격·제외부대 여부·최종 3인 명단·팀장 확인')
      .replace('개인 PC 원격접속의 부대 내 허용 여부·접속 단말·연결 안정성', '개발환경 이용 조건 확인')
      .replace('개인 PC 개발환경·AI 접속·백업 방법·이용시간·비용 부담', '개발 도구·AI 접속·백업·이용 조건 확인')
      .replace(/^\| 2026-09-10 \| 사용자 추가 설명 \|.*\|$/gm, '| 2026-09-10 | 사용자 추가 설명 | 개인 참가·개발 준비 정보 반영. 상세는 비공개 원본에 보존 |');
    if (before !== text) changes.push('personal-preparation-generalized');
  }
  if (/\.(?:md|html)$/.test(path)) {
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, target) => {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) return whole;
      let file;
      try { file = decodeURIComponent(target.split('#')[0]); } catch { return whole; }
      if (!file) return whole;
      const absolute = resolve(dirname(resolve('/', path)), file);
      const local = relative('/', absolute).split(sep).join('/');
      if (selected.has(local)) return whole;
      changes.push('private-reference-as-text');
      return `${label} (비공개 원본 이력: \`${target}\`)`;
    });
    if (path === 'README.md') {
      const notice = '> 팀 공유 스냅샷: 원본 설문·스크린샷·첨부 원문·실행 DB/첨부·비밀·원시 검증 증거와 원 저장소 Git 이력은 제외했다. 과거 커밋·증거 경로는 비공개 원본 이력이며 이 저장소에서 조회되지 않는다.\n\n';
      if (!text.includes(notice)) {
        text = text.replace(/^(# .+\n\n)/, `$1${notice}`);
        changes.push('snapshot-boundary-notice');
      }
    }
  }
  return { text, changes: [...new Set(changes)] };
}

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();

export async function prepareTeamShare({ root, name, evidenceRoot, require = requiredFiles }) {
  root = await realpath(root);
  const commit = git(root, 'rev-parse', 'HEAD');
  name ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) throw new Error('TEAM_SHARE_INVALID_NAME');
  const output = join(root, '.local/team-share', name);
  try { await lstat(output); throw new Error('TEAM_SHARE_OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tracked = git(root, 'ls-files', '-z').split('\0').filter(Boolean);
  const selected = new Set(tracked.filter(allowedPath));
  for (const path of require) if (!selected.has(path)) throw new Error(`TEAM_SHARE_REQUIRED_FILE_MISSING: ${path}`);
  const dirty = git(root, 'diff', 'HEAD', '--name-only', '-z').split('\0').filter(path => selected.has(path));
  if (dirty.length) throw new Error(`TEAM_SHARE_COMMIT_CHANGES_FIRST: ${dirty.join(', ')}`);
  const prepared = [];
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const path of [...selected].sort()) {
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`TEAM_SHARE_UNSAFE_FILE: ${path}`);
    const bytes = await readFile(absolute);
    const approvedFixture = path === hwpFixturePath && hash(bytes) === hwpFixtureSha256;
    if (bytes.length > 5_000_000 || (!approvedFixture && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))) throw new Error(`TEAM_SHARE_REVIEW_BINARY_OR_LARGE_FILE: ${path}`);
    const { text, changes } = approvedFixture ? { text: null, changes: [] } : shareText(path, bytes.toString('utf8'), selected);
    const findings = approvedFixture ? [] : secretFindings(path, text);
    if (findings.length) throw new Error(`TEAM_SHARE_SENSITIVE_CONTENT: ${path}: ${findings.join(', ')}`);
    prepared.push({ path, original: bytes, bytes: approvedFixture ? bytes : Buffer.from(text), changes, executable: !!(stat.mode & 0o111) });
  }
  // No output is created until the entire candidate snapshot passes the checks.
  await mkdir(dirname(output), { recursive: true });
  if (await realpath(dirname(output)) !== dirname(output)) throw new Error('TEAM_SHARE_UNSAFE_OUTPUT_PARENT');
  await mkdir(output);
  try {
    for (const file of prepared) {
      const target = join(output, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
    }
    const manifest = {
      status: 'prepared_not_uploaded', sourceCommit: commit, createdAt: new Date().toISOString(),
      output: relative(root, output), rawGitHistoryIncluded: false, files: prepared.length,
      exclusions: ['raw-git-history', 'untracked-files', 'raw-pdfs-and-surveys', 'runtime-data-and-evidence', 'local-secrets', 'build-output'],
      limitations: ['Pattern checks cannot establish that arbitrary text is free of confidential information. Review before publication.'],
      manifest: prepared.map(file => ({ path: file.path, sourceSha256: hash(file.original), shareSha256: hash(file.bytes), bytes: file.bytes.length, transformations: file.changes })),
    };
    evidenceRoot ??= join(root, 'runtime/evidence/team-collaboration-20261017');
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `team-share-${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--name')) throw new Error('Usage: node scripts/prepare-team-share.mjs [--name NAME]');
    const result = await prepareTeamShare({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), name: args[1] });
    console.log(JSON.stringify({ status: result.status, output: result.output, sourceCommit: result.sourceCommit, files: result.files }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
