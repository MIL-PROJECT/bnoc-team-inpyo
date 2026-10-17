import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');
const required = ['Dockerfile', 'compose.yaml', '.dockerignore', '.gitattributes',
  'AGENTS.md', 'README.md', '.agents/skills/bnoc-workflow/SKILL.md',
  '.codex/config.toml', '.codex/agents/spec-mapper.toml', '.codex/agents/reviewer.toml', '.codex/agents/verifier.toml',
  '.github/workflows/team-ci.yml', '.github/pull_request_template.md',
  'design/tokens.css', 'scripts/bnoc-team.mjs', 'docker/supervisor.mjs'];
for (const path of required) await access(resolve(root, path));
const commands = JSON.parse(await read('package.json')).scripts;
for (const action of ['doctor','up','verify','status','down']) assert.equal(commands[`team:${action}`], `node scripts/bnoc-team.mjs ${action}`);
const compose = await read('compose.yaml');
assert.match(compose, /127\.0\.0\.1:\$\{BNOC_TEAM_PORT/);
assert.match(compose, /condition: service_healthy/);
assert.match(compose, /database:\/var\/lib\/mysql/);
assert.match(compose, /attachments:\/data\/attachments/);
const dockerfile = await read('Dockerfile');
assert.match(dockerfile, /BNOC_PROVIDER_URL=http:\/\/127\.0\.0\.1:8082/);
assert.match(dockerfile, /frozen-lockfile/);
assert.match(dockerfile, /design\/tokens\.css/);
const ignore = await read('.dockerignore');
assert.ok(ignore.startsWith('**\n'), 'Docker context must use explicit source allowlist');
for (const forbidden of ['!.local', '!.git/', '!runtime/', '!docs/']) assert.ok(!ignore.includes(forbidden), 'Private input must not enter the build');
const guide = await read('README.md');
assert.match(guide, /id="agent-handoff"/);
assert.match(guide, /team:doctor/);
assert.match(guide, /team:verify/);
for (const [label, content] of [['AGENTS', await read('AGENTS.md')], ['README', guide]]) {
  assert.ok(!/\/Users\/[^/\s]+\//.test(content), `${label}: personal local path is not portable`);
}
const workflow = await read('.github/workflows/team-ci.yml');
assert.match(workflow, /contents: read/);
assert.ok(!workflow.includes('pull_request_target'), 'PR code must not execute in privileged target context');
assert.match(workflow, /npm run team:verify/);
console.log('PASS: shared agent instructions, isolated Compose configuration and PR verification wiring');
