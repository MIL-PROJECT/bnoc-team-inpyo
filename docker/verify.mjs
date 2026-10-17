import { readFile, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const env = { ...process.env, BNOC_TEST_URL: 'http://127.0.0.1:8083', BNOC_TEST_PROVIDER_URL: 'http://127.0.0.1:8082',
  BNOC_TEST_EVIDENCE_DIR: '/evidence', BNOC_MOCK_SECRET: (await readFile('/run/secrets/mock_secret', 'utf8')).trim() };
await cp('/app/backend-unit-results', '/evidence/backend-unit-results', { recursive: true });
for (const args of [['--test', 'e2e/server-api.test.mjs'], ['node_modules/@playwright/test/cli.js', 'test', '--config=e2e/server-playwright.config.ts']]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
