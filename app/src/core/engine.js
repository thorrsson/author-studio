// The app-managed Author Studio workflow. Models only propose artifacts and
// canon changes; this module decides acceptance, Tier 2 gates, progress, and
// logging according to skills/author-studio/SKILL.md. Every exported function
// returns a new project object and never mutates its input.
import { artifactLabel, formatConfidence, isSafeArtifactId, parseArtifactId } from './labels.js';
import { applyPatch, detectCanonChanges, isEmptyPatch, mergePatches, normalizePatch, normKey } from './patch.js';
import { countWords, parseAssessment, splitChapterNotes, splitResponse, visibleArtifact } from './parse.js';
import { ProviderError } from '../providers/errors.js';
import {
  acceptedOf,
  buildAssessmentPrompt,
  buildConsolidationPrompt,
  buildReviewerPrompt,
  buildStartPrompt,
  buildWorkerPrompt,
  cleanLine,
  deriveTitle,
  parseStartResponse,
  PromptTooLongError,
} from './prompts.js';
import {
  ACCEPT_THRESHOLD,
  ACTIONS,
  isInitialized,
  isPlainObject,
  isPositiveInteger,
  migrateSnapshot,
  phaseForWorker,
  STATUSES,
  validateSnapshot,
  workerForType,
} from './state.js';

export const PROJECT_FORMAT = 'author-studio-project';
export const PROJECT_FORMAT_VERSION = 1;
export const LIMITS = Object.freeze({ concept: 20000, notes: 8000, title: 120, genre: 200, brief: 20000, text: 400000, chapter: 9999 });
export const ARTIFACT_STATUSES = Object.freeze(['accepted', 'pending', 'superseded', 'revised', 'rejected']);
const MAX_ACTIVITY = 1000;
const ID_PATTERN = /\b((?:brief|research|world|plot)-\d+(?:-v\d+)?|chapter-\d+-v\d+)\b/g;

export class EngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

function clock(ctx = {}) {
  return {
    now: ctx.now ?? (() => new Date().toISOString()),
    uuid: ctx.uuid ?? (() => globalThis.crypto.randomUUID()),
  };
}

function cleanText(value, max, label) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > max) {
    throw new EngineError('invalid-input', `${label} is too long (${text.length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}).`);
  }
  return text;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normKey(item);
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preview(text, max = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function emptyProject(template, ctx = {}) {
  const { now, uuid } = clock(ctx);
  const at = now();
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: uuid(),
    createdAt: at,
    updatedAt: at,
    state: structuredClone(template),
    artifacts: {},
    gate: null,
    activity: [],
    reviews: [],
  };
}

function touch(project, ctx) {
  project.updatedAt = clock(ctx).now();
}

function log(project, { step, worker, confidence = null, action }) {
  project.state.orchestrator_log.push({ step, worker, confidence: confidence ?? null, action });
}

function addActivity(project, ctx, entry) {
  const { now, uuid } = clock(ctx);
  project.activity.push({ id: uuid(), at: now(), ...entry });
  if (project.activity.length > MAX_ACTIVITY) project.activity.splice(0, project.activity.length - MAX_ACTIVITY);
}

function knownIds(project) {
  const ids = new Set(Object.keys(project.artifacts));
  for (const entry of project.state.orchestrator_log) {
    for (const match of String(entry.action ?? '').matchAll(ID_PATTERN)) ids.add(match[1]);
  }
  const pending = project.state.pending_review?.artifact?.id;
  if (pending) ids.add(pending);
  return ids;
}

