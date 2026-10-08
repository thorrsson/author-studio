import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAuthorText,
  approvePending,
  checkProject,
  continueAccepted,
  continuePending,
  EngineError,
  forceReview,
  importProjectBackup,
  importSnapshot,
  joinContinuation,
  manuscriptMarkdown,
  modifyPending,
  projectSummary,
  rejectPending,
  runStep,
  secondOpinion,
  snapshotOf,
  startProject,
  updateBrief,
} from '../src/core/engine.js';
import { validateSnapshot } from '../src/core/state.js';
import { countWords } from '../src/core/parse.js';
import { ProviderError } from '../src/providers/errors.js';
import { COMPACT, good, makeCtx, respond, template } from './helpers.mjs';

const START = JSON.stringify({ title: 'The Bell of Kilmore', genre: 'historical mystery', brief: '- Form: novel\n- Unit: chapter' });

function assertValid(project) {
  const result = validateSnapshot(snapshotOf(project));
  assert.deepEqual(result.errors, [], 'snapshot must stay valid');
  assert.deepEqual(result.migrations, []);
  assert.equal(Boolean(project.gate), Boolean(project.state.pending_review));
}

async function started(extra = []) {
  const { ctx, calls } = makeCtx([START, ...extra]);
  const project = await startProject({ concept: 'A bell-ringer in 1920s Kerry investigates a theft.' }, template, ctx);
  return { project, ctx, calls };
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('chapter planning appendices are preserved separately, gated, and excluded from exports', async () => {
  const prose = '# Chapter 7\n\nHiro closed the door.';
  const notes = '### Threads\n\n**New Threads Introduced (by this chapter):**\n\n- What does Hiro know?';
  const patch = { plot: { loose_threads: ['What does Hiro know?'], act_beats: ['Unit 7: Infiltrate the mainframe room'] }, lore: { timeline_log: ['Unit 7: Hiro closes the door'] } };
  const { project, ctx } = await started();
  const deltas = [];
  ctx.onDelta = (value) => deltas.push(value);
  ctx.generate = makeCtx([good(`${prose}\n\n${notes}`, { proposed_changes: patch })]).ctx.generate;
  const result = await runStep(project, { action: 'draft', chapter: 7 }, ctx);
  assert.equal(result.outcome, 'gated', 'even a confident model must not silently lose misplaced notes');
  const artifact = result.project.artifacts[result.artifactId];
  assert.equal(artifact.content, prose);
  assert.equal(artifact.continuityNotes, notes);
  assert.equal(artifact.words, countWords(prose));
  assert.equal(deltas.at(-1), prose);
  assert.deepEqual(result.project.state.plot.loose_threads, [], 'pending notes do not change canon');
  assert.match(result.project.gate.reasons.join(' '), /Planning notes were separated/);
  assert.equal(importProjectBackup(result.project, ctx).artifacts[result.artifactId].continuityNotes, notes);
  const approved = approvePending(result.project, {}, ctx).project;
  assert.deepEqual(approved.state.plot.loose_threads, patch.plot.loose_threads);
  assert.deepEqual(approved.state.plot.act_beats, patch.plot.act_beats);
  assert.deepEqual(approved.state.lore.timeline_log, patch.lore.timeline_log);
  assert.doesNotMatch(manuscriptMarkdown(approved), /Threads|What does Hiro know/);
  assert.match(manuscriptMarkdown(approved), /Hiro closed the door/);
  assertValid(approved);
});

test('planning documents keep their thread sections', async () => {
  const content = '# Plan\n\n### Threads\n\n**New Threads Introduced:**\n\n- Who took the bell?';
  const { project, ctx } = await started([good(content)]);
  const result = await runStep(project, { action: 'plot' }, ctx);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.project.artifacts[result.artifactId].content, content);
  assert.equal(result.project.artifacts[result.artifactId].continuityNotes, undefined);
});

test('continuations preserve separated notes without joining them to the prose', async () => {
  const firstNotes = '### Threads\n\n**New Threads Introduced:**\n\n- Who took the bell?';
  const nextNotes = '### Threads\n\n**New Threads Introduced:**\n\n- Where is Hiro?';
  for (const acceptFirst of [false, true]) {
    const { project, ctx } = await started([
      good(`The door opened.\n\n${firstNotes}`, { complete: false }),
      good(`Hiro entered.\n\n${nextNotes}`),
    ]);
    let current = (await runStep(project, { action: 'draft', chapter: 1 }, ctx)).project;
    if (acceptFirst) current = approvePending(current, {}, ctx).project;
    const result = acceptFirst
      ? await continueAccepted(current, 'chapter-1-v1', ctx)
      : await continuePending(current, ctx);
    const artifact = result.project.artifacts[result.artifactId];
    assert.equal(artifact.content, 'The door opened.\n\nHiro entered.');
    assert.equal(artifact.continuityNotes, `${firstNotes}\n\n${nextNotes}`);
    assert.equal(result.outcome, 'gated');
    assertValid(result.project);
  }
});

test('revising misplaced notes routes supported updates to canon only after approval', async () => {
  const prose = '# Chapter 1\n\nHiro entered the warehouse.';
  const notes = '### Threads\n\n**New Threads Introduced:**\n\n- Who is Hiro?';
  const { project, ctx, calls } = await started([
    good(`${prose}\n\n${notes}`),
    good(prose, { proposed_changes: { plot: { loose_threads: ['Who is Hiro?'] } } }),
  ]);
  const initial = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  const revised = await modifyPending(initial.project, { notes: 'Reconcile the separated notes with the story bible.' }, ctx);
  const artifact = revised.project.artifacts[revised.artifactId];
  assert.equal(artifact.continuityNotes, undefined);
  assert.equal(artifact.content, prose);
  assert.match(calls.at(-1).prompt, /Separated continuity notes/);
  assert.deepEqual(revised.project.state.plot.loose_threads, []);
  const approved = approvePending(revised.project, {}, ctx).project;
  assert.deepEqual(approved.state.plot.loose_threads, ['Who is Hiro?']);
  assert.equal(approved.artifacts[initial.artifactId].continuityNotes, notes, 'the earlier version preserves the raw notes');
  assertValid(approved);
});

