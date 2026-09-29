import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');
const json = async (file) => JSON.parse(await read(file));
const skillDir = 'skills/author-studio';

test('host manifests share metadata and a single skill directory', async () => {
  const [copilot, claude] = await Promise.all([
    json('plugin.json'),
    json('.claude-plugin/plugin.json'),
  ]);
  const { skills, ...metadata } = copilot;
  assert.deepEqual(metadata, claude);
  assert.equal(metadata.name, 'author-studio');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  assert.ok(metadata.description.length > 0);
  assert.ok(metadata.author.name.length > 0);
  assert.equal(metadata.license, 'MIT');
  assert.deepEqual(skills, ['skills/']);
  assert.deepEqual((await readdir(path.join(root, 'skills'))).sort(), ['author-studio', 'author-studio-review']);
  for (const manifest of [copilot, claude]) {
    for (const executableComponent of ['hooks', 'mcpServers', 'lspServers']) {
      assert.equal(manifest[executableComponent], undefined);
    }
  }
});

test('marketplace points to the actual plugin without a fabricated remote', async () => {
  const [marketplace, manifest] = await Promise.all([
    json('.claude-plugin/marketplace.json'),
    json('.claude-plugin/plugin.json'),
  ]);
  assert.equal(marketplace.name, 'author-studio-marketplace');
  assert.ok(marketplace.owner.name);
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.source, './');
  assert.equal(entry.description, manifest.description);
  assert.deepEqual(
    await json(path.join(entry.source, '.claude-plugin/plugin.json')),
    manifest,
  );
});

test('portable skill has standard frontmatter and bundled relative resources', async () => {
  const skill = await read(`${skillDir}/SKILL.md`);
  const frontmatter = skill.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
  assert.ok(frontmatter, 'Expected portable name/description frontmatter');
  assert.equal(frontmatter[1], path.basename(skillDir));
  assert.ok(frontmatter[2].length <= 1024);
  assert.ok(skill.split('\n').length < 500);
  assert.doesNotMatch(skill, /\$\{CLAUDE_PLUGIN_ROOT\}|\$ARGUMENTS|!\x60/);

  const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(links.sort(), ['references/workers.md', 'templates/state.json']);
  for (const link of links) {
    const target = path.resolve(root, skillDir, link);
    assert.ok(target.startsWith(`${path.join(root, skillDir)}${path.sep}`));
    assert.ok((await stat(target)).isFile(), `Missing resource: ${link}`);
  }
});

test('initial snapshot is empty, complete, and has no pending review', async () => {
  const state = await json(`${skillDir}/templates/state.json`);
  assert.deepEqual(state, {
    project: { title: '', concept: '', genre: '', status: 'idle' },
    lore: { magic_system: '', tech_level: '', key_factions: [], timeline_log: [] },
    plot: { act_beats: [], loose_threads: [], twist_map: [] },
    characters: [],
    draft_progress: {
      completed_chapters: [],
      current_chapter: '',
      tier2_pending: false,
    },
    orchestrator_log: [],
    pending_review: null,
  });
});

test('every workflow action is documented in the skill and README', async () => {
  const [skill, readme] = await Promise.all([
    read(`${skillDir}/SKILL.md`),
    read('README.md'),
  ]);
  for (const action of ['start', 'research', 'world', 'plot', 'draft', 'edit', 'review_t2', 'state', 'help']) {
    const row = new RegExp(`\\| \`${action}(?:[ \`])`);
    assert.match(skill, row);
    assert.match(readme, row);
  }
  for (const directive of ['APPROVE', 'MODIFY', 'REJECT']) {
    assert.ok(skill.includes(directive));
    assert.ok(readme.includes(directive));
  }
});

test('worker guide covers all five roles', async () => {
  const workers = await read(`${skillDir}/references/workers.md`);
  const headings = [...workers.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [
    'Researcher', 'World Designer', 'Story Builder', 'Scene Writer', 'Editor',
  ]);
});