function nextBaseId(project, type) {
  const pattern = new RegExp(`^${type}-(\\d+)(?:-v\\d+)?$`);
  let max = 0;
  for (const id of knownIds(project)) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${type}-${max + 1}`;
}

function nextVersionId(project, base) {
  let max = 0;
  for (const id of knownIds(project)) {
    const parsed = parseArtifactId(id);
    if (parsed.base === base) max = Math.max(max, parsed.version);
  }
  if (base.startsWith('chapter-')) return `${base}-v${max + 1}`;
  return max === 0 ? base : `${base}-v${max + 1}`;
}

export function latestAccepted(project) {
  return Object.values(project.artifacts)
    .filter((artifact) => artifact.status === 'accepted' && artifact.type !== 'brief')
    .sort((a, b) => String(b.acceptedAt ?? b.createdAt).localeCompare(String(a.acceptedAt ?? a.createdAt)))[0];
}

function requireInitialized(project) {
  if (!isInitialized(project?.state)) {
    throw new EngineError('not-initialized', 'Start a project with your story idea first.');
  }
}

function requireNoGate(project) {
  if (project.gate) {
    const artifact = artifactById(project, project.gate.artifactId);
    throw new EngineError(
      'gate-pending',
      `${artifactLabel(artifact) || 'An artifact'} is waiting for your review. Approve it, request changes, or reject it before starting another step.`,
      { artifactId: project.gate.artifactId },
    );
  }
}

function requireGate(project) {
  if (!project.gate) throw new EngineError('no-gate', 'Nothing is waiting for review.');
  return project.gate;
}

// Looks up only the project's own artifacts, never inherited object members.
function artifactById(project, id) {
  return typeof id === 'string' && Object.hasOwn(project.artifacts, id) ? project.artifacts[id] : undefined;
}

function gateArtifact(project, gate) {
  const artifact = artifactById(project, gate.artifactId);
  if (!artifact) throw new EngineError('invalid-project', 'The artifact waiting for your review is missing from this project.');
  return artifact;
}

function patchSummary(patch) {
  if (isEmptyPatch(patch)) return 'no canon changes';
  const count = (value, one, many) => (value ? `${value} ${value === 1 ? one : many}` : null);
  const parts = [
    patch.lore?.tech_level && 'technology and period',
    patch.lore?.magic_system && 'magic system',
    count(patch.lore?.key_factions?.length, 'group', 'groups'),
    count(patch.lore?.timeline_log?.length, 'timeline event', 'timeline events'),
    patch.plot?.replace_act_beats
      ? `replaced the story structure (${patch.plot.act_beats.length} beats)`
      : count(patch.plot?.act_beats?.length, 'story beat', 'story beats'),
    count(patch.plot?.loose_threads?.length, 'open thread', 'open threads'),
    count(patch.plot?.resolved_threads?.length, 'resolved thread', 'resolved threads'),
    count(patch.plot?.twist_map?.length, 'twist', 'twists'),
    count(patch.characters?.length, 'character update', 'character updates'),
  ].filter(Boolean);
  return parts.length ? `canon: ${parts.join(', ')}` : 'no canon changes';
}

function gateReasonsFor(artifact) {
  const reasons = [];
  if (artifact.continuityNotes) {
    reasons.push('Planning notes were separated from the manuscript. Review them alongside the proposed story bible updates; request changes to reconcile any missing or uncertain updates.');
  }
  if (!artifact.assessed) {
    reasons.push(artifact.assessmentError === 'invalid'
      ? 'The model\'s self-assessment could not be read, so confidence is unassessed.'
      : 'The model did not include its self-assessment, so confidence is unassessed.');
  } else if (artifact.confidence === null || artifact.confidence === undefined) {
    reasons.push('The model\'s confidence was missing or not between 0 and 1.');
  } else if (artifact.confidence <= ACCEPT_THRESHOLD) {
    reasons.push(`Confidence ${Math.round(artifact.confidence * 100)}% is not above the ${Math.round(ACCEPT_THRESHOLD * 100)}% needed to accept it automatically.`);
  }
  if (artifact.contradictions.length) {
    reasons.push(`${artifact.contradictions.length} possible ${artifact.contradictions.length === 1 ? 'contradiction' : 'contradictions'} with accepted canon need your decision.`);
  }
  if (!artifact.complete) {
    reasons.push(artifact.finishReason === 'length'
      ? 'The response reached the model\'s length limit, so the text is unfinished.'
      : 'The model reported that the text is unfinished.');
  }
  return reasons;
}

function withCanonChanges(state, artifact) {
  return dedupe([...artifact.contradictions, ...detectCanonChanges(state, artifact.proposedChanges ?? {}).map((change) => change.text)]);
}

function artifactSnapshot(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    content: artifact.content,
    ...(isPositiveInteger(artifact.chapter) ? { chapter: artifact.chapter } : {}),
  };
}

function openGate(project, artifact, { kind, reasons, previousStatus, ctx }) {
  if (kind === 'candidate') artifact.status = 'pending';
  const contradictions = kind === 'candidate' ? [...artifact.contradictions] : [];
  project.gate = { artifactId: artifact.id, kind, reasons: [...reasons], contradictions, previousStatus, openedAt: clock(ctx).now() };
  project.state.pending_review = {
    artifact: artifactSnapshot(artifact),
    worker: artifact.worker,
    confidence: artifact.confidence ?? null,
    flags: dedupe([...reasons, ...contradictions.map((item) => `Contradiction: ${item}`), ...(artifact.flags ?? [])]),
    proposed_changes: kind === 'candidate' ? structuredClone(artifact.proposedChanges ?? {}) : {},
    previous_status: previousStatus,
  };
  project.state.draft_progress.tier2_pending = true;
  project.state.project.status = 'review';
}

function clearGate(project) {
  project.gate = null;
  project.state.pending_review = null;
  project.state.draft_progress.tier2_pending = false;
}

function phaseFor(artifact) {
  if (['Researcher', 'World Designer', 'Story Builder', 'Scene Writer', 'Editor'].includes(artifact.worker)) {
    return phaseForWorker(artifact.worker);
  }
  return artifact.type === 'chapter' ? 'drafting' : 'planning';
}

// Commits an artifact's proposal: canon changes, chapter progress, and status.
function acceptArtifact(project, artifact, ctx) {
  const { draft_progress: _ignored, ...patch } = artifact.proposedChanges ?? {};
  const state = applyPatch(project.state, patch);
  for (const other of Object.values(project.artifacts)) {
    if (other.id !== artifact.id && other.base === artifact.base && other.status === 'accepted') {
      other.status = 'superseded';
      other.supersededBy = artifact.id;
    }
  }
  artifact.status = 'accepted';
  artifact.acceptedAt = clock(ctx).now();
  if (artifact.type === 'chapter' && isPositiveInteger(artifact.chapter)) {
    const progress = state.draft_progress;
    const others = progress.completed_chapters.filter((chapter) => chapter !== artifact.chapter);
    progress.completed_chapters = (artifact.complete ? [...others, artifact.chapter] : others).sort((a, b) => a - b);
    if (artifact.worker === 'Scene Writer' || artifact.worker === 'Author') progress.current_chapter = artifact.chapter;
  }
  state.project.status = phaseFor(artifact);
  project.state = state;
}

function chapterNote(artifact) {
  if (artifact.type !== 'chapter') return '';
  return artifact.complete
    ? `; unit ${artifact.chapter} complete (about ${artifact.words.toLocaleString('en-US')} words)`
    : `; unit ${artifact.chapter} is unfinished and not marked complete`;
}

function settle(project, candidate, { step, ctx, previousStatus }) {
  const next = structuredClone(project);
  const artifact = structuredClone(candidate);
  artifact.contradictions = withCanonChanges(next.state, artifact);
  const reasons = gateReasonsFor(artifact);
  next.artifacts[artifact.id] = artifact;
  touch(next, ctx);
  if (reasons.length === 0) {
    acceptArtifact(next, artifact, ctx);
    log(next, {
      step,
      worker: artifact.worker,
      confidence: artifact.confidence,
      action: `Accepted ${artifact.id} (${artifactLabel(artifact)}) at confidence ${formatConfidence(artifact.confidence)}; ${patchSummary(artifact.proposedChanges)}${chapterNote(artifact)}.`,
    });
    addActivity(next, ctx, { kind: 'accepted', artifactId: artifact.id, title: `${artifactLabel(artifact)} accepted` });
    return { project: next, outcome: 'accepted', artifactId: artifact.id };
  }
  openGate(next, artifact, { kind: 'candidate', reasons, previousStatus: previousStatus ?? project.state.project.status, ctx });
  log(next, {
    step,
    worker: artifact.worker,
    confidence: artifact.confidence,
    action: `Gated ${artifact.id} (${artifactLabel(artifact)}) for Tier 2 review: ${reasons.join(' ')}`,
  });
  addActivity(next, ctx, { kind: 'gate', artifactId: artifact.id, title: `${artifactLabel(artifact)} needs your review`, reasons });
  return { project: next, outcome: 'gated', artifactId: artifact.id, reasons };
}

async function callModel(ctx, request, onText) {
  let streamed = '';
  try {
    const result = await ctx.generate({
      system: request.system,
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      temperature: ctx.temperature,
      signal: ctx.signal,
      onDelta: (delta) => {
        streamed += delta;
        onText?.(streamed);
      },
    });
    return { text: result?.text ?? streamed, finishReason: result?.finishReason ?? 'stop' };
  } catch (error) {
    if (ctx.signal?.aborted || error?.name === 'AbortError') throw new EngineError('cancelled', 'Stopped. Nothing was changed.');
    throw error;
  }
}

function buildPrompt(builder, args, ctx) {
  try {
    return builder(args);
  } catch (error) {
    if (error instanceof PromptTooLongError) {
      throw new EngineError(
        'too-long',
        `This step needs about ${error.needed.toLocaleString('en-US')} tokens of material, but ${ctx.label ?? 'the selected model'} can read only about ${error.available.toLocaleString('en-US')}. Choose a model with a larger context window in Settings, or shorten the text.`,
        { needed: error.needed, available: error.available },
      );
    }
    throw error;
  }
}

function candidateFrom(response, { id, type, worker, chapter, sourceId, revisionOf, notes, ctx, contextNotes = [] }) {
  const { artifact, assessmentText } = splitResponse(response.text);
  const { content, continuityNotes } = type === 'chapter' ? splitChapterNotes(artifact) : { content: artifact, continuityNotes: '' };
  if (!content.trim()) {
    throw new EngineError('empty-response', 'The model returned no usable text. Try again, or choose a different model in Settings.');
  }
  const assessment = parseAssessment(assessmentText);
  const { patch, notes: patchNotes } = normalizePatch(assessment.proposedChanges);
  const contextFlags = contextNotes.length ? [`Some material was shortened to fit the model: ${contextNotes.join(' ')}`] : [];
  const parsed = parseArtifactId(id);
  return {
    id,
    base: parsed.base,
    version: parsed.version,
    type,
    worker,
    ...(isPositiveInteger(chapter) ? { chapter } : {}),
    status: 'candidate',
    content,
    ...(continuityNotes ? { continuityNotes } : {}),
    words: countWords(content),
    assessed: assessment.ok,
    assessmentError: assessment.error,
    confidence: assessment.confidence,
    rationale: assessment.rationale,
    flags: dedupe([...assessment.flags, ...patchNotes, ...contextFlags]),
    contradictions: dedupe(assessment.contradictions),
    complete: response.finishReason !== 'length' && assessment.complete !== false,
    finishReason: response.finishReason,
    summary: assessment.summary,
    changeSummary: assessment.changeSummary,
    unresolved: assessment.unresolved,
    proposedChanges: patch,
    ...(sourceId ? { sourceId } : {}),
    ...(revisionOf ? { revisionOf } : {}),
    ...(notes ? { notes } : {}),
    model: ctx.label ?? '',
    createdAt: clock(ctx).now(),
  };
}

async function recoverAssessment(project, candidate, ctx) {
  if (candidate.assessed && candidate.confidence !== null) return candidate;
  let prompt;
  try {
    prompt = buildAssessmentPrompt({ project, artifact: candidate, profile: ctx.profile, resources: ctx.resources });
  } catch (error) {
    if (!(error instanceof PromptTooLongError)) throw error;
    return { ...candidate, flags: dedupe([...candidate.flags, 'The missing assessment could not be recovered: the full artifact and story baseline do not fit this model. Choose a larger-context model or review it yourself.']) };
  }
  let response;
  try {
    response = await callModel(ctx, prompt);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { ...candidate, flags: dedupe([...candidate.flags, `The assessment follow-up failed: ${error.message}`]) };
  }
  const split = splitResponse(response.text);
  const assessment = parseAssessment(split.assessmentText ?? response.text);
  if (response.finishReason === 'length' || !assessment.ok || assessment.confidence === null
    || assessment.complete === null || !assessment.rationale || !assessment.summary) {
    return { ...candidate, flags: dedupe([...candidate.flags, 'The model still did not return a complete, usable assessment after one follow-up. Human review is required.']) };
  }
  const { patch, notes } = normalizePatch(assessment.proposedChanges);
  return {
    ...candidate,
    assessed: true,
    assessmentError: null,
    confidence: assessment.confidence,
    rationale: assessment.rationale,
    flags: dedupe([...candidate.flags, ...assessment.flags, ...notes, ...prompt.contextNotes,
      'A missing confidence rating was recovered with an assessment-only follow-up; the writing was not changed.']),
    contradictions: dedupe([...candidate.contradictions, ...assessment.contradictions]),
    complete: candidate.complete && assessment.complete,
    summary: assessment.summary || candidate.summary,
    changeSummary: assessment.changeSummary || candidate.changeSummary,
    unresolved: dedupe([...candidate.unresolved, ...assessment.unresolved]),
    proposedChanges: patch,
  };
}

export async function startProject(input, template, ctx = {}) {
  const concept = cleanText(input?.concept, LIMITS.concept, 'The story idea');
  if (!concept) throw new EngineError('invalid-input', 'Describe your story idea to start a project.');
  const title = cleanLine(input?.title, LIMITS.title);
  const genre = cleanLine(input?.genre, LIMITS.genre);
  let setup = { title: title || deriveTitle(concept), genre, brief: '' };
  if (!input?.skipAi) {
    const request = buildStartPrompt({ concept, title, genre });
    const response = await callModel(ctx, request, (text) => ctx.onDelta?.(text));
    setup = parseStartResponse(response.text, { concept, title, genre });
  }
  const project = emptyProject(template, ctx);
  project.state.project = { title: setup.title, concept, genre: setup.genre, status: 'planning' };
  if (setup.brief) {
    project.artifacts['brief-1'] = {
      id: 'brief-1',
      base: 'brief-1',
      version: 1,
      type: 'brief',
      worker: 'Orchestrator',
      status: 'accepted',
      content: setup.brief,
      words: countWords(setup.brief),
      assessed: false,
      confidence: null,
      flags: [],
      contradictions: [],
      complete: true,
      proposedChanges: {},
      model: input?.skipAi ? '' : ctx.label ?? '',
      createdAt: project.createdAt,
      acceptedAt: project.createdAt,
    };
  }
  log(project, {
    step: 'start',
    worker: 'Orchestrator',
    action: `Initialized "${setup.title}" (${setup.genre ? `genre: ${setup.genre}` : 'genre not specified'}) from the author's concept${setup.brief ? ' and recorded the creative brief as brief-1' : ''}; status planning.`,
  });
  addActivity(project, ctx, { kind: 'start', artifactId: setup.brief ? 'brief-1' : undefined, title: 'Project started' });
  return project;
}