test('start initializes from the concept without guessing or drafting', async () => {
  const { project, calls } = await started();
  assert.equal(project.state.project.title, 'The Bell of Kilmore');
  assert.equal(project.state.project.genre, 'historical mystery');
  assert.equal(project.state.project.concept, 'A bell-ringer in 1920s Kerry investigates a theft.');
  assert.equal(project.state.project.status, 'planning');
  assert.equal(project.artifacts['brief-1'].status, 'accepted');
  assert.equal(project.state.orchestrator_log.length, 1);
  assert.equal(project.state.orchestrator_log[0].step, 'start');
  assert.equal(project.state.orchestrator_log[0].confidence, null);
  assert.match(calls[0].system, /Never guess science fiction or fantasy/);
  assertValid(project);
});

test('start keeps the author title and an unspecified genre empty', async () => {
  const { ctx } = makeCtx([JSON.stringify({ title: 'Other', genre: 'not specified', brief: 'x' })]);
  const project = await startProject({ concept: 'Two sisters inherit a farm.', title: 'Fallow' }, template, ctx);
  assert.equal(project.state.project.title, 'Fallow');
  assert.equal(project.state.project.genre, '');
  await assert.rejects(startProject({ concept: '   ' }, template, ctx), assertCode('invalid-input'));
  const offline = await startProject({ concept: 'A lighthouse keeper writes letters.', skipAi: true }, template, makeCtx().ctx);
  assert.match(offline.state.project.title, /^Untitled: A lighthouse keeper/);
  assert.equal(offline.artifacts['brief-1'], undefined);
  assertValid(offline);
});

test('accepts a confident artifact and applies its canon', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('# The parish of Kilmore', {
    proposed_changes: { lore: { tech_level: 'Rural 1920s Ireland', key_factions: ['The parish council'] }, characters: [{ name: 'Nora', role: 'bell-ringer' }] },
  })]).ctx.generate;
  const { project: next, outcome, artifactId } = await runStep(project, { action: 'world' }, ctx);
  assert.equal(outcome, 'accepted');
  assert.equal(artifactId, 'world-1');
  assert.equal(next.state.lore.tech_level, 'Rural 1920s Ireland');
  assert.deepEqual(next.state.characters.map((character) => character.name), ['Nora']);
  assert.equal(next.state.project.status, 'planning');
  assert.equal(next.state.orchestrator_log.at(-1).step, 'world');
  assert.equal(next.state.orchestrator_log.at(-1).confidence, 0.9);
  assert.equal(project.state.lore.tech_level, '', 'input project is not mutated');
  assertValid(next);
});

test('gates at the 0.75 boundary and accepts just above it', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([
    good('Research at the boundary', { confidence: 0.75, proposed_changes: { lore: { timeline_log: ['1922: the bell falls silent'] } } }),
  ]).ctx.generate;
  const gated = await runStep(project, { action: 'research' }, ctx);
  assert.equal(gated.outcome, 'gated');
  const state = gated.project.state;
  assert.equal(state.project.status, 'review');
  assert.equal(state.draft_progress.tier2_pending, true);
  assert.equal(state.pending_review.artifact.id, 'research-1');
  assert.equal(state.pending_review.previous_status, 'planning');
  assert.deepEqual(state.pending_review.proposed_changes, { lore: { timeline_log: ['1922: the bell falls silent'] } });
  assert.deepEqual(state.lore.timeline_log, [], 'canon is untouched while gated');
  assert.match(state.pending_review.flags[0], /Confidence 75% is not above the 75% needed/);
  assertValid(gated.project);

  ctx.generate = makeCtx([good('Research above', { confidence: 0.76 })]).ctx.generate;
  const accepted = await runStep(project, { action: 'research' }, ctx);
  assert.equal(accepted.outcome, 'accepted');
});

test('blocks other steps while a gate is pending', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('Plan', { confidence: 0.5 })]).ctx.generate;
  const { project: gated } = await runStep(project, { action: 'plot' }, ctx);
  await assert.rejects(runStep(gated, { action: 'draft', chapter: 1 }, ctx), assertCode('gate-pending'));
  assert.throws(() => addAuthorText(gated, { type: 'chapter', chapter: 1, content: 'x' }), assertCode('gate-pending'));
  const again = forceReview(gated, {}, ctx);
  assert.equal(again.outcome, 'already-pending');
  assert.equal(again.project, gated);
  assert.throws(() => approvePending(project), assertCode('no-gate'));
  assert.throws(() => rejectPending(project), assertCode('no-gate'));
});

test('a missing assessment stays unassessed and gated after one unusable follow-up', async () => {
  const { project, ctx } = await started();
  const { ctx: model, calls } = makeCtx(['# Setting\n\nJust prose, no assessment.', 'No rating.']);
  ctx.generate = model.generate;
  const { project: gated, outcome } = await runStep(project, { action: 'world' }, ctx);
  assert.equal(outcome, 'gated');
  assert.equal(gated.state.pending_review.confidence, null);
  assert.match(gated.state.pending_review.flags[0], /unassessed/);
  assert.equal(gated.state.orchestrator_log.at(-1).confidence, null);
  assert.equal(calls.length, 2);
  assert.match(gated.artifacts['world-1'].flags.join(' '), /one follow-up/);
  assertValid(gated);
});

test('recovers missing ratings for every worker without rewriting the artifact', async () => {
  const { project } = await started();
  const assessment = {
    confidence: 0.86, rationale: 'Fits the accepted story.', complete: true,
    summary: 'Nora hears the bell.', proposed_changes: { lore: { timeline_log: ['The bell rings'] } },
  };
  for (const action of ['research', 'world', 'plot', 'draft', 'edit']) {
    const base = action === 'edit'
      ? (await runStep(project, { action: 'draft', chapter: 1 }, makeCtx([good('Original.')]).ctx)).project
      : project;
    const content = '# Text\n\nNora heard the bell.';
    const { ctx, calls } = makeCtx([content, JSON.stringify(assessment)]);
    const result = await runStep(base, { action, chapter: 1 }, ctx);
    const artifact = result.project.artifacts[result.artifactId];
    assert.equal(result.outcome, 'accepted', action);
    assert.equal(artifact.content, content);
    assert.equal(artifact.confidence, 0.86);
    assert.equal(artifact.assessed, true);
    assert.equal(artifact.assessmentError, null);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Artifact to assess/);
    assert.ok(calls[1].prompt.includes(content));
    assert.equal(calls[1].onDelta instanceof Function, true);
    assert.deepEqual(result.project.state.lore.timeline_log, ['The bell rings']);
    assertValid(result.project);
  }
});

