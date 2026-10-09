import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('.release-please-config.json', root), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('.release-please-manifest.json', root), 'utf8'));
const app = JSON.parse(readFileSync(new URL('app/package.json', root), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('app/package-lock.json', root), 'utf8'));
const releaseWorkflow = readFileSync(new URL('.github/workflows/release-please.yml', root), 'utf8');
const buildWorkflow = readFileSync(new URL('.github/workflows/desktop-release.yml', root), 'utf8');

test('release-please tracks the existing desktop version and tag format', () => {
  assert.deepEqual(Object.keys(config.packages), ['app']);
  assert.equal(config.packages.app['release-type'], 'node');
  assert.equal(config.packages.app.component, 'desktop');
  assert.equal(config.packages.app['include-component-in-tag'], true);
  assert.equal(config.packages.app.draft, true);
  // Draft releases have no git tag unless forced, which hides the previous
  // release from Release Please and breaks the tagged build checkout.
  assert.equal(config.packages.app['force-tag-creation'], true);
  assert.equal(manifest.app, app.version);
  assert.equal(lock.version, app.version);
  assert.equal(lock.packages[''].version, app.version);
});

test('one manual desktop release run requests a version, tests, and auto-merges its PR', () => {
  assert.match(releaseWorkflow, /workflow_dispatch:[\s\S]*?version:[\s\S]*?required: true/);
  assert.doesNotMatch(releaseWorkflow, /^\s+push:/m);
  assert.match(releaseWorkflow, /- uses: actions\/checkout@v7/);
  assert.match(releaseWorkflow, /uses: googleapis\/release-please-action@v4/);
  // The action ignores release-as with a manifest config, so the CLI is used.
  assert.match(releaseWorkflow, /npx --yes release-please@[\d.]+ release-pr/);
  assert.match(releaseWorkflow, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(releaseWorkflow, /--release-as "\$RELEASE_VERSION"/);
  assert.match(releaseWorkflow, /--path app/);
  assert.match(releaseWorkflow, /gh workflow run desktop\.yml --ref "\$branch"/);
  assert.match(releaseWorkflow, /gh run watch "\$run_id" --exit-status/);
  assert.match(releaseWorkflow, /gh pr merge "\$pr_number" --auto --squash/);
  assert.match(releaseWorkflow, /steps\.auto_merge\.outputs\.merged == 'true'/);
  assert.match(releaseWorkflow, /pull_request_review:[\s\S]*?types: \[submitted\]/);
  assert.match(releaseWorkflow, /Create the release after an approved merge/);
});

test('merged release-please releases dispatch the tagged multi-platform build', () => {
  assert.match(releaseWorkflow, /steps\.merged_release\.outputs\['app--release_created'\] == 'true'/);
  assert.match(releaseWorkflow, /steps\.reviewed_release\.outputs\['app--release_created'\] == 'true'/);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/desktop-release\.yml/);
  assert.match(releaseWorkflow, /tag: \$\{\{ needs\.release\.outputs\.release_tag \}\}/);
  assert.match(buildWorkflow, /tags: \['desktop-v\*'\]/);
  assert.match(buildWorkflow, /workflow_call:/);
  assert.match(buildWorkflow, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
  assert.match(buildWorkflow, /RELEASE_TAG.*inputs\.tag \|\| github\.ref_name/);
  assert.match(buildWorkflow, /name: macOS \(signed and notarized\)/);
  assert.match(buildWorkflow, /name: Windows/);
  assert.match(buildWorkflow, /name: Linux/);
});