function resolveTarget(project, targetId, purpose) {
  const artifact = targetId ? artifactById(project, targetId) : latestAccepted(project);
  if (!artifact) {
    throw new EngineError('invalid-input', targetId ? `There is no artifact called ${targetId}.` : `There is nothing accepted yet to ${purpose}.`);
  }
  if (artifact.status !== 'accepted' || artifact.type === 'brief') {
    throw new EngineError('invalid-input', `${artifactLabel(artifact)} (${artifact.id}) is not an accepted artifact you can ${purpose}.`);
  }
  return artifact;
}

// Runs one worker step: research, world, plot, draft, or edit.
export async function runStep(project, request, ctx) {
  requireInitialized(project);
  requireNoGate(project);
  const action = ACTIONS[request?.action];
  if (!action) throw new EngineError('invalid-input', 'Choose research, world, plot, draft, or edit.');
  const notes = cleanText(request.notes, LIMITS.notes, 'Your notes');
  let id;
  let type = action.type;
  let chapter;
  let target;
  if (request.action === 'draft') {
    chapter = Number(request.chapter);
    if (!isPositiveInteger(chapter) || chapter > LIMITS.chapter) {
      throw new EngineError('invalid-input', 'Choose a whole-number chapter or unit to draft (1, 2, 3, …).');
    }
    id = nextVersionId(project, `chapter-${chapter}`);
  } else if (request.action === 'edit') {
    target = resolveTarget(project, request.target, 'edit');
    type = target.type;
    chapter = target.chapter;
    id = nextVersionId(project, target.base);
  } else {
    id = nextBaseId(project, type);
  }
  const prompt = buildPrompt(buildWorkerPrompt, {
    project,
    mode: request.action === 'edit' ? 'edit' : 'new',
    action: request.action,
    worker: action.worker,
    chapter,
    target,
    notes,
    profile: ctx.profile,
    resources: ctx.resources,
  }, ctx);
  const response = await callModel(ctx, prompt, (text) => ctx.onDelta?.(visibleArtifact(text, { chapter: type === 'chapter' })));
  const candidate = await recoverAssessment(project, candidateFrom(response, {
    id, type, worker: action.worker, chapter, sourceId: target?.id, notes, ctx, contextNotes: prompt.contextNotes,
  }), ctx);
  return settle(project, candidate, { step: request.action, ctx });
}