test('recovered assessments preserve confidence and contradiction gates', async () => {
  const { project } = await started();
  for (const extra of [{ confidence: 0.75 }, { contradictions: ['Nora has changed identity.'] }, { complete: false }]) {
    const { ctx } = makeCtx(['Draft text.', good('', extra)]);
    const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
    assert.equal(result.outcome, 'gated');
    assert.deepEqual(result.project.state.draft_progress.completed_chapters, []);
    assertValid(result.project);
  }
});

test('assessment recovery preserves existing concerns and incomplete status', async () => {
  const { project } = await started();
  const { ctx } = makeCtx([
    good('Draft text.', { confidence: null, complete: false, contradictions: ['Existing conflict.'], proposed_changes: { lore: { timeline_log: ['Original event'] } } }),
    good('', { confidence: 0.99, complete: true, proposed_changes: { lore: { timeline_log: ['New event'] } } }),
  ]);
  const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  const artifact = result.project.artifacts[result.artifactId];
  assert.equal(result.outcome, 'gated');
  assert.equal(artifact.complete, false);
  assert.deepEqual(artifact.contradictions, ['Existing conflict.']);
  assert.deepEqual(artifact.proposedChanges.lore.timeline_log, ['New event']);
});

test('recovered assessments replace stale canon proposals before automatic acceptance', async () => {
  const { project } = await started();
  for (const proposed_changes of [{}, { lore: { timeline_log: ['Recovered event'] } }]) {
    const { ctx } = makeCtx([
      good('Draft text.', { confidence: null, proposed_changes: { lore: { timeline_log: ['Stale event'] }, characters: [{ name: 'Stale character' }] } }),
      good('', { proposed_changes }),
    ]);
    const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
    assert.equal(result.outcome, 'accepted');
    assert.deepEqual(result.project.artifacts[result.artifactId].proposedChanges, proposed_changes);
    assert.deepEqual(result.project.state.lore.timeline_log, proposed_changes.lore?.timeline_log ?? []);
    assert.deepEqual(result.project.state.characters, []);
    assertValid(result.project);
  }
});

test('never accepts a truncated or incomplete assessment follow-up', async () => {
  const { project } = await started();
  for (const followUp of [
    { text: good('', { confidence: 0.99 }), finishReason: 'length' },
    '{"confidence": 0.99}',
    '{"confidence": 0.99, "complete": true}',
    '{"confidence": 2, "complete": true}',
    '```json\n{broken}\n```',
  ]) {
    const { ctx, calls } = makeCtx(['Draft text.', followUp]);
    const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
    assert.equal(result.outcome, 'gated');
    assert.equal(result.project.state.pending_review.confidence, null);
    assert.equal(calls.length, 2);
  }
});

test('an oversized artifact is preserved and gated instead of assessing an excerpt', async () => {
  const { project } = await started();
  const content = '# Chapter 1\n\n' + 'The bell rang. '.repeat(3000);
  const { ctx, calls } = makeCtx([content], { profile: COMPACT });
  const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.equal(result.outcome, 'gated');
  assert.equal(calls.length, 1);
  const artifact = result.project.artifacts[result.artifactId];
  assert.equal(artifact.content, content.trim());
  assert.match(artifact.flags.join(' '), /full artifact and story baseline do not fit/);
});

test('a provider failure during recovery preserves the draft and explains the gate', async () => {
  const { project } = await started();
  const { ctx } = makeCtx(['Draft text.', () => { throw new ProviderError('network', 'Server unavailable.'); }]);
  const result = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.equal(result.outcome, 'gated');
  assert.equal(result.project.artifacts[result.artifactId].content, 'Draft text.');
  assert.match(result.project.artifacts[result.artifactId].flags.join(' '), /assessment follow-up failed: Server unavailable/);
});

test('cancelling recovery still cancels the operation without changing the project', async () => {
  const { project } = await started();
  const before = structuredClone(project);
  const { ctx } = makeCtx(['Draft text.', () => { throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); }]);
  await assert.rejects(runStep(project, { action: 'draft', chapter: 1 }, ctx), assertCode('cancelled'));
  assert.deepEqual(project, before);
});

test('MODIFY and continuations recover assessments but preserve the pending gate', async () => {
  const { project } = await started();
  const gated = await runStep(project, { action: 'draft', chapter: 1, notes: 'Keep the ending quiet.' }, makeCtx([good('First half.', {
    complete: false, proposed_changes: { lore: { timeline_log: ['Prior event'] } },
  })]).ctx);
  const modified = await modifyPending(gated.project, { notes: 'Make it clearer.' }, makeCtx(['Revised text.', good('')]).ctx);
  assert.equal(modified.outcome, 'gated');
  assert.equal(modified.project.state.pending_review.confidence, 0.9);
  const { ctx, calls } = makeCtx([
    good('Second half.', { confidence: null, proposed_changes: { lore: { timeline_log: ['Stale continuation event'] } } }),
    good('', { proposed_changes: { lore: { timeline_log: ['Recovered continuation event'] } } }),
  ]);
  const continued = await continuePending(gated.project, ctx);
  assert.equal(continued.outcome, 'gated');
  assert.equal(continued.project.state.pending_review.confidence, 0.9);
  assert.ok(calls[1].prompt.includes('First half.\n\nSecond half.'));
  assert.ok(calls[1].prompt.includes('Keep the ending quiet.'));
  assert.deepEqual(continued.project.artifacts[continued.artifactId].proposedChanges.lore.timeline_log, ['Prior event', 'Recovered continuation event']);
  const approved = approvePending(gated.project);
  const { ctx: acceptedCtx, calls: acceptedCalls } = makeCtx(['Second half.', good('')]);
  const finished = await continueAccepted(approved.project, gated.artifactId, acceptedCtx);
  assert.equal(finished.outcome, 'accepted');
  assert.equal(finished.project.artifacts[finished.artifactId].content, 'First half.\n\nSecond half.');
  assert.ok(acceptedCalls[1].prompt.includes('Keep the ending quiet.'));
});

