import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/rollout-status.mjs', import.meta.url));
const iris = pathToFileURL(path.join(process.env.IRIS_ROOT, 'dist/ev2.js')).href;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev2-cli-'));
fs.mkdirSync(path.join(dir, 'dist'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(dir, 'config.yaml'), 'configs: {}');
fs.writeFileSync(path.join(dir, 'dist/index.js'), `
import * as real from ${JSON.stringify(iris)};
const scenario = process.env.EV2_FIXTURE;
const raw = { Status: scenario === 'success' ? 'Succeeded' : 'Running', ResourceGroups: [{ Name: 'rg', Resources: [{ Name: 'res', Actions: [{
  Name: 'Shell/Migration', StepName: 'migration-west', Status: scenario === 'success' ? 'Succeeded' : 'Failed',
  ActionOperationInfo: { ErrorInfo: {} }, ResourceOperations: [{ ResourceName: 'script', ProvisioningState: 'Failed',
    StatusMessage: { Shells: [{ Name: 'migration', Properties: { ExecutionView: { ExitCode: 250 } }, Log: 'ERROR: SQL timeout' }] } }]
}]}]}] };
if (scenario === 'rings') { raw.ResourceGroups = []; raw.StageInfos = [{ RingRolloutId: 'child-id' }]; }
if (scenario === 'empty') raw.ResourceGroups = [];
export const ev2 = { ...real,
  fetchRollout: async () => { if (scenario === 'unavailable') throw new Error('read denied'); return raw; },
  rolloutStatusById: async () => ({ status: raw.Status, failedActions: real.extractFailedActions(raw) }),
  rolloutProgress: async () => scenario === 'unavailable' ? { rolloutId: 'root', error: 'read denied' } :
    { rolloutId: 'root', status: 'Running', children: [{ rolloutId: 'child-id', ...real.summarizeActions(raw) }] }
};
`);
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
function run(scenario, flags = [], config = path.join(dir, 'config.yaml')) {
  return spawnSync(process.execPath, [cli, 'rollout-id', '--service-group=Example.Group', ...flags], {
    encoding: 'utf8', env: { ...process.env, IRIS_ROOT: dir, EV2_CONFIG: config, EV2_FIXTURE: scenario },
  });
}

test('flat CLI reads raw actions and prints nested failure evidence', () => {
  const out = run('failed');
  assert.equal(out.status, 1, out.stderr + out.stdout);
  assert.match(out.stdout, /FAILED Shell\/Migration/);
  assert.match(out.stdout, /SQL timeout/);
  assert.match(out.stdout, /resource=rg\/res/);
  assert.match(out.stdout, /ResourceOperations\[0\].StatusMessage.Shells\[0\].Log/);
  assert.match(out.stdout, /exit=250/);
  const json = run('failed', ['--json']);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).failed[0].evidence[0].shellName, 'migration');
});

test('tree CLI prints actual row paths, evidence and child failures', () => {
  const out = run('failed', ['--tree']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /root\/child-id/);
  assert.match(out.stdout, /SQL timeout/);
  const json = run('failed', ['--tree', '--json']);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout)[1].failed[0].evidence[0].exitCode, 250);
});

test('unavailable tree and flat reads exit 3, including JSON mode', () => {
  for (const flags of [[], ['--json'], ['--tree'], ['--tree', '--json']]) {
    const out = run('unavailable', flags);
    assert.equal(out.status, 3, out.stderr + out.stdout);
    assert.match(out.stdout + out.stderr, /read denied/);
  }
  assert.equal(run('success', [], path.join(dir, 'missing.yaml')).status, 3);
});

test('success and missing detail are distinguishable from failed actions', () => {
  const out = run('success');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Succeeded/);
  assert.doesNotMatch(out.stdout, /FAILED|SQL timeout/);
  assert.match(run('rings').stdout, /re-run with --tree/);
  assert.match(run('empty').stdout, /No per-action detail/);
});
