import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch, describePatch, detectCanonChanges, mergePatches, normalizePatch } from '../src/core/patch.js';
import { ROLE_NAMES, extractSection } from '../src/core/resources.js';
import { isInitialized, migrateSnapshot, validateSnapshot } from '../src/core/state.js';
import { resources, template } from './helpers.mjs';

test('loads the shared skill resources', () => {
  assert.deepEqual(Object.keys(resources.workers.roles), [...ROLE_NAMES]);
  for (const role of ROLE_NAMES) {
    assert.ok(resources.workers.roles[role].full.length > 100, role);
    assert.ok(resources.workers.roles[role].summary.length > 40, role);
  }
  assert.match(resources.workers.intro, /Fiction focus/);
  assert.match(resources.reviewerPrompt, /^# Author Studio reviewer/);
  assert.doesNotMatch(resources.reviewerPrompt, /^---/);
  assert.match(resources.consolidationGuide, /AUTOMATED REVIEW/);
  assert.equal(extractSection('## A\none\n## B\ntwo', 'B'), 'two');
});

test('the template is a valid, uninitialized snapshot', () => {
  const result = validateSnapshot(template);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.migrations, []);
  assert.equal(isInitialized(template), false);
});

test('rejects inconsistent gate state', () => {
  const reviewWithoutPending = structuredClone(template);
  reviewWithoutPending.project.status = 'review';
  assert.ok(validateSnapshot(reviewWithoutPending).errors.some((error) => /no review is pending/.test(error)));

  const pendingWithoutFlag = structuredClone(template);
  pendingWithoutFlag.project.status = 'review';
  pendingWithoutFlag.pending_review = {
    artifact: { id: 'world-1', type: 'world', content: 'text' },
    worker: 'World Designer',
    confidence: 0.5,
    flags: [],
    proposed_changes: {},
    previous_status: 'planning',
  };
  assert.ok(validateSnapshot(pendingWithoutFlag).errors.some((error) => /tier2_pending is false/.test(error)));

  const flagWithoutPending = structuredClone(template);
  flagWithoutPending.draft_progress.tier2_pending = true;
  delete flagWithoutPending.pending_review;
  assert.ok(validateSnapshot(flagWithoutPending).errors.some((error) => /cannot be cleared silently/.test(error)));
});

test('validates field types and chapter numbers', () => {
  const bad = structuredClone(template);
  bad.project.status = 'writing';
  bad.draft_progress.completed_chapters = [1, 1, 0];
  bad.draft_progress.current_chapter = 2.5;
  bad.orchestrator_log = [{ step: 'x', worker: 'y', action: 'z', confidence: 2 }];
  bad.characters = [{ role: 'no name' }];
  const { errors } = validateSnapshot(bad);
  assert.ok(errors.some((error) => /project.status/.test(error)));
  assert.ok(errors.some((error) => /completed_chapters/.test(error)));
  assert.ok(errors.some((error) => /current_chapter/.test(error)));
  assert.ok(errors.some((error) => /confidence/.test(error)));
  assert.ok(errors.some((error) => /characters\[0\]/.test(error)));
  assert.equal(validateSnapshot('nope').ok, false);
});

test('reports and applies migrations for older snapshots', () => {
  const legacy = structuredClone(template);
  delete legacy.project.concept;
  delete legacy.pending_review;
  legacy.project = { title: 'Old', genre: 'sci_fantasy', status: 'drafting' };
  legacy.characters = [{ name: 'Ada', role: 'pilot' }];
  const result = validateSnapshot(legacy);
  assert.equal(result.ok, true);
  assert.ok(result.migrations.length >= 3);
  const migrated = migrateSnapshot(legacy);
  assert.equal(migrated.project.concept, '');
  assert.equal(migrated.project.genre, 'sci_fantasy');
  assert.equal(migrated.pending_review, null);
  assert.deepEqual(migrated.characters[0], { name: 'Ada', role: 'pilot', arc_stage: '', voice_notes: '' });
  assert.deepEqual(validateSnapshot(migrated).migrations, []);
});