test('sequential YOLO drafts can continue after a missing rating is recovered', async () => {
  const { project } = await started();
  const { ctx, calls } = makeCtx(['Chapter one.', good(''), good('Chapter two.')]);
  const first = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.equal(first.outcome, 'accepted');
  const second = await runStep(first.project, { action: 'draft', chapter: 2 }, ctx);
  assert.equal(second.outcome, 'accepted');
  assert.deepEqual(second.project.state.draft_progress.completed_chapters, [1, 2]);
  assert.equal(calls.length, 3, 'an existing usable rating does not trigger another request');
});

test('contradictions need explicit confirmation before approval', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([
    good('World one', { proposed_changes: { lore: { tech_level: '1920s rural Ireland' } } }),
    good('World two', { confidence: 0.95, proposed_changes: { lore: { tech_level: 'Victorian London' } } }),
  ]).ctx.generate;
  const first = await runStep(project, { action: 'world' }, ctx);
  const second = await runStep(first.project, { action: 'world' }, ctx);
  assert.equal(second.outcome, 'gated');
  assert.equal(second.artifactId, 'world-2');
  assert.equal(second.project.gate.contradictions.length, 1);
  assert.ok(second.project.state.pending_review.flags.some((flag) => /^Contradiction: Replaces the accepted technology/.test(flag)));
  assert.throws(() => approvePending(second.project, {}), assertCode('needs-confirmation'));
  assert.throws(() => approvePending(second.project, { confirmedContradictions: [] }), assertCode('needs-confirmation'));
  const approved = approvePending(second.project, { confirmedContradictions: [0] }, ctx);
  assert.equal(approved.project.state.lore.tech_level, 'Victorian London');
  assert.equal(approved.project.state.project.status, 'planning');
  const entry = approved.project.state.orchestrator_log.at(-1);
  assert.equal(entry.step, 'APPROVE');
  assert.equal(entry.worker, 'Author');
  assert.match(entry.action, /confirmed replacing conflicting canon/);
  assertValid(approved.project);
});

test('model-reported contradictions also gate', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('Plan', { confidence: 0.99, contradictions: ['Nora is now an only child.'] })]).ctx.generate;
  const result = await runStep(project, { action: 'plot' }, ctx);
  assert.equal(result.outcome, 'gated');
  assert.deepEqual(result.project.gate.contradictions, ['Nora is now an only child.']);
});

test('MODIFY revises with the originating worker and always re-gates', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('Plan v1', { confidence: 0.4 })]).ctx.generate;
  const gated = await runStep(project, { action: 'plot' }, ctx);
  await assert.rejects(modifyPending(gated.project, { notes: '  ' }, ctx), assertCode('invalid-input'));
  const { ctx: modifyCtx, calls } = makeCtx([good('Plan v2', { confidence: 0.97, proposed_changes: { plot: { act_beats: ['Theft', 'Search'] } } })]);
  const modified = await modifyPending(gated.project, { notes: 'Make the theft happen earlier.' }, modifyCtx);
  assert.equal(modified.outcome, 'gated');
  assert.equal(modified.artifactId, 'plot-1-v2');
  assert.equal(modified.project.artifacts['plot-1'].status, 'revised');
  assert.equal(modified.project.artifacts['plot-1-v2'].status, 'pending');
  assert.equal(modified.project.artifacts['plot-1-v2'].revisionOf, 'plot-1');
  assert.equal(modified.project.state.pending_review.previous_status, 'planning');
  assert.match(modified.project.state.pending_review.flags[0], /Revised at your request/);
  assert.deepEqual(modified.project.state.plot.act_beats, []);
  assert.match(calls[0].system, /You are the Story Builder/);
  assert.match(calls[0].prompt, /Make the theft happen earlier\./);
  assert.match(calls[0].prompt, /Plan v1/);
  assert.equal(modified.project.state.orchestrator_log.at(-1).step, 'MODIFY');
  assertValid(modified.project);
  const approved = approvePending(modified.project, {}, ctx);
  assert.deepEqual(approved.project.state.plot.act_beats, ['Theft', 'Search']);
});

test('REJECT restores the previous status and keeps accepted canon', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([
    good('# Chapter 1\n\nText.', { proposed_changes: { characters: [{ name: 'Nora', role: 'bell-ringer' }] } }),
    good('# Chapter 2\n\nText.', { confidence: 0.2, proposed_changes: { characters: [{ name: 'Liam' }] } }),
  ]).ctx.generate;
  const first = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.equal(first.project.state.project.status, 'drafting');
  const second = await runStep(first.project, { action: 'draft', chapter: 2 }, ctx);
  const rejected = rejectPending(second.project, ctx);
  assert.equal(rejected.project.state.project.status, 'drafting');
  assert.equal(rejected.project.artifacts['chapter-2-v1'].status, 'rejected');
  assert.deepEqual(rejected.project.state.characters.map((character) => character.name), ['Nora']);
  assert.deepEqual(rejected.project.state.draft_progress.completed_chapters, [1]);
  assert.equal(rejected.project.state.orchestrator_log.at(-1).step, 'REJECT');
  assertValid(rejected.project);
});

test('drafts compute progress; model-supplied progress is ignored', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('# Chapter 3\n\nThe bell.', { proposed_changes: { draft_progress: { completed_chapters: [1, 2, 3, 9], current_chapter: 9 } } })]).ctx.generate;
  const { project: next } = await runStep(project, { action: 'draft', chapter: 3 }, ctx);
  assert.deepEqual(next.state.draft_progress.completed_chapters, [3]);
  assert.equal(next.state.draft_progress.current_chapter, 3);
  await assert.rejects(runStep(project, { action: 'draft', chapter: 0 }, ctx), assertCode('invalid-input'));
  await assert.rejects(runStep(project, { action: 'draft', chapter: 'two' }, ctx), assertCode('invalid-input'));
  await assert.rejects(runStep(project, { action: 'publish' }, ctx), assertCode('invalid-input'));
});

