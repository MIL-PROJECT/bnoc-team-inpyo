import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configuration, composeArguments } from './bnoc-team.mjs';
import { supervise } from '../docker/supervisor.mjs';

const directory = '/tmp/team checkout with spaces';
test('development and verification cannot share volumes, secret paths or origin settings', () => {
  const env = { BNOC_TEAM_PORT: '19081', BNOC_TEAM_PUBLIC_URL: 'https://bad.example', BNOC_TEAM_TARGET: 'bad' };
  const dev = configuration('up', directory, env), verify = configuration('verify', directory, env);
  assert.notEqual(dev.project, verify.project);
  assert.notEqual(dev.secretDirectory, verify.secretDirectory);
  assert.notEqual(dev.evidenceDirectory, verify.evidenceDirectory);
  assert.equal(dev.env.BNOC_TEAM_PUBLIC_URL, 'http://127.0.0.1:19081');
  assert.equal(verify.env.BNOC_TEAM_PUBLIC_URL, 'http://127.0.0.1:8083');
  assert.equal(verify.env.BNOC_TEAM_PORT, '18083');
  assert.equal(verify.env.BNOC_TEAM_TARGET, 'verification');
  assert.equal(dev.env.BNOC_TEAM_TARGET, 'runtime');
  assert.notEqual(configuration('up', '/tmp/other-checkout', {}).project, dev.project);
});
test('unsafe values and extra command names are rejected before Docker', () => {
  for (const value of ['-bad', 'UPPER', 'name;rm', 'a'.repeat(41)]) assert.throws(() => configuration('up', directory, { BNOC_TEAM_PROJECT: value }));
  for (const value of ['80', '65536', '1234.5', 'bad']) assert.throws(() => configuration('up', directory, { BNOC_TEAM_PORT: value }));
  assert.throws(() => configuration('reset', directory, {}));
  const args = composeArguments(configuration('up', directory, {}), ['down']);
  assert.equal(args.at(-1), 'down');
  assert.ok(!args.some(value => value === '-v' || value === '--volumes'));
});
function child() { const result = new EventEmitter(); result.signals = []; result.kill = signal => result.signals.push(signal); return result; }
test('a failed provider terminates Java and preserves failure exit status', () => {
  const provider = child(), java = child(), exits = [];
  supervise([provider, java], code => exits.push(code));
  provider.emit('exit', 7);
  assert.deepEqual(java.signals, ['SIGTERM']);
  java.emit('exit', 0);
  assert.deepEqual(exits, [7]);
});
test('spawn error stops sibling; graceful termination waits for both children', () => {
  const provider = child(), java = child(), exits = [];
  const stop = supervise([provider, java], code => exits.push(code));
  stop(0); stop(0);
  assert.deepEqual(provider.signals, ['SIGTERM']);
  provider.emit('exit', 0); assert.equal(exits.length, 0);
  java.emit('exit', 0); assert.deepEqual(exits, [0]);
  const broken = child(), sibling = child(), errors = [];
  supervise([broken, sibling], code => errors.push(code));
  broken.emit('error', new Error('ENOENT'));
  assert.deepEqual(sibling.signals, ['SIGTERM']);
  sibling.emit('exit', 0); assert.deepEqual(errors, [1]);
});
test('unresponsive children receive SIGKILL after the shutdown grace period', async () => {
  const provider = child(), java = child(), exits = [];
  supervise([provider, java], code => exits.push(code), 5)(0);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(provider.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(java.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(exits, [0]);
});
