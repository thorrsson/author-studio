import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function scriptAfter(name) {
  const lines = workflow.slice(workflow.indexOf(`- name: ${name}`)).split('\n');
  const start = lines.findIndex(line => line === '        run: |') + 1;
  const body = [];
  for (const line of lines.slice(start)) {
    if (line && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  assert.ok(body.length);
  return body.join('\n');
}
const check = scriptAfter('Check the tag matches the app version');
const tag = scriptAfter('Tag the commit and start the release');

function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'author-studio-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const bin = path.join(root, 'bin');
  mkdirSync(cwd);
  mkdirSync(bin);
  const git = (...args) => {
    const result = run('git', args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  mkdirSync(path.join(cwd, 'app'));
  writeFileSync(path.join(cwd, 'app/package.json'), '{"name":"release-test","version":"1.0.1"}\n');
  writeFileSync(path.join(cwd, 'app/package-lock.json'), JSON.stringify({
    name: 'release-test', version: '1.0.1', lockfileVersion: 3,
    packages: { '': { name: 'release-test', version: '1.0.1' } },
  }));
  git('add', '.');
  git('commit', '-m', 'Initial version');
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
set -eu
if [[ "$*" == *"/git/ref/tags/"* ]]; then
  if [[ -n "\${EXISTING_TAG_SHA:-}" ]]; then echo "$EXISTING_TAG_SHA"; else exit 1; fi
elif [[ "$*" == *"/git/refs"* ]]; then
  printf '%s\\n' "$@" > "$TAG_RECORD"
elif [[ "$*" == *"/compare/"* ]]; then
  echo identical
elif [[ "$1" == release ]]; then
  exit 1
elif [[ "$1" == workflow ]]; then
  printf '%s\\n' "$@" > "$DISPATCH_RECORD"
else
  exit 1
fi
`, { mode: 0o755 });
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DEFAULT_BRANCH: 'main', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main',
    GITHUB_SHA: sha, GITHUB_REPOSITORY: 'example/repo', REQUESTED_VERSION: '',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW_REF: 'example/repo/.github/workflows/desktop-release.yml@refs/heads/main',
    GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    TAG_RECORD: path.join(root, 'tag'), DISPATCH_RECORD: path.join(root, 'dispatch'),
  };
  return { cwd, root, remote, git, sha, env };
}

test('release input validates SemVer and preserves tagged version checks', t => {
  const { cwd, env } = fixture(t);
  for (const version of ['', '1.0.2', '2.0.0-beta.1']) {
    const result = run('bash', ['-c', check], path.join(cwd, 'app'), { ...env, REQUESTED_VERSION: version });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`version=${(version || '1.0.1').replace(/[.+]/g, '\\$&')}`));
  }
  for (const version of ['v1.0.2', '01.0.2', '1.0', '1.0.2-01', '1.0.2+build.1', '1.0.2\n', '$(exit 0)']) {
    const result = run('bash', ['-c', check], path.join(cwd, 'app'), { ...env, REQUESTED_VERSION: version });
    assert.notEqual(result.status, 0, version);
    assert.match(result.stderr, /valid SemVer/);
  }
  const tagged = { ...env, GITHUB_REF: 'refs/tags/desktop-v1.0.1', GITHUB_REF_NAME: 'desktop-v1.0.1' };
  assert.equal(run('bash', ['-c', check], path.join(cwd, 'app'), tagged).status, 0);
  assert.notEqual(run('bash', ['-c', check], path.join(cwd, 'app'), { ...tagged, REQUESTED_VERSION: '1.0.2' }).status, 0);
});

for (const version of ['', '1.0.1', '1.0.2', '2.0.0-beta.1']) {
  test(`release preparation commits and tags the correct SHA for ${version || 'blank input'}`, t => {
    const { cwd, git, remote, sha, env } = fixture(t);
    const target = version || '1.0.1';
    const result = run('bash', ['-c', tag], cwd, { ...env, REQUESTED_VERSION: version, TAG: `desktop-v${target}` });
    assert.equal(result.status, 0, result.stderr);
    const head = git('rev-parse', 'HEAD');
    assert.equal(head === sha, target === '1.0.1');
    assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), head);
    const manifest = JSON.parse(readFileSync(path.join(cwd, 'app/package.json')));
    const lock = JSON.parse(readFileSync(path.join(cwd, 'app/package-lock.json')));
    assert.equal(manifest.version, target);
    assert.equal(lock.version, target);
    assert.equal(lock.packages[''].version, target);
    assert.match(readFileSync(env.TAG_RECORD, 'utf8'), new RegExp(`sha=${head}`));
    assert.match(readFileSync(env.DISPATCH_RECORD, 'utf8'), new RegExp(`desktop-v${target.replace(/[.]/g, '\\.')}`));
  });
}

test('an existing tag on the current commit can be retried without changing metadata', t => {
  const { cwd, git, sha, env } = fixture(t);
  const result = run('bash', ['-c', tag], cwd, {
    ...env, REQUESTED_VERSION: '1.0.1', TAG: 'desktop-v1.0.1', EXISTING_TAG_SHA: sha,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.match(readFileSync(env.DISPATCH_RECORD, 'utf8'), /desktop-v1\.0\.1/);
});

test('a rejected version push stops before tagging or dispatching', t => {
  const { cwd, remote, env } = fixture(t);
  writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = run('bash', ['-c', tag], cwd, {
    ...env, REQUESTED_VERSION: '1.0.2', TAG: 'desktop-v1.0.2',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Check branch protection/);
  assert.throws(() => readFileSync(env.TAG_RECORD), { code: 'ENOENT' });
  assert.throws(() => readFileSync(env.DISPATCH_RECORD), { code: 'ENOENT' });
});

test('release preparation refuses stale branches and conflicting tags before committing', t => {
  const { cwd, git, sha, env } = fixture(t);
  git('commit', '--allow-empty', '-m', 'Concurrent change');
  git('push', 'origin', 'main');
  git('checkout', '--detach', sha);
  const requested = { ...env, REQUESTED_VERSION: '1.0.2', TAG: 'desktop-v1.0.2' };
  const stale = run('bash', ['-c', tag], cwd, requested);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, /has advanced/);
  const conflict = run('bash', ['-c', tag], cwd, { ...requested, EXISTING_TAG_SHA: 'different-sha' });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stdout, /already points/);
  assert.equal(git('rev-parse', 'HEAD'), sha);
});