function confirmedAll(gate, confirmed) {
  if (!gate.contradictions.length || confirmed === true) return true;
  const list = Array.isArray(confirmed) ? confirmed : [];
  return gate.contradictions.every((text, index) => list.includes(index) || list.includes(text));
}

export function approvePending(project, { confirmedContradictions } = {}, ctx = {}) {
  const gate = requireGate(project);
  if (gate.kind === 'candidate' && !confirmedAll(gate, confirmedContradictions)) {
    throw new EngineError(
      'needs-confirmation',
      'This candidate conflicts with accepted canon. Confirm each change you want to make, or request changes instead.',
      { contradictions: gate.contradictions },
    );
  }
  const next = structuredClone(project);
  const artifact = gateArtifact(next, gate);
  let action;
  if (gate.kind === 'review') {
    next.state.project.status = phaseFor(artifact);
    action = `Author approved ${artifact.id} (${artifactLabel(artifact)}) after a requested review; it stays accepted with no changes.`;
  } else {
    acceptArtifact(next, artifact, ctx);
    const override = gate.contradictions.length ? ` Author confirmed replacing conflicting canon: ${gate.contradictions.map((item) => preview(item, 200)).join(' | ')}.` : '';
    action = `Author approved ${artifact.id} (${artifactLabel(artifact)}) at the Tier 2 gate (confidence ${formatConfidence(artifact.confidence)}); ${patchSummary(artifact.proposedChanges)}${chapterNote(artifact)}.${override}`;
  }
  clearGate(next);
  touch(next, ctx);
  log(next, { step: 'APPROVE', worker: 'Author', confidence: artifact.confidence ?? null, action });
  addActivity(next, ctx, { kind: 'approved', artifactId: artifact.id, title: `You approved ${artifactLabel(artifact)}` });
  return { project: next, outcome: 'approved', artifactId: artifact.id };
}

export function rejectPending(project, ctx = {}) {
  const gate = requireGate(project);
  const next = structuredClone(project);
  const artifact = gateArtifact(next, gate);
  if (gate.kind === 'candidate') artifact.status = 'rejected';
  next.state.project.status = gate.previousStatus;
  clearGate(next);
  touch(next, ctx);
  log(next, {
    step: 'REJECT',
    worker: 'Author',
    confidence: artifact.confidence ?? null,
    action: gate.kind === 'candidate'
      ? `Author rejected ${artifact.id} (${artifactLabel(artifact)}); accepted canon unchanged; status restored to ${gate.previousStatus}.`
      : `Author closed the requested review of ${artifact.id} (${artifactLabel(artifact)}); it stays accepted; status restored to ${gate.previousStatus}.`,
  });
  addActivity(next, ctx, { kind: 'rejected', artifactId: artifact.id, title: gate.kind === 'candidate' ? `You rejected ${artifactLabel(artifact)}` : `Review of ${artifactLabel(artifact)} closed` });
  return { project: next, outcome: 'rejected', artifactId: artifact.id };
}