test('planning appendices are preserved separately and require review before chapter acceptance', async () => {
  const { project, ctx } = await started();
  const manuscript = '# Chapter 1\n\nNora reached the tower before dawn.';
  ctx.generate = makeCtx([good(`${manuscript}\n\n## Thread tracking\n- Who rang the bell?\n- Nora promises to return.`, {
    proposed_changes: {
      lore: { timeline_log: ['Nora reaches the tower before dawn.'] },
      plot: { loose_threads: ['Who rang the bell?'], resolved_threads: ['Who rang the bell?'], act_beats: ['Nora returns to the tower.'] },
    },
  })]).ctx.generate;
  const gated = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  const candidate = gated.project.artifacts[gated.artifactId];
  assert.equal(gated.outcome, 'gated');
  assert.equal(candidate.content, manuscript);
  assert.equal(candidate.words, countWords(manuscript));
  assert.match(gated.project.gate.reasons.join(' '), /Planning notes were separated/);
  assert.equal(gated.project.state.pending_review.artifact.separated_notes, '## Thread tracking\n- Who rang the bell?\n- Nora promises to return.');
  assert.deepEqual(gated.project.state.chapter_updates, []);

  const accepted = approvePending(gated.project, {}, ctx).project;
  assert.deepEqual(accepted.state.chapter_updates, [{
    chapter: 1,
    artifact_id: candidate.id,
    actual_events: ['Nora reaches the tower before dawn.'],
    open_questions: ['Who rang the bell?'],
    resolved_threads: ['Who rang the bell?'],
    planned_beats: ['Nora returns to the tower.'],
    separated_notes: candidate.separatedNotes,
  }]);
  assert.match(manuscriptMarkdown(accepted), /Nora reached the tower before dawn/);
  assert.doesNotMatch(manuscriptMarkdown(accepted), /Thread tracking|Nora promises to return/);
  assert.equal(projectSummary(accepted).words, countWords(manuscript));
  const restored = importProjectBackup(JSON.parse(JSON.stringify(accepted)), ctx);
  assert.equal(restored.artifacts[candidate.id].separatedNotes, candidate.separatedNotes);
  assert.deepEqual(restored.state.chapter_updates, accepted.state.chapter_updates);
});

test('revising a legacy chapter separates its appendix and keeps the original version in history', async () => {
  const { project, ctx } = await started();
  const originalText = '# Chapter 1\n\nNora waits at the tower.\n\n## Scene timeline\n- The bell rings after midnight.';
  const added = addAuthorText(project, { type: 'chapter', chapter: 1, content: originalText }, ctx);
  const { ctx: editCtx, calls } = makeCtx([good('# Chapter 1\n\nNora waits beneath the tower.')]);
  const revised = await runStep(added.project, { action: 'edit', target: 'chapter-1-v1' }, editCtx);
  assert.equal(revised.outcome, 'gated');
  assert.equal(revised.project.artifacts['chapter-1-v2'].content, '# Chapter 1\n\nNora waits beneath the tower.');
  assert.equal(revised.project.artifacts['chapter-1-v2'].separatedNotes, '## Scene timeline\n- The bell rings after midnight.');
  assert.equal(revised.project.artifacts['chapter-1-v1'].content, originalText);
  assert.match(calls[0].prompt, /## Separated chapter planning notes/);
  const accepted = approvePending(revised.project, {}, editCtx).project;
  assert.equal(accepted.artifacts['chapter-1-v1'].status, 'superseded');
  assert.equal(accepted.artifacts['chapter-1-v1'].content, originalText);
  assert.match(manuscriptMarkdown(accepted), /Nora waits beneath the tower/);
  assert.doesNotMatch(manuscriptMarkdown(accepted), /Scene timeline|bell rings after midnight/);
});

test('an unfinished draft is gated and never marked complete by approval', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([{ text: '# Chapter 1\n\nNora climbed the tower and', finishReason: 'length' }, good('')]).ctx.generate;
  const gated = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.equal(gated.outcome, 'gated');
  assert.equal(gated.project.artifacts['chapter-1-v1'].complete, false);
  assert.equal(gated.project.artifacts['chapter-1-v1'].confidence, 0.9);
  assert.ok(gated.project.state.pending_review.flags.some((flag) => /length limit/.test(flag)));
  const approved = approvePending(gated.project, {}, ctx);
  assert.deepEqual(approved.project.state.draft_progress.completed_chapters, []);
  assert.equal(approved.project.state.draft_progress.current_chapter, 1);
  assert.match(approved.project.state.orchestrator_log.at(-1).action, /unfinished and not marked complete/);
  assertValid(approved.project);

  const { ctx: continueCtx, calls } = makeCtx([good('pulled the rope. The end.', { confidence: 0.9, proposed_changes: { lore: { timeline_log: ['The bell rings again'] } } })]);
  const continued = await continueAccepted(approved.project, 'chapter-1-v1', continueCtx);
  assert.equal(continued.outcome, 'accepted');
  assert.equal(continued.artifactId, 'chapter-1-v2');
  const artifact = continued.project.artifacts['chapter-1-v2'];
  assert.equal(artifact.content, '# Chapter 1\n\nNora climbed the tower and pulled the rope. The end.');
  assert.equal(continued.project.artifacts['chapter-1-v1'].status, 'superseded');
  assert.deepEqual(continued.project.state.draft_progress.completed_chapters, [1]);
  assert.deepEqual(continued.project.state.lore.timeline_log, ['The bell rings again']);
  assert.match(calls[0].prompt, /Continue from exactly where it stops/);
  assertValid(continued.project);
});

