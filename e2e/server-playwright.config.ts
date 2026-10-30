import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const listing = process.argv.includes('--list');
const configuredEvidence = process.env.BNOC_TEST_EVIDENCE_DIR;
let evidence = configuredEvidence || path.resolve('runtime/evidence');
if (!listing) {
  if (configuredEvidence && !configuredEvidence.trim()) throw new Error('BNOC_TEST_EVIDENCE_DIR must not contain only whitespace');
  if (!configuredEvidence) {
    fs.mkdirSync(evidence, { recursive: true });
    evidence = fs.mkdtempSync(path.join(evidence, 'server-ui-'));
    process.env.BNOC_TEST_EVIDENCE_DIR = evidence;
  }
  console.info(`BNOC browser evidence: ${path.resolve(evidence)}`);
}

export default defineConfig({
  testDir: '.',
  testMatch: ['server-ui.spec.ts','reliability-ui.spec.ts','adaptive-intake.spec.ts','team-feedback.spec.ts'],
  timeout: 120000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: listing ? [['line']] : [['line'], ['json', { outputFile: path.resolve(evidence, 'server-browser-results.json') }]],
  outputDir: path.resolve(evidence, 'server-browser-artifacts'),
  use: {
    baseURL: process.env.BNOC_TEST_URL ?? 'http://127.0.0.1:8083',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 12000,
  },
  projects: ['chromium', 'firefox'].flatMap(browserName => [1280, 1440].map(width => ({
    name: `${browserName}-${width}`,
    use: { browserName: browserName as 'chromium' | 'firefox', viewport: { width, height: 900 } },
  }))),
});