function regate(project, previous, candidate, { gate, ctx, reason, logAction }) {
  const next = structuredClone(project);
  const artifact = structuredClone(candidate);
  artifact.contradictions = withCanonChanges(next.state, artifact);
  if (gate.kind === 'candidate' && previous.id !== artifact.id) next.artifacts[previous.id].status = 'revised';
  next.artifacts[artifact.id] = artifact;
  const reasons = [reason, ...gateReasonsFor(artifact)];
  openGate(next, artifact, { kind: 'candidate', reasons, previousStatus: gate.previousStatus, ctx });
  touch(next, ctx);
  log(next, { step: 'MODIFY', worker: artifact.worker, confidence: artifact.confidence, action: `${logAction} Gate re-presented: ${reasons.slice(1).join(' ') || 'awaiting the author\'s decision.'}` });
  addActivity(next, ctx, { kind: 'gate', artifactId: artifact.id, title: `${artifactLabel(artifact)} needs your review`, reasons });
  return { project: next, outcome: 'gated', artifactId: artifact.id, reasons };
}

// MODIFY: the originating worker revises the pending candidate; the gate always reopens.
export async function modifyPending(project, { notes } = {}, ctx = {}) {
  const gate = requireGate(project);
  const text = cleanText(notes, LIMITS.notes, 'Your notes');
  if (!text) throw new EngineError('invalid-input', 'Describe the changes you want.');
  const current = gateArtifact(project, gate);
  const worker = current.worker;
  const resources = ctx.resources;
  if (!resources.workers.roles[worker]) {
    throw new EngineError('invalid-input', `This candidate came from "${worker}", which the app cannot run. Approve or reject it instead.`);
  }
  const id = nextVersionId(project, current.base);
  const prompt = buildPrompt(buildWorkerPrompt, {
    project, mode: 'revise', worker, chapter: current.chapter, target: current, notes: text, profile: ctx.profile, resources,
  }, ctx);
  const response = await callModel(ctx, prompt, (value) => ctx.onDelta?.(visibleArtifact(value, { chapter: current.type === 'chapter' })));
  const candidate = await recoverAssessment(project, candidateFrom(response, {
    id,
    type: current.type,
    worker,
    chapter: current.chapter,
    sourceId: current.sourceId ?? (gate.kind === 'review' ? current.id : undefined),
    revisionOf: current.id,
    notes: text,
    ctx,
    contextNotes: prompt.contextNotes,
  }), ctx);
  return regate(project, current, candidate, {
    gate,
    ctx,
    reason: 'Revised at your request; review the new version.',
    logAction: `Revised ${current.id} as ${id} per the author's notes: "${preview(text)}".`,
  });
}

// Joins a continuation to unfinished text, dropping any repeated overlap.
export function joinContinuation(existing, addition) {
  const base = String(existing ?? '').replace(/\s+$/, '');
  let add = String(addition ?? '').replace(/^\s+/, '');
  const heading = /^#{1,6}[^\n]*\n+/.exec(add);
  if (heading && base.includes(heading[0].trim())) add = add.slice(heading[0].length);
  const window = base.slice(-400);
  for (let size = Math.min(add.length, window.length); size >= 12; size -= 1) {
    if (window.endsWith(add.slice(0, size))) {
      add = add.slice(size).replace(/^\s+/, '');
      break;
    }
  }
  if (!add) return base;
  if (!base) return add;
  const endsSentence = /[.!?…"'”’)\]*_]$/.test(base);
  if (endsSentence) return `${base}\n\n${add}`;
  return /^[,.;:!?)\]]/.test(add) ? `${base}${add}` : `${base} ${add}`;
}

async function continuation(project, current, ctx) {
  const prompt = buildPrompt(buildWorkerPrompt, {
    project, mode: 'continue', worker: current.worker, chapter: current.chapter, target: current, profile: ctx.profile, resources: ctx.resources,
  }, ctx);
  const response = await callModel(ctx, prompt, (value) => ctx.onDelta?.(joinContinuation(current.content, visibleArtifact(value, { chapter: current.type === 'chapter' }))));
  const addition = candidateFrom(response, {
    id: current.id, type: current.type, worker: current.worker, chapter: current.chapter, ctx, contextNotes: prompt.contextNotes,
  });
  const content = joinContinuation(current.content, addition.content);
  const assessed = await recoverAssessment(project, { ...addition, content, notes: current.notes }, ctx);
  return { addition: { ...assessed, content: addition.content }, content, added: countWords(content) - countWords(current.content) };
}

// Continues an unfinished pending candidate in place, then re-presents the gate.
export async function continuePending(project, ctx = {}) {
  const gate = requireGate(project);
  const current = gateArtifact(project, gate);
  if (gate.kind !== 'candidate' || current.complete !== false) {
    throw new EngineError('invalid-input', 'Only an unfinished candidate can be continued.');
  }
  if (!ctx.resources.workers.roles[current.worker]) {
    throw new EngineError('invalid-input', `This candidate came from "${current.worker}", which the app cannot run.`);
  }
  const { addition, content, added } = await continuation(project, current, ctx);
  const updated = {
    ...structuredClone(current),
    content,
    continuityNotes: [current.continuityNotes, addition.continuityNotes].filter(Boolean).join('\n\n'),
    words: countWords(content),
    assessed: addition.assessed,
    assessmentError: addition.assessmentError,
    confidence: addition.confidence,
    rationale: addition.rationale || current.rationale,
    flags: dedupe([...addition.flags]),
    contradictions: dedupe([...current.contradictions, ...addition.contradictions]),
    complete: addition.complete,
    finishReason: addition.finishReason,
    summary: addition.summary || current.summary,
    proposedChanges: mergePatches(current.proposedChanges, addition.proposedChanges),
    continuations: (current.continuations ?? 0) + 1,
    model: ctx.label ?? current.model,
  };
  return regate(project, current, updated, {
    gate,
    ctx,
    reason: 'Continued at your request; review the extended text.',
    logAction: `Continued ${current.id} with about ${Math.max(0, added).toLocaleString('en-US')} more words${updated.complete ? '; the unit is now finished' : '; it is still unfinished'}.`,
  });
}