test('continuing a legacy unfinished chapter carries separated notes forward', async () => {
  const { project, ctx } = await started();
  const added = addAuthorText(project, {
    type: 'chapter',
    chapter: 1,
    complete: false,
    content: '# Chapter 1\n\nNora opened the door.\n\n## Continuity notes\n- The key is still missing.',
  }, ctx);
  const { ctx: continueCtx, calls } = makeCtx([good('She stepped inside.')]);
  const continued = await continueAccepted(added.project, 'chapter-1-v1', continueCtx);
  assert.equal(continued.outcome, 'gated');
  const candidate = continued.project.artifacts['chapter-1-v2'];
  assert.equal(candidate.content, '# Chapter 1\n\nNora opened the door.\n\nShe stepped inside.');
  assert.equal(candidate.separatedNotes, '## Continuity notes\n- The key is still missing.');
  assert.match(calls[0].prompt, /The key is still missing/);
  const accepted = approvePending(continued.project, {}, continueCtx).project;
  assert.doesNotMatch(manuscriptMarkdown(accepted), /Continuity notes|key is still missing/);
  assert.equal(accepted.artifacts['chapter-1-v1'].content, added.project.artifacts['chapter-1-v1'].content);
});

test('continuing a pending draft extends it in place and re-gates', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([{ text: good('# Chapter 1\n\nThe first half.', { complete: false, proposed_changes: { characters: [{ name: 'Nora' }] } }), finishReason: 'stop' }]).ctx.generate;
  const gated = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  assert.match(gated.project.state.pending_review.flags.join(' '), /reported that the text is unfinished/);
  const { ctx: continueCtx } = makeCtx([good('The first half.\n\nThe second half.', { confidence: 0.95, proposed_changes: { characters: [{ name: 'Liam' }] } })]);
  const continued = await continuePending(gated.project, continueCtx);
  assert.equal(continued.outcome, 'gated');
  assert.equal(continued.artifactId, 'chapter-1-v1');
  const artifact = continued.project.artifacts['chapter-1-v1'];
  assert.equal(artifact.content, '# Chapter 1\n\nThe first half.\n\nThe second half.');
  assert.equal(artifact.complete, true);
  assert.equal(artifact.continuations, 1);
  assert.deepEqual(artifact.proposedChanges.characters.map((character) => character.name), ['Nora', 'Liam']);
  assert.equal(continued.project.state.pending_review.artifact.content, artifact.content);
  assertValid(continued.project);
  const approved = approvePending(continued.project, {}, ctx);
  assert.deepEqual(approved.project.state.draft_progress.completed_chapters, [1]);
  await assert.rejects(continuePending(approved.project, ctx), assertCode('no-gate'));
});

test('review_t2 gates an accepted artifact without proposing changes', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('World', { proposed_changes: { lore: { tech_level: 'Gaslight' } } })]).ctx.generate;
  const accepted = await runStep(project, { action: 'world' }, ctx);
  const forced = forceReview(accepted.project, {}, ctx);
  assert.equal(forced.outcome, 'gated');
  assert.equal(forced.project.gate.kind, 'review');
  assert.deepEqual(forced.project.state.pending_review.proposed_changes, {});
  assert.equal(forced.project.artifacts['world-1'].status, 'accepted');
  assert.equal(forced.project.state.orchestrator_log.at(-1).step, 'review_t2');
  assertValid(forced.project);

  const rejected = rejectPending(forced.project, ctx);
  assert.equal(rejected.project.artifacts['world-1'].status, 'accepted');
  assert.equal(rejected.project.state.lore.tech_level, 'Gaslight');
  assert.equal(rejected.project.state.project.status, 'planning');

  const approved = approvePending(forced.project, {}, ctx);
  assert.equal(approved.project.artifacts['world-1'].status, 'accepted');
  assert.equal(approved.project.state.pending_review, null);

  const modified = await modifyPending(forced.project, { notes: 'Add the river.' }, makeCtx([good('World with river', { confidence: 0.99 })]).ctx);
  assert.equal(modified.artifactId, 'world-1-v2');
  assert.equal(modified.project.artifacts['world-1'].status, 'accepted');
  const final = approvePending(modified.project, {}, ctx);
  assert.equal(final.project.artifacts['world-1'].status, 'superseded');
  assert.equal(final.project.artifacts['world-1-v2'].status, 'accepted');
  assert.throws(() => forceReview(project, { artifactId: 'nope' }), assertCode('invalid-input'));
});

test('the Editor creates a new version that replaces the accepted one only on acceptance', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('# Chapter 1\n\nOriginal.')]).ctx.generate;
  const drafted = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  const { ctx: editCtx, calls } = makeCtx([good('# Chapter 1\n\nPolished.', { change_summary: 'Tightened prose.' })]);
  const edited = await runStep(drafted.project, { action: 'edit', target: 'chapter-1-v1', notes: 'Tighten it.' }, editCtx);
  assert.equal(edited.artifactId, 'chapter-1-v2');
  assert.equal(edited.project.artifacts['chapter-1-v2'].worker, 'Editor');
  assert.equal(edited.project.artifacts['chapter-1-v2'].changeSummary, 'Tightened prose.');
  assert.equal(edited.project.state.project.status, 'editing');
  assert.match(calls[0].system, /You are the Editor/);
  assert.match(calls[0].system, /"change_summary"/);
  assert.match(calls[0].prompt, /Original\./);
  assert.match(manuscriptMarkdown(edited.project), /## Chapter 1\n\nPolished\./);
  assert.doesNotMatch(manuscriptMarkdown(edited.project), /Original/);
  await assert.rejects(runStep(edited.project, { action: 'edit', target: 'chapter-1-v1' }, editCtx), assertCode('invalid-input'));
  await assert.rejects(runStep(edited.project, { action: 'edit', target: 'brief-1' }, editCtx), assertCode('invalid-input'));
});