test('normalizes untrusted proposed changes', () => {
  const { patch, notes } = normalizePatch({
    lore: { tech_level: ' Gas lamps and telegraphs ', key_factions: ['The Guild', 'the guild.', { name: 'Docks', description: 'union' }], magic_system: '' },
    plot: { act_beats: 'One beat', replace_act_beats: 'yes', resolved_threads: ['Who stole the bell?'] },
    characters: [{ name: 'Mara', role: 'detective', extra: 'ignored' }, { role: 'nameless' }],
    draft_progress: { completed_chapters: [3], current_chapter: 3 },
    unexpected: true,
  });
  assert.deepEqual(patch.lore, { tech_level: 'Gas lamps and telegraphs', key_factions: ['The Guild', 'Docks: union'] });
  assert.deepEqual(patch.plot, { act_beats: ['One beat'], resolved_threads: ['Who stole the bell?'] });
  assert.deepEqual(patch.characters, [{ name: 'Mara', role: 'detective' }]);
  assert.equal(patch.draft_progress, undefined);
  assert.equal(notes.length, 1);
  assert.deepEqual(normalizePatch('garbage').patch, {});
  assert.deepEqual(normalizePatch({ draft_progress: { completed_chapters: [2, 2, -1], current_chapter: 2 } }, { allowDraftProgress: true }).patch,
    { draft_progress: { completed_chapters: [2], current_chapter: 2 } });
});

test('applies patches additively without mutating state', () => {
  const state = structuredClone(template);
  state.plot.loose_threads = ['Who stole the bell?'];
  state.characters = [{ name: 'Mara', role: 'detective', arc_stage: 'doubt', voice_notes: 'dry' }];
  const frozen = structuredClone(state);
  const next = applyPatch(state, {
    lore: { key_factions: ['Guild'], timeline_log: ['1888: fire'] },
    plot: { act_beats: ['Beat'], loose_threads: ['Missing key'], resolved_threads: ['who stole the bell'] },
    characters: [{ name: 'mara', arc_stage: 'resolve' }, { name: 'Tom' }],
  });
  assert.deepEqual(state, frozen);
  assert.deepEqual(next.lore.key_factions, ['Guild']);
  assert.deepEqual(next.plot.loose_threads, ['Missing key']);
  assert.equal(next.characters[0].arc_stage, 'resolve');
  assert.equal(next.characters[0].voice_notes, 'dry');
  assert.deepEqual(next.characters[1], { name: 'Tom', role: '', arc_stage: '', voice_notes: '' });
});

test('detects overwrites of accepted canon but allows refinements', () => {
  const state = structuredClone(template);
  state.lore.tech_level = '1920s rural Ireland';
  state.plot.act_beats = ['A', 'B'];
  state.characters = [{ name: 'Mara', role: 'detective', arc_stage: '', voice_notes: 'dry wit' }];
  assert.deepEqual(detectCanonChanges(state, { lore: { tech_level: '1920s rural Ireland, with early radio' } }), []);
  const changes = detectCanonChanges(state, {
    lore: { tech_level: 'Victorian London' },
    plot: { act_beats: ['X'], replace_act_beats: true },
    characters: [{ name: 'MARA', role: 'thief', arc_stage: 'new stage' }],
  });
  assert.deepEqual(changes.map((change) => change.path), ['lore.tech_level', 'plot.act_beats', 'characters.Mara.role']);
});

test('merges and describes patches', () => {
  const merged = mergePatches(
    { lore: { timeline_log: ['a'] }, characters: [{ name: 'Mara', role: 'detective' }] },
    { lore: { timeline_log: ['a', 'b'] }, characters: [{ name: 'mara', arc_stage: 'resolve' }, { name: 'Tom' }] },
  );
  assert.deepEqual(merged.lore.timeline_log, ['a', 'b']);
  assert.deepEqual(merged.characters, [{ name: 'mara', role: 'detective', arc_stage: 'resolve' }, { name: 'Tom' }]);
  const lines = describePatch({ plot: { resolved_threads: ['ghost'] }, characters: [{ name: 'Tom', role: 'cook' }] }, template);
  assert.deepEqual(lines, ['Resolve thread (not found among open threads, no change): ghost', 'Add character Tom (role: cook)']);
});