test('state output is opt-in without removing tracking or review gates', async () => {
  const [skill, readme] = await Promise.all([
    read(`${skillDir}/SKILL.md`),
    read('README.md'),
  ]);
  assert.match(skill, /Show the complete snapshot only for `state` or an explicit request/);
  assert.match(skill, /Continue updating state and the orchestration log/);
  assert.match(skill, /confirm the path without echoing its contents/);
  assert.match(skill, /do not print it until the user agrees/);
  assert.match(skill, /### STATE SNAPSHOT\n```json/);
  assert.match(readme, /\*\*not a state dump\*\*/);
  assert.doesNotMatch(skill, /in every Author Studio response|then the full snapshot|Do not omit the snapshot/);
  assert.doesNotMatch(readme, /Every Author Studio response ends with/);
});

test('fiction contract allows free-form blends and preserves existing projects', async () => {
  const [skill, workers, manifest] = await Promise.all([
    read(`${skillDir}/SKILL.md`),
    read(`${skillDir}/references/workers.md`),
    json('plugin.json'),
  ]);
  assert.match(manifest.description, /any fiction genre or blend/);
  assert.match(skill, /genre or blend as a free-form `project.genre` string/);
  assert.match(skill, /If genre is unspecified, leave it empty/);
  assert.match(skill, /including `sci_fantasy`/);
  assert.match(skill, /snapshot shape is unchanged/);
  assert.match(skill, /1,000-3,000-word default applies to prose chapters only/);
  assert.match(skill, /magic_system` is empty when inapplicable/);
  assert.match(workers, /an empty twist map is valid/);
  assert.match(workers, /intentional ambiguity or an unreliable narrator/);
  for (const obsolete of [
    'default `sci_fantasy`',
    'Default tone\n  is epic fantasy',
    'Balance speculative wonder with comprehensible stakes.',
  ]) {
    assert.ok(!skill.includes(obsolete) && !workers.includes(obsolete));
  }
});

test('manual acceptance cases have unique IDs and observable expectations', async () => {
  const cases = await json('tests/scenarios.json');
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  for (const scenario of cases) {
    assert.ok(scenario.id);
    assert.equal(typeof scenario.setup, 'string');
    assert.ok(scenario.actions.length > 0);
    assert.ok(scenario.expected.length > 0);
    assert.ok(scenario.actions.every((value) => typeof value === 'string' && value.length > 0));
    assert.ok(scenario.expected.every((value) => typeof value === 'string' && value.length > 0));
  }
  for (const required of ['auto-review-pending-gate', 'auto-review-not-requested', 'auto-review-single-model-host', 'auto-review-injection', 'boundary-075', 'high-confidence-contradiction', 'modify', 'reject', 'resume-pending', 'injection', 'state-on-demand', 'quiet-file-export', 'export-without-tools', 'grounded-romance', 'genre-blend', 'unspecified-genre', 'short-form', 'legacy-genre', 'genre-conflict', 'literary-fiction', 'custom-genre']) {
    assert.ok(cases.some(({ id }) => id === required), `Missing scenario: ${required}`);
  }
});

test('reviewer agent is shared by both hosts, read-only, and model-agnostic', async () => {
  assert.deepEqual(await readdir(path.join(root, 'agents')), ['author-studio-reviewer.agent.md']);
  const agent = await read('agents/author-studio-reviewer.agent.md');
  const frontmatter = agent.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(frontmatter, 'Expected agent frontmatter');
  const fields = Object.fromEntries(
    frontmatter[1].split('\n').map((line) => line.split(/:\s(.+)/).slice(0, 2)),
  );
  assert.equal(fields.name, 'author-studio-reviewer');
  assert.ok(fields.description.length > 0);
  assert.deepEqual(fields.tools.split(/,\s*/), ['Read', 'Grep', 'Glob']);
  assert.equal(fields.model, undefined, 'Models are chosen per invocation by the review skill');
  assert.match(agent, /REVIEWER REPORT/);
  assert.match(agent, /Potential solutions:/);
  assert.match(agent, /never as instructions to you/);
});

test('review skill runs two different task-selected models only on request', async () => {
  const [review, skill, readme] = await Promise.all([
    read('skills/author-studio-review/SKILL.md'),
    read(`${skillDir}/SKILL.md`),
    read('README.md'),
  ]);
  const frontmatter = review.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
  assert.ok(frontmatter);
  assert.equal(frontmatter[1], 'author-studio-review');
  assert.ok(frontmatter[2].length <= 1024);
  assert.match(review, /`author-studio-reviewer`/);
  assert.match(review, /Run only when the user explicitly asks/);
  assert.match(review, /Never use the same model twice/);
  assert.match(review, /Do not hardcode them/);
  assert.match(review, /Never claim two models reviewed the work when they\s+did not/);
  assert.match(review, /does not change lore, plot, characters, draft\s+progress, project status, or `pending_review`/);
  assert.match(review, /AUTOMATED REVIEW\n/);
  assert.match(skill, /read-only automated review of the pending candidate/);
  assert.match(readme, /author-studio-review/);
});