test('second opinions are read-only and follow the review skill rules', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('# Chapter 1\n\nText.', { confidence: 0.5 })]).ctx.generate;
  const gated = await runStep(project, { action: 'draft', chapter: 1 }, ctx);
  const reviewerA = makeCtx(['REVIEWER REPORT\nFinding A']);
  const reviewerB = makeCtx(['REVIEWER REPORT\nFinding B']);
  const consolidator = makeCtx(['AUTOMATED REVIEW\nR1 combined']);
  const result = await secondOpinion(gated.project, { focus: 'pacing' }, {
    ...ctx,
    reviewers: [{ ...reviewerA.ctx, label: 'Model A' }, { ...reviewerB.ctx, label: 'Model B' }],
    consolidator: { ...consolidator.ctx, label: 'Writer' },
  });
  assert.equal(result.review.mode, 'consolidated');
  assert.equal(result.review.report, 'AUTOMATED REVIEW\nR1 combined');
  assert.equal(result.review.artifactId, 'chapter-1-v1');
  assert.deepEqual(result.project.state, gated.project.state, 'the snapshot is unchanged');
  assert.deepEqual(result.project.gate, gated.project.gate);
  assert.equal(result.project.reviews.length, 1);
  assert.match(reviewerA.calls[0].system, /independent reviewers|Author Studio reviewer/);
  assert.match(reviewerA.calls[0].prompt, /pacing/);
  assert.match(consolidator.calls[0].prompt, /Finding A/);
  assert.match(consolidator.calls[0].prompt, /Finding B/);
  assert.match(consolidator.calls[0].prompt, /Request changes/);

  await assert.rejects(secondOpinion(gated.project, { artifactId: 'brief-1' }, { ...ctx, reviewers: [reviewerA.ctx, reviewerB.ctx] }), assertCode('invalid-input'));
  await assert.rejects(secondOpinion(gated.project, {}, { ...ctx, reviewers: [reviewerA.ctx] }), assertCode('needs-consent'));
  await assert.rejects(secondOpinion(gated.project, {}, {
    ...ctx, reviewers: [{ ...reviewerA.ctx, label: 'Same' }, { ...reviewerB.ctx, label: 'Same' }],
  }), assertCode('invalid-input'));

  const failing = { ...makeCtx([]).ctx, label: 'Broken', generate: async () => { throw new Error('Server unavailable.'); } };
  const single = await secondOpinion(gated.project, {}, {
    ...ctx,
    reviewers: [{ ...makeCtx(['REVIEWER REPORT\nOnly one']).ctx, label: 'Model A' }, failing],
    consolidator: makeCtx([]).ctx,
  });
  assert.equal(single.review.mode, 'single');
  assert.match(single.review.report, /Single-perspective review/);
  assert.match(single.review.report, /Reviewer B \(Broken\) failed: Server unavailable\./);
  assert.match(single.review.report, /Only one/);
});

test('imports a legacy plugin snapshot only with migration consent', () => {
  const legacy = structuredClone(template);
  delete legacy.pending_review;
  legacy.project = { title: 'Starfall', genre: 'sci_fantasy', status: 'drafting' };
  legacy.orchestrator_log = [{ step: 'world', worker: 'World Designer', confidence: 0.9, action: 'Accepted world-1 and chapter-2-v3.' }];
  assert.throws(() => importSnapshot(legacy, template), assertCode('needs-migration'));
  const { project, migrations } = importSnapshot(legacy, template, { consentToMigrations: true }, makeCtx().ctx);
  assert.ok(migrations.length >= 2);
  assert.equal(project.state.project.genre, 'sci_fantasy');
  assert.equal(project.state.project.status, 'drafting');
  assertValid(project);
  assert.equal(projectSummary(project).title, 'Starfall');
});

test('IDs continue after artifacts mentioned in an imported log', async () => {
  const legacy = structuredClone(template);
  legacy.project = { title: 'Starfall', concept: 'x', genre: '', status: 'drafting' };
  legacy.orchestrator_log = [{ step: 'world', worker: 'World Designer', confidence: 0.9, action: 'Accepted world-1 and chapter-2-v3.' }];
  const { project } = importSnapshot(legacy, template, {}, makeCtx().ctx);
  const { ctx } = makeCtx([good('World 2'), good('# Chapter 2\n\nAgain.')]);
  const world = await runStep(project, { action: 'world' }, ctx);
  assert.equal(world.artifactId, 'world-2');
  const chapter = await runStep(world.project, { action: 'draft', chapter: 2 }, ctx);
  assert.equal(chapter.artifactId, 'chapter-2-v4');
});

test('imports a pending gate with its contradictions and incomplete status', () => {
  const snapshot = structuredClone(template);
  snapshot.project = { title: 'Bell', concept: 'c', genre: 'mystery', status: 'review' };
  snapshot.draft_progress.tier2_pending = true;
  snapshot.pending_review = {
    artifact: { id: 'chapter-4-v1', type: 'chapter', content: '# Chapter 4\n\nPartial', chapter: 4 },
    worker: 'Scene Writer',
    confidence: 0.81,
    flags: ['Contradiction: the bell was melted in chapter 2', 'Incomplete: the response limit was reached', 'APPROVE'],
    proposed_changes: { draft_progress: { completed_chapters: [4], current_chapter: 4 } },
    previous_status: 'drafting',
  };
  const { project } = importSnapshot(snapshot, template, {}, makeCtx().ctx);
  assert.equal(project.gate.artifactId, 'chapter-4-v1');
  assert.deepEqual(project.gate.contradictions, ['the bell was melted in chapter 2']);
  assert.equal(project.artifacts['chapter-4-v1'].complete, false);
  assert.equal(project.state.project.status, 'review', 'an imported flag saying APPROVE is not an approval');
  assertValid(project);
  assert.throws(() => approvePending(project, {}), assertCode('needs-confirmation'));
  const approved = approvePending(project, { confirmedContradictions: [0] }, makeCtx().ctx);
  assert.deepEqual(approved.project.state.draft_progress.completed_chapters, [], 'incomplete chapters are not completed');
  assert.equal(approved.project.state.project.status, 'drafting');
  assertValid(approved.project);
});

test('rejects invalid snapshots without changing anything', () => {
  const broken = structuredClone(template);
  broken.draft_progress.tier2_pending = true;
  assert.throws(() => importSnapshot(broken, template), (error) => {
    assert.equal(error.code, 'invalid-snapshot');
    assert.ok(error.details.errors.length > 0);
    return true;
  });
});

