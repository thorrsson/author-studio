import assert from 'node:assert/strict';
import test from 'node:test';
import { canExport, exportMarkdown, EXPORT_TARGETS } from '../src/core/exports.js';
import { template } from './helpers.mjs';

function project() {
  const state = structuredClone(template);
  state.project = { ...state.project, title: 'A planning project', genre: 'Historical mystery', concept: 'A vanished letter.' };
  return { state, artifacts: {} };
}

function artifact(id, type, content, extra = {}) {
  return { id, type, content, status: 'accepted', acceptedAt: '2026-01-01', ...extra };
}

test('research-only exports include full accepted documents in acceptance order', () => {
  const p = project();
  const longText = `Source: https://example.com/reference\n\nUncertainty: verify the date.\n\n${'Research detail. '.repeat(3000)}END`;
  p.artifacts = {
    'research-2': artifact('research-2', 'research', longText, { acceptedAt: '2026-01-02' }),
    'research-1-v1': artifact('research-1-v1', 'research', 'Old finding', { status: 'superseded' }),
    'research-1-v2': artifact('research-1-v2', 'research', 'Current finding'),
    'research-3': artifact('research-3', 'research', 'Unapproved finding', { status: 'pending' }),
    'research-4': artifact('research-4', 'research', 'Rejected finding', { status: 'rejected' }),
    'world-1': artifact('world-1', 'world', 'Setting detail'),
  };
  assert.equal(canExport(p, 'manuscript'), false);
  assert.equal(canExport(p, 'research'), true);
  const markdown = exportMarkdown(p, 'research');
  assert.ok(markdown.includes(longText), 'research is not truncated');
  assert.ok(markdown.indexOf('Current finding') < markdown.indexOf(longText));
  assert.doesNotMatch(markdown, /Old finding|Unapproved finding|Rejected finding|Setting detail/);
});

test('story bible includes all canon and full planning documents but not chapters or brief', () => {
  const p = project();
  p.state.characters = [{ name: 'Ada', role: 'Detective', arc_stage: 'Searching', voice_notes: 'Precise', motivation: 'Find her sister' }];
  p.state.lore = { tech_level: 'Victorian', magic_system: 'No magic', key_factions: [{ name: 'Family', notes: 'Estranged' }], timeline_log: ['1840: letter lost'] };
  p.state.plot = { act_beats: ['Letter found'], loose_threads: ['Who sent it?'], twist_map: ['The sister wrote it'] };
  p.artifacts = {
    'research-1': artifact('research-1', 'research', 'A full research brief'),
    'world-1': artifact('world-1', 'world', 'A full setting brief'),
    'plot-1': artifact('plot-1', 'plot', 'A full story plan', { complete: false }),
    'brief-1': artifact('brief-1', 'brief', 'A creative brief'),
    'chapter-1-v1': artifact('chapter-1-v1', 'chapter', 'Manuscript prose', { chapter: 1 }),
  };
  const before = structuredClone(p);
  const bible = exportMarkdown(p, 'bible');
  for (const text of ['Ada', 'Detective', 'Searching', 'Precise', 'Find her sister', 'Victorian', 'No magic', 'Estranged', '1840: letter lost', 'Letter found', 'Who sent it?', 'The sister wrote it', 'A full research brief', 'A full setting brief', 'A full story plan', '[Unfinished]']) {
    assert.ok(bible.includes(text), text);
  }
  assert.doesNotMatch(bible, /A creative brief|Manuscript prose|A vanished letter/);
  const packet = exportMarkdown(p, 'planning');
  assert.match(packet, /A creative brief/);
  assert.match(packet, /Historical mystery/);
  assert.match(packet, /A vanished letter/);
  assert.doesNotMatch(packet, /Manuscript prose/);
  assert.deepEqual(p, before, 'export does not mutate canon or review state');
});

test('availability supports brief-only and imported canon-only projects', () => {
  const p = project();
  assert.equal(canExport(p, 'brief'), true);
  assert.equal(canExport(p, 'planning'), true);
  for (const target of ['manuscript', 'bible', 'research', 'world', 'plot', 'unknown', '__proto__']) assert.equal(canExport(p, target), false);
  p.state.lore.tech_level = 'Present day';
  assert.equal(canExport(p, 'bible'), true);
  assert.match(exportMarkdown(p, 'bible'), /Present day/);
  p.state.project.concept = '';
  p.state.project.genre = '';
  assert.equal(canExport(p, 'brief'), false);
  p.state.lore.tech_level = '';
  assert.equal(canExport(p, 'planning'), false);
  assert.equal(Object.keys(EXPORT_TARGETS).length, 7);
});

test('setting, story plan, and brief are independently exportable', () => {
  const p = project();
  p.artifacts = {
    'world-1': artifact('world-1', 'world', 'World content'),
    'plot-1': artifact('plot-1', 'plot', 'Plot content'),
    'brief-1': artifact('brief-1', 'brief', 'Brief content'),
  };
  assert.match(exportMarkdown(p, 'world'), /World content/);
  assert.doesNotMatch(exportMarkdown(p, 'world'), /Plot content|Brief content/);
  assert.match(exportMarkdown(p, 'plot'), /Plot content/);
  assert.doesNotMatch(exportMarkdown(p, 'plot'), /World content|Brief content/);
  assert.match(exportMarkdown(p, 'brief'), /Brief content/);
  assert.equal(exportMarkdown(p, 'brief').split('Brief content').length, 2, 'creative brief appears once');
  assert.doesNotMatch(exportMarkdown(p, 'brief'), /World content|Plot content/);
});
