import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const verificationSteps = [
  'npm ci',
  'npm run check',
  'node --test --test-concurrency=4',
  'npm pack --dry-run',
];

function readWorkflow(name) {
  return parse(readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
}

function assertVerificationSteps(job) {
  const [checkout, setupNode, ...commands] = job.steps;
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(setupNode.uses, 'actions/setup-node@v4');
  assert.deepEqual(setupNode.with, { 'node-version': '22', cache: 'npm' });
  assert.deepEqual(commands.map((step) => step.run), verificationSteps);
  assert.ok(job.steps.every((step) => step.if === undefined));
  assert.deepEqual(commands[2].env, { NODE_OPTIONS: '--disable-warning=ExperimentalWarning' });
}

test('the npm static check succeeds', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts.check, 'node scripts/check.mjs');

  const result = spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('CI verifies pull requests and main pushes on Linux and Windows', () => {
  const workflow = readWorkflow('ci');
  assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ['main'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['verify']);

  const { verify } = workflow.jobs;
  assert.equal(verify.permissions, undefined);
  assert.equal(verify['runs-on'], '${{ matrix.os }}');
  assert.deepEqual(verify.strategy.matrix, { os: ['ubuntu-latest', 'windows-latest'] });
  assertVerificationSteps(verify);
});

test('release verifies before publishing and defaults manual runs to dry runs', () => {
  const workflow = readWorkflow('release');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  const { dry_run: dryRun } = workflow.on.workflow_dispatch.inputs;
  assert.equal(dryRun.type, 'boolean');
  assert.equal(dryRun.default, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish-npm', 'verify']);

  const { verify, 'publish-npm': publish } = workflow.jobs;
  assert.deepEqual(verify.permissions, { contents: 'read' });
  assert.equal(verify['runs-on'], 'ubuntu-latest');
  assertVerificationSteps(verify);

  assert.equal(publish.needs, 'verify');
  assert.equal(
    publish.if.trim(),
    "(github.event_name == 'push' && github.ref_type == 'tag' && !github.event.deleted) || " +
      "(github.event_name == 'workflow_dispatch' && inputs.dry_run == false)",
  );
  assert.deepEqual(publish.permissions, { contents: 'write', 'id-token': 'write' });
  assert.equal(publish['runs-on'], 'ubuntu-latest');
  const [checkout, setupNode, validateTag, publishNpm, publishRelease] = publish.steps;
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.deepEqual(checkout.with, {
    'persist-credentials': false,
    'fetch-depth': 0,
    ref: '${{ github.sha }}',
  });
  assert.equal(setupNode.uses, 'actions/setup-node@v4');
  assert.deepEqual(setupNode.with, {
    'node-version': '22',
    'registry-url': 'https://registry.npmjs.org',
  });
  assert.equal(validateTag.id, 'version');
  assert.equal(publishNpm.run, 'npm publish --provenance --access public');
  assert.deepEqual(publishNpm.env, { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
  assert.match(publishRelease.run, /gh release create/);
  assert.match(publishRelease.run, /gh release edit/);
});