// Continues an accepted but unfinished chapter as a new version. The new
// version follows the normal acceptance rules.
export async function continueAccepted(project, artifactId, ctx = {}) {
  requireInitialized(project);
  requireNoGate(project);
  const current = resolveTarget(project, artifactId, 'continue');
  if (current.type !== 'chapter' || current.complete !== false) {
    throw new EngineError('invalid-input', 'Only an unfinished chapter or unit can be continued.');
  }
  const worker = ctx.resources.workers.roles[current.worker] ? current.worker : 'Scene Writer';
  const { addition, content } = await continuation(project, { ...current, worker }, ctx);
  const id = nextVersionId(project, current.base);
  const parsed = parseArtifactId(id);
  const candidate = {
    ...addition,
    id,
    base: parsed.base,
    version: parsed.version,
    worker,
    content,
    continuityNotes: [current.continuityNotes, addition.continuityNotes].filter(Boolean).join('\n\n'),
    words: countWords(content),
    summary: addition.summary || current.summary,
    sourceId: current.id,
    notes: 'Continue the unfinished text.',
  };
  return settle(project, candidate, { step: 'draft', ctx });
}

// review_t2: forces a gate on an accepted artifact. An existing gate is kept.
export function forceReview(project, { artifactId } = {}, ctx = {}) {
  requireInitialized(project);
  if (project.gate) return { project, outcome: 'already-pending', artifactId: project.gate.artifactId };
  const artifact = resolveTarget(project, artifactId, 'review');
  const next = structuredClone(project);
  const reasons = ['You asked to review this accepted artifact.'];
  openGate(next, next.artifacts[artifact.id], { kind: 'review', reasons, previousStatus: project.state.project.status, ctx });
  touch(next, ctx);
  log(next, {
    step: 'review_t2',
    worker: artifact.worker,
    confidence: artifact.confidence ?? null,
    action: `Forced a Tier 2 review of accepted ${artifact.id} (${artifactLabel(artifact)}) at the author's request; no changes proposed.`,
  });
  addActivity(next, ctx, { kind: 'gate', artifactId: artifact.id, title: `${artifactLabel(artifact)} is open for your review`, reasons });
  return { project: next, outcome: 'gated', artifactId: artifact.id, reasons };
}

// Read-only two-model review. It never changes the snapshot or the gate.
export async function secondOpinion(project, { artifactId, focus, allowSingle = false } = {}, { reviewers = [], consolidator, onStatus, ...ctx } = {}) {
  requireInitialized(project);
  const focusText = cleanText(focus, LIMITS.notes, 'Your review focus');
  let artifact;
  if (project.gate) {
    if (artifactId && artifactId !== project.gate.artifactId) {
      throw new EngineError('invalid-input', 'While a review is pending, only the pending candidate can get a second opinion.');
    }
    artifact = gateArtifact(project, project.gate);
  } else {
    artifact = resolveTarget(project, artifactId, 'review');
  }
  if (!reviewers.length) throw new EngineError('invalid-input', 'Choose reviewer models in Settings first.');
  if (reviewers.length === 1 && !allowSingle) {
    throw new EngineError('needs-consent', 'Only one reviewer model is set up, so this would be a single-perspective review.');
  }
  if (reviewers.length > 1 && reviewers[0].label === reviewers[1].label) {
    throw new EngineError('invalid-input', 'Choose two different reviewer models in Settings.');
  }
  const names = ['A', 'B'];
  const results = await Promise.all(reviewers.slice(0, 2).map(async (reviewer, index) => {
    try {
      const request = buildPrompt(buildReviewerPrompt, { project, artifact, focus: focusText, profile: reviewer.profile, resources: reviewer.resources ?? ctx.resources }, reviewer);
      onStatus?.({ reviewer: names[index], state: 'running', model: reviewer.label });
      const response = await callModel(reviewer, request);
      const text = response.text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, '').trim();
      if (!text) throw new EngineError('empty-response', 'The reviewer returned nothing.');
      onStatus?.({ reviewer: names[index], state: 'done', model: reviewer.label });
      return { label: names[index], model: reviewer.label, ok: true, text };
    } catch (error) {
      if (error instanceof EngineError && error.code === 'cancelled') throw error;
      onStatus?.({ reviewer: names[index], state: 'failed', model: reviewer.label, error: error.message });
      return { label: names[index], model: reviewer.label, ok: false, error: error.message };
    }
  }));
  const succeeded = results.filter((result) => result.ok);
  if (!succeeded.length) {
    throw new EngineError('review-failed', `The review could not run: ${results.map((result) => `Reviewer ${result.label} (${result.model}): ${result.error}`).join(' ')}`);
  }
  let mode;
  let report;
  if (succeeded.length === 2) {
    try {
      onStatus?.({ reviewer: 'consolidation', state: 'running', model: consolidator.label });
      const request = buildPrompt(buildConsolidationPrompt, {
        project, artifact, reports: succeeded, gatePending: Boolean(project.gate), profile: consolidator.profile, resources: consolidator.resources ?? ctx.resources,
      }, consolidator);
      const response = await callModel(consolidator, request, (text) => consolidator.onDelta?.(text));
      report = response.text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, '').trim();
      mode = 'consolidated';
      if (!report) throw new EngineError('empty-response', 'The consolidation was empty.');
    } catch (error) {
      if (error instanceof EngineError && error.code === 'cancelled') throw error;
      mode = 'separate';
      report = `The two reports could not be combined (${error.message}), so both appear below unedited.\n\n${succeeded.map((result) => `## Reviewer ${result.label}: ${result.model}\n\n${result.text}`).join('\n\n')}`;
    }
  } else {
    const [only] = succeeded;
    const failed = results.find((result) => !result.ok);
    mode = 'single';
    report = `**Single-perspective review.** ${failed ? `Reviewer ${failed.label} (${failed.model}) failed: ${failed.error} You can try again.` : 'You chose to run one reviewer model.'} The report below comes from ${only.model} alone.\n\n${only.text}`;
  }
  const { now, uuid } = clock(ctx);
  const review = {
    id: uuid(),
    artifactId: artifact.id,
    createdAt: now(),
    focus: focusText,
    mode,
    reviewers: results.map(({ label, model, ok, error }) => ({ label, model, ok, ...(error ? { error } : {}) })),
    reports: succeeded.map(({ label, model, text }) => ({ label, model, text })),
    report,
  };
  const next = structuredClone(project);
  next.reviews.push(review);
  touch(next, ctx);
  addActivity(next, ctx, { kind: 'review', artifactId: artifact.id, reviewId: review.id, title: `Second opinion on ${artifactLabel(artifact)}` });
  return { project: next, review };
}

