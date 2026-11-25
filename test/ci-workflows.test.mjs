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

function assertVerificationSteps(steps) {
  const [checkout, setupNode, ...commands] = steps;
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(setupNode.uses, 'actions/setup-node@v4');
  assert.deepEqual(setupNode.with, { 'node-version': '22', cache: 'npm' });
  assert.deepEqual(commands.map((step) => step.run), verificationSteps);
  assert.ok(steps.every((step) => step.if === undefined));
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
  assertVerificationSteps(verify.steps);
});

test('release verifies before publishing and defaults manual runs to dry runs', () => {
  const workflow = readWorkflow('release');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  const { dry_run: dryRun } = workflow.on.workflow_dispatch.inputs;
  assert.equal(dryRun.type, 'boolean');
  assert.equal(dryRun.default, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['github-release', 'publish-npm', 'verify']);

  const { verify, 'publish-npm': publish, 'github-release': release } = workflow.jobs;
  assert.deepEqual(verify.permissions, { contents: 'read' });
  assert.equal(verify['runs-on'], 'ubuntu-latest');
  assertVerificationSteps(verify.steps.slice(0, -1));
  const validateDryRunTag = verify.steps.at(-1);
  assert.equal(
    validateDryRunTag.if,
    "github.event_name == 'workflow_dispatch' && inputs.dry_run && github.ref_type == 'tag'",
  );
  assert.match(validateDryRunTag.run, /"\$GITHUB_REF_NAME" != "\$tag"/);
  assert.match(validateDryRunTag.run, /exit 1/);

  assert.equal(publish.needs, 'verify');
  assert.equal(
    publish.if.trim(),
    "(github.event_name == 'push' && github.ref_type == 'tag' && !github.event.deleted) || " +
      "(github.event_name == 'workflow_dispatch' && inputs.dry_run == false)",
  );
  assert.deepEqual(publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(publish['runs-on'], 'ubuntu-latest');
  assert.deepEqual(publish.outputs, { tag: '${{ steps.version.outputs.tag }}' });
  assert.equal(publish.steps.length, 4);
  const [checkout, setupNode, validateTag, publishNpm] = publish.steps;
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
  assert.deepEqual(publishNpm.env, {
    NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
    REPO_PRIVATE: '${{ github.event.repository.private }}',
  });
  assert.doesNotMatch(publishNpm.run, /\$\{\{/);
  assert.match(
    publishNpm.run,
    /if \[\[ "\$REPO_PRIVATE" == false \]\]; then\s+npm publish --provenance --access public\s+else\s+npm publish --access public\s+fi/,
  );

  assert.equal(release.needs, 'publish-npm');
  assert.equal(release.if, undefined);
  assert.deepEqual(release.permissions, { contents: 'write' });
  assert.equal(release['runs-on'], 'ubuntu-latest');
  const [publishRelease] = release.steps;
  assert.deepEqual(publishRelease.env, {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    RELEASE_TAG: '${{ needs.publish-npm.outputs.tag }}',
  });
  assert.match(publishRelease.run, /gh release create/);
  assert.match(publishRelease.run, /gh release edit/);
});