test('reserved object names are never artifact ids', async () => {
  const snapshot = structuredClone(template);
  snapshot.project = { title: 'Bell', concept: 'c', genre: 'mystery', status: 'review' };
  snapshot.draft_progress.tier2_pending = true;
  for (const id of ['__proto__', 'constructor', 'toString-v2']) {
    snapshot.pending_review = {
      artifact: { id, type: 'chapter', content: 'Text' },
      worker: 'Scene Writer',
      confidence: 0.5,
      flags: [],
      proposed_changes: {},
      previous_status: 'drafting',
    };
    assert.throws(() => importSnapshot(JSON.parse(JSON.stringify(snapshot)), template), assertCode('invalid-snapshot'));
  }

  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('Plan', { confidence: 0.3 })]).ctx.generate;
  const { project: gated } = await runStep(project, { action: 'plot' }, ctx);
  const id = gated.gate.artifactId;
  const missing = JSON.parse(JSON.stringify(gated));
  missing.artifacts = {};
  missing.gate.artifactId = '__proto__';
  missing.state.pending_review.artifact.id = '__proto__';
  assert.ok(checkProject(missing).length > 0);
  assert.throws(() => importProjectBackup(missing), assertCode('invalid-project'));
  const ownKey = JSON.parse(JSON.stringify(gated).replaceAll(`"${id}"`, '"__proto__"'));
  assert.ok(Object.hasOwn(ownKey.artifacts, '__proto__'));
  assert.ok(checkProject(ownKey).some((error) => /damaged/.test(error)));

  const slipped = structuredClone(gated);
  slipped.gate.artifactId = 'constructor';
  assert.throws(() => approvePending(slipped, {}), assertCode('invalid-project'));
  assert.throws(() => rejectPending(slipped), assertCode('invalid-project'));
  assert.equal(({}).status, undefined, 'Object.prototype is untouched');
});

test('project backups round-trip and damaged files are refused', async () => {
  const { project, ctx } = await started();
  ctx.generate = makeCtx([good('Plan', { confidence: 0.3 })]).ctx.generate;
  const { project: gated } = await runStep(project, { action: 'plot' }, ctx);
  const restored = importProjectBackup(JSON.parse(JSON.stringify(gated)), makeCtx().ctx);
  assert.notEqual(restored.id, gated.id);
  assert.deepEqual(restored.state, gated.state);
  assert.deepEqual(checkProject(restored), []);
  const legacy = JSON.parse(JSON.stringify(gated));
  delete legacy.state.chapter_updates;
  assert.deepEqual(importProjectBackup(legacy, makeCtx().ctx).state.chapter_updates, []);
  const damaged = JSON.parse(JSON.stringify(gated));
  damaged.gate = null;
  assert.ok(checkProject(damaged).length > 0);
  const damagedNotes = JSON.parse(JSON.stringify(gated));
  damagedNotes.artifacts[damagedNotes.gate.artifactId].separatedNotes = {};
  assert.ok(checkProject(damagedNotes).some((error) => /Artifact .* is damaged/.test(error)));
  assert.throws(() => importProjectBackup({ format: 'other' }), assertCode('invalid-project'));
  const newer = JSON.parse(JSON.stringify(gated));
  newer.formatVersion = 99;
  assert.match(checkProject(newer)[0], /newer version/);
});

test('authors can add their own text and update the brief', async () => {
  const { project, ctx } = await started();
  const added = addAuthorText(project, { type: 'chapter', chapter: 1, content: '# Chapter 1\n\nMy own words.' }, ctx);
  assert.equal(added.artifactId, 'chapter-1-v1');
  assert.deepEqual(added.project.state.draft_progress.completed_chapters, [1]);
  assert.equal(added.project.state.project.status, 'drafting');
  assert.equal(added.project.state.orchestrator_log.at(-1).worker, 'Author');
  assertValid(added.project);
  assert.throws(() => addAuthorText(project, { type: 'chapter', content: 'x' }), assertCode('invalid-input'));

  const updated = updateBrief(added.project, { title: 'New Title', brief: '- Form: novella' }, ctx);
  assert.equal(updated.project.state.project.title, 'New Title');
  assert.equal(updated.project.artifacts['brief-1'].content, '- Form: novella');
  assert.match(updated.project.state.orchestrator_log.at(-1).action, /title, creative brief/);
  assert.equal(updateBrief(updated.project, { title: 'New Title' }, ctx).outcome, 'unchanged');
  assert.throws(() => updateBrief(updated.project, { title: ' ' }, ctx), assertCode('invalid-input'));
});

test('cancellation and empty responses change nothing', async () => {
  const { project, ctx } = await started();
  const controller = new AbortController();
  const cancelled = {
    ...ctx,
    signal: controller.signal,
    generate: async () => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };
  await assert.rejects(runStep(project, { action: 'world' }, cancelled), assertCode('cancelled'));
  ctx.generate = makeCtx([respond('', { confidence: 0.9 })]).ctx.generate;
  await assert.rejects(runStep(project, { action: 'world' }, ctx), assertCode('empty-response'));
});

test('streams only the visible artifact text', async () => {
  const { project, ctx } = await started();
  const seen = [];
  ctx.generate = makeCtx([good('# Setting\n\nThe valley is quiet.')]).ctx.generate;
  await runStep(project, { action: 'world' }, { ...ctx, onDelta: (text) => seen.push(text) });
  assert.ok(seen.length > 1);
  assert.equal(seen.at(-1), '# Setting\n\nThe valley is quiet.');
  assert.ok(seen.every((text) => !/confidence/.test(text)));
});

test('joins continuations without duplicating overlap', () => {
  assert.equal(joinContinuation('She opened the door and', 'stepped inside.'), 'She opened the door and stepped inside.');
  assert.equal(joinContinuation('It ended.', 'A new day.'), 'It ended.\n\nA new day.');
  assert.equal(joinContinuation('# Chapter 1\n\nShe ran toward the old mill', '# Chapter 1\n\nthe old mill, breathless.'), '# Chapter 1\n\nShe ran toward the old mill, breathless.');
  assert.equal(joinContinuation('Words', ''), 'Words');
});