// Lets the author add their own text (for example chapters written elsewhere)
// as accepted canon. The author is the human reviewer of their own work.
export function addAuthorText(project, { type, chapter, content, complete = true } = {}, ctx = {}) {
  requireInitialized(project);
  requireNoGate(project);
  if (!['research', 'world', 'plot', 'chapter'].includes(type)) throw new EngineError('invalid-input', 'Choose what kind of text this is.');
  const text = cleanText(content, LIMITS.text, 'The text');
  if (!text) throw new EngineError('invalid-input', 'Paste the text to add.');
  let id;
  let unit;
  if (type === 'chapter') {
    unit = Number(chapter);
    if (!isPositiveInteger(unit) || unit > LIMITS.chapter) throw new EngineError('invalid-input', 'Choose the chapter or unit number for this text.');
    id = nextVersionId(project, `chapter-${unit}`);
  } else {
    id = nextBaseId(project, type);
  }
  const next = structuredClone(project);
  const parsed = parseArtifactId(id);
  const at = clock(ctx).now();
  const artifact = {
    id,
    base: parsed.base,
    version: parsed.version,
    type,
    worker: 'Author',
    ...(unit ? { chapter: unit } : {}),
    status: 'accepted',
    content: text,
    words: countWords(text),
    assessed: false,
    confidence: null,
    flags: [],
    contradictions: [],
    complete: Boolean(complete),
    proposedChanges: {},
    model: '',
    createdAt: at,
  };
  next.artifacts[id] = artifact;
  acceptArtifact(next, artifact, ctx);
  touch(next, ctx);
  log(next, {
    step: 'author_text',
    worker: 'Author',
    action: `Author added their own ${artifactLabel(artifact)} as ${id} and accepted it${type === 'chapter' ? (artifact.complete ? '; unit complete' : '; unit unfinished') : ''}.`,
  });
  addActivity(next, ctx, { kind: 'accepted', artifactId: id, title: `You added ${artifactLabel(artifact)}` });
  return { project: next, outcome: 'accepted', artifactId: id };
}

export function updateBrief(project, { title, genre, concept, brief } = {}, ctx = {}) {
  requireInitialized(project);
  const next = structuredClone(project);
  const changes = [];
  const info = next.state.project;
  if (title !== undefined) {
    const value = cleanLine(title, LIMITS.title);
    if (!value) throw new EngineError('invalid-input', 'The title cannot be empty.');
    if (value !== info.title) changes.push('title');
    info.title = value;
  }
  if (genre !== undefined) {
    const value = cleanLine(genre, LIMITS.genre);
    if (value !== info.genre) changes.push('genre');
    info.genre = value;
  }
  if (concept !== undefined) {
    const value = cleanText(concept, LIMITS.concept, 'The story idea');
    if (!value) throw new EngineError('invalid-input', 'The story idea cannot be empty.');
    if (value !== info.concept) changes.push('concept');
    info.concept = value;
  }
  if (brief !== undefined) {
    const value = cleanText(brief, LIMITS.brief, 'The creative brief');
    const current = acceptedOf(next, 'brief')[0];
    if (value !== (current?.content ?? '')) {
      changes.push('creative brief');
      if (current) {
        current.content = value;
        current.words = countWords(value);
        current.editedAt = clock(ctx).now();
      } else if (value) {
        next.artifacts['brief-1'] = {
          id: 'brief-1', base: 'brief-1', version: 1, type: 'brief', worker: 'Author', status: 'accepted', content: value,
          words: countWords(value), assessed: false, confidence: null, flags: [], contradictions: [], complete: true,
          proposedChanges: {}, model: '', createdAt: clock(ctx).now(), acceptedAt: clock(ctx).now(),
        };
      }
    }
  }
  if (!changes.length) return { project, outcome: 'unchanged' };
  touch(next, ctx);
  log(next, { step: 'brief', worker: 'Author', action: `Author updated the ${changes.join(', ')}.` });
  addActivity(next, ctx, { kind: 'brief', title: `You updated the ${changes.join(', ')}` });
  return { project: next, outcome: 'updated' };
}

export function snapshotOf(project) {
  return structuredClone(project.state);
}

export { manuscriptMarkdown } from './exports.js';

export function projectSummary(project) {
  const chapters = acceptedOf(project, 'chapter');
  return {
    id: project.id,
    title: project.state.project.title || 'Untitled',
    genre: project.state.project.genre,
    status: project.state.project.status,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    words: chapters.reduce((sum, chapter) => sum + (chapter.words ?? countWords(chapter.content)), 0),
    chapters: project.state.draft_progress.completed_chapters.length,
    pending: Boolean(project.gate),
  };
}

const INCOMPLETE = /\b(incomplete|partial|unfinished|truncated|cut off|cut short)\b/i;

function inferChapter(artifact, proposed) {
  if (isPositiveInteger(artifact.chapter)) return artifact.chapter;
  const fromId = /^chapter-(\d+)/.exec(artifact.id)?.[1];
  if (fromId) return Number(fromId);
  const current = proposed?.draft_progress?.current_chapter;
  return isPositiveInteger(current) ? current : undefined;
}

// Imports a plugin snapshot. Migrations require explicit consent, and a
// pending review is preserved as a pending gate.
export function importSnapshot(input, template, { consentToMigrations = false } = {}, ctx = {}) {
  const check = validateSnapshot(input);
  if (!check.ok) {
    throw new EngineError('invalid-snapshot', 'This snapshot cannot be imported because it does not match the Author Studio format.', { errors: check.errors, warnings: check.warnings });
  }
  if (check.migrations.length && !consentToMigrations) {
    throw new EngineError('needs-migration', 'This snapshot is from an older version and needs small additions before it can be used.', { migrations: check.migrations, warnings: check.warnings });
  }
  const state = migrateSnapshot(input);
  const project = emptyProject(template, ctx);
  project.state = state;
  const pending = state.pending_review;
  if (pending) {
    const raw = pending.artifact;
    const type = raw.type === 'draft' ? 'chapter' : raw.type;
    const chapter = type === 'chapter' ? inferChapter(raw, pending.proposed_changes) : undefined;
    const { patch } = normalizePatch(pending.proposed_changes, { allowDraftProgress: true });
    const contradictions = pending.flags.filter((flag) => /contradict/i.test(flag) && !/^\d+ possible contradiction/i.test(flag))
      .map((flag) => flag.replace(/^contradiction:\s*/i, ''));
    const parsed = parseArtifactId(raw.id);
    project.artifacts[raw.id] = {
      id: raw.id,
      base: parsed.base,
      version: parsed.version,
      type,
      worker: pending.worker || workerForType(type) || 'Editor',
      ...(chapter ? { chapter } : {}),
      status: 'pending',
      content: raw.content,
      words: countWords(raw.content),
      assessed: pending.confidence !== null,
      confidence: pending.confidence,
      rationale: '',
      flags: pending.flags.filter((flag) => !/contradict/i.test(flag)),
      contradictions,
      complete: !pending.flags.some((flag) => INCOMPLETE.test(flag)),
      proposedChanges: patch,
      imported: true,
      model: '',
      createdAt: project.createdAt,
    };
    project.gate = {
      artifactId: raw.id,
      kind: 'candidate',
      reasons: ['This review was pending when the snapshot was saved.'],
      contradictions,
      previousStatus: pending.previous_status,
      openedAt: project.createdAt,
    };
  }
  addActivity(project, ctx, {
    kind: 'import',
    artifactId: pending?.artifact?.id,
    title: 'Imported a saved snapshot',
    reasons: check.migrations,
  });
  return { project, warnings: check.warnings, migrations: check.migrations };
}

function validArtifact(artifact, id) {
  return isSafeArtifactId(id)
    && isPlainObject(artifact)
    && artifact.id === id
    && isSafeArtifactId(artifact.base)
    && typeof artifact.type === 'string'
    && typeof artifact.content === 'string'
    && (artifact.continuityNotes === undefined || typeof artifact.continuityNotes === 'string')
    && typeof artifact.worker === 'string'
    && ARTIFACT_STATUSES.includes(artifact.status)
    && (artifact.confidence === null || artifact.confidence === undefined || (typeof artifact.confidence === 'number' && artifact.confidence >= 0 && artifact.confidence <= 1));
}

// Validates a full project backup (or a stored project file).
export function checkProject(input) {
  const errors = [];
  if (!isPlainObject(input) || input.format !== PROJECT_FORMAT) return ['This is not an Author Studio project file.'];
  if (!Number.isInteger(input.formatVersion) || input.formatVersion > PROJECT_FORMAT_VERSION) {
    return ['This project was saved by a newer version of Author Studio. Update the app to open it.'];
  }
  const state = validateSnapshot(input.state);
  errors.push(...state.errors);
  if (state.migrations.length) errors.push(...state.migrations.map((item) => `Missing data: ${item}`));
  if (!isPlainObject(input.artifacts)) errors.push('The project has no artifact list.');
  else {
    for (const [id, artifact] of Object.entries(input.artifacts)) {
      if (!validArtifact(artifact, id)) errors.push(`Artifact ${id} is damaged.`);
    }
  }
  const pending = input.state?.pending_review;
  if (input.gate) {
    const id = input.gate.artifactId;
    const artifact = isPlainObject(input.artifacts) && typeof id === 'string' && Object.hasOwn(input.artifacts, id) ? input.artifacts[id] : undefined;
    if (!artifact || !pending || pending.artifact?.id !== id) errors.push('The pending review does not match its artifact.');
    if (!['candidate', 'review'].includes(input.gate.kind)) errors.push('The pending review has an unknown kind.');
    if (!Array.isArray(input.gate.contradictions) || !Array.isArray(input.gate.reasons)) errors.push('The pending review is damaged.');
    if (!STATUSES.includes(input.gate.previousStatus) || input.gate.previousStatus === 'review') errors.push('The pending review has no status to restore.');
  } else if (pending) {
    errors.push('The snapshot has a pending review but the project does not.');
  }
  if (!Array.isArray(input.activity) || !Array.isArray(input.reviews)) errors.push('The project history is damaged.');
  return errors;
}

export function importProjectBackup(input, ctx = {}) {
  const errors = checkProject(input);
  if (errors.length) throw new EngineError('invalid-project', 'This project file cannot be opened.', { errors });
  const { now, uuid } = clock(ctx);
  const project = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: uuid(),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now(),
    updatedAt: now(),
    state: structuredClone(input.state),
    artifacts: structuredClone(input.artifacts),
    gate: input.gate ? structuredClone(input.gate) : null,
    activity: structuredClone(input.activity),
    reviews: structuredClone(input.reviews),
  };
  addActivity(project, ctx, { kind: 'import', title: 'Restored from a project backup' });
  return project;
}
