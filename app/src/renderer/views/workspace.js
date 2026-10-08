// The project workspace: write (steps and reviews), manuscript, story bible,
// idea and brief, and history.
import { ARTIFACT_STATUS_LABELS, artifactLabel, STATUS_LABELS, typeLabel } from '../../core/labels.js';
import { canExport, EXPORT_TARGETS } from '../../core/exports.js';
import { describePatch, toText } from '../../core/patch.js';
import { ACCEPT_THRESHOLD } from '../../core/state.js';
import { call } from '../api.js';
import { formatDateTime, formatElapsed, h, plural, timeAgo } from '../dom.js';
import { renderMarkdown } from '../markdown-view.js';
import { actions, activeConnection, draft, setDraft, state } from '../store.js';
import { confirmDialog, openModal, showError, toast, withBusy } from '../ui.js';
import { deleteProject } from './projects.js';

const TABS = [
  ['studio', 'Write'],
  ['manuscript', 'Manuscript'],
  ['bible', 'Story bible'],
  ['brief', 'Idea and brief'],
  ['history', 'History'],
];

const STEPS = {
  research: { title: 'Research', text: 'Gather facts, period details, and references the story should get right.' },
  world: { title: 'Setting', text: 'Develop the places, people, groups, history, and rules of the story\'s world.' },
  plot: { title: 'Story plan', text: 'Shape the structure: the beats, the threads to pay off, and the twists.' },
  draft: { title: 'Write', text: 'Draft the next chapter, scene, poem, or other unit from the plan.' },
  edit: { title: 'Revise', text: 'Improve something you have already accepted, following your notes.' },
};

const LOG_STEP_LABELS = {
  start: 'Started',
  research: 'Research',
  world: 'Setting',
  plot: 'Story plan',
  draft: 'Writing',
  edit: 'Revision',
  review_t2: 'Review',
  author_text: 'Your writing',
  brief: 'Brief',
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  MODIFY: 'Revised for review',
};

const MAX_CHAPTER = 9999;

const RUNNABLE_WORKERS = new Set(['Researcher', 'World Designer', 'Story Builder', 'Scene Writer', 'Editor']);

// ---------- project helpers ----------

function accepted(project) {
  return Object.values(project.artifacts).filter((artifact) => artifact.status === 'accepted');
}

function acceptedChapters(project) {
  return accepted(project).filter((artifact) => artifact.type === 'chapter' && artifact.chapter).sort((a, b) => a.chapter - b.chapter);
}

function nextChapter(project) {
  const used = new Set([...project.state.draft_progress.completed_chapters, ...acceptedChapters(project).map((item) => item.chapter)]);
  let chapter = 1;
  while (used.has(chapter)) chapter += 1;
  return chapter;
}

function suggestStep(project) {
  const done = new Set(accepted(project).map((item) => item.type));
  if (done.has('chapter')) return 'draft';
  if (!done.has('world')) return 'world';
  if (!done.has('plot')) return 'plot';
  return 'draft';
}

function manuscriptWords(project) {
  return acceptedChapters(project).reduce((sum, item) => sum + (item.words ?? 0), 0);
}

function editTargets(project) {
  return accepted(project)
    .filter((item) => item.type !== 'brief')
    .sort((a, b) => (a.type === 'chapter' && b.type === 'chapter' ? a.chapter - b.chapter : String(a.type).localeCompare(String(b.type))));
}

function stepLabel(project, op, args) {
  switch (op) {
    case 'step': {
      if (args.action === 'research') return 'The Researcher is gathering material';
      if (args.action === 'world') return 'The World Designer is building the setting';
      if (args.action === 'plot') return 'The Story Builder is planning the story';
      if (args.action === 'draft') return `The Scene Writer is drafting chapter ${args.chapter}`;
      const target = project.artifacts[args.target];
      return `The Editor is revising ${target ? artifactLabel(target).toLowerCase() : 'your text'}`;
    }
    case 'modify':
      return 'Revising with your notes';
    case 'continuePending':
    case 'continueAccepted':
      return 'Continuing the unfinished text';
    case 'secondOpinion':
      return 'Getting a second opinion';
    default:
      return 'Working';
  }
}

// ---------- running operations ----------

export async function runOp(project, op, args = {}) {
  const projectId = project.id;
  if (state.runs.has(projectId)) {
    toast('Author Studio is still working on this project. Wait for it to finish, or press Stop.');
    return null;
  }
  state.runs.set(projectId, { op, label: stepLabel(project, op, args), text: '', startedAt: Date.now(), reviewers: {} });
  actions.render();
  let result;
  try {
    result = await call('engine:run', { projectId, op, args });
  } catch (error) {
    state.runs.delete(projectId);
    actions.render();
    if (['gate-pending', 'no-gate', 'not-initialized'].includes(error.code)) await actions.openProject(projectId, { quiet: true });
    throw error;
  }
  state.runs.delete(projectId);
  actions.setProject(result.project);
  return result;
}

const gateToasts = new Map();

function announce(project, result) {
  const artifact = result.project.artifacts[result.artifactId];
  const label = artifact ? artifactLabel(artifact) : 'The result';
  gateToasts.get(project.id)?.();
  gateToasts.delete(project.id);
  switch (result.outcome) {
    case 'accepted':
      state.lastResult.set(project.id, result.artifactId);
      toast(`${label} was accepted${typeof artifact?.confidence === 'number' ? ` (confidence ${Math.round(artifact.confidence * 100)}%)` : ''}.`, { kind: 'success' });
      break;
    case 'gated':
      state.lastResult.delete(project.id);
      gateToasts.set(project.id, toast(`${label} needs your review.`, { kind: 'info' }));
      break;
    case 'approved':
      state.lastResult.set(project.id, result.artifactId);
      toast(`You approved ${label}.`, { kind: 'success' });
      break;
    case 'rejected':
      toast(`${label} was set aside. Your story is unchanged.`);
      break;
    case 'already-pending':
      toast('Something else is already waiting for your review.');
      break;
    default:
      break;
  }
  actions.render();
}

async function perform(project, op, args, { button } = {}) {
  try {
    if (button) button.disabled = true;
    const result = await runOp(project, op, args);
    if (result) announce(project, result);
    return result;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function stopRun(projectId) {
  const yolo = state.yolo.get(projectId);
  if (yolo) yolo.stopAfter = true;
  try {
    await call('engine:cancel', { projectId });
  } catch (error) {
    showError(error);
  }
}

// YOLO mode: writes chapters first..last in a row. Stops early when a chapter
// needs the author's review, a step fails or is stopped, or the author asks it
// to stop after the current chapter.
async function runYolo(project, { first, last, notes }, { button } = {}) {
  const id = project.id;
  const yolo = { first, last, chapter: first, written: 0, stopAfter: false };
  state.yolo.set(id, yolo);
  let current = project;
  let outcome = 'done';
  try {
    for (let chapter = first; chapter <= last; chapter += 1) {
      if (yolo.stopAfter) {
        outcome = 'stopped';
        break;
      }
      yolo.chapter = chapter;
      const result = await perform(current, 'step', { action: 'draft', chapter, notes: chapter === first ? notes : '' }, { button });
      if (!result) {
        outcome = 'failed';
        break;
      }
      current = result.project;
      if (result.outcome !== 'accepted') {
        outcome = 'gated';
        break;
      }
      yolo.written += 1;
    }
  } finally {
    state.yolo.delete(id);
    actions.render();
  }
  const written = plural(yolo.written, 'chapter');
  if (outcome === 'done') toast(`YOLO mode finished: wrote ${written}.`, { kind: 'success' });
  else if (outcome === 'stopped' || (outcome === 'failed' && yolo.written)) toast(`YOLO mode stopped after ${written}.`);
  else if (outcome === 'gated' && yolo.written) toast(`YOLO mode wrote ${written}, then paused for your review.`, { kind: 'info' });
  return { outcome, written: yolo.written, project: current };
}

// ---------- shared pieces ----------

function confidenceMeter(artifact) {
  const value = artifact?.confidence;
  if (typeof value !== 'number') {
    return h('div', { class: 'confidence confidence-unknown', title: 'The model did not rate its own work, so it needs your review.' },
      h('span', { class: 'confidence-label' }, 'Confidence'), h('strong', null, 'Not rated'));
  }
  const level = value > ACCEPT_THRESHOLD ? 'high' : value >= 0.5 ? 'medium' : 'low';
  const fill = h('span', { class: 'confidence-fill' });
  fill.style.width = `${Math.round(value * 100)}%`;
  return h('div', {
    class: ['confidence', `confidence-${level}`],
    title: `The model rated its own work ${Math.round(value * 100)}%. Work rated above ${Math.round(ACCEPT_THRESHOLD * 100)}% with no problems is accepted automatically; anything else waits for you.`,
  }, h('span', { class: 'confidence-label' }, 'Confidence'), h('strong', null, `${Math.round(value * 100)}%`), h('span', { class: 'confidence-bar' }, fill));
}

function bulletList(title, items, className) {
  if (!items?.length) return null;
  return h('div', { class: ['detail-block', className] }, h('h3', null, title), h('ul', null, items.map((item) => h('li', null, item))));
}

function continuityNotesPanel(artifact) {
  if (!artifact.continuityNotes) return null;
  return h('details', { class: 'detail-block' },
    h('summary', null, 'Separated planning notes'),
    h('p', { class: 'muted small' }, 'Preserved outside the manuscript. These notes are not automatically canon; only the structured story bible updates are applied on approval.'),
    renderMarkdown(artifact.continuityNotes));
}

function artifactMeta(artifact) {
  const parts = [artifact.worker === 'Author' ? 'Written by you' : artifact.worker];
  if (artifact.model) parts.push(artifact.model);
  parts.push(plural(artifact.words ?? 0, 'word'));
  if (artifact.createdAt) parts.push(timeAgo(artifact.createdAt));
  return h('p', { class: 'muted small' }, parts.filter(Boolean).join(' · '));
}

export function openArtifact(project, artifactId) {
  const artifact = project.artifacts[artifactId];
  if (!artifact) return;
  const canAct = !project.gate && artifact.status === 'accepted' && artifact.type !== 'brief' && !state.runs.has(project.id);
  const modal = openModal({
    title: artifactLabel(artifact),
    size: 'large',
    content: [
      h('div', { class: 'artifact-head' },
        h('div', null,
          h('span', { class: ['badge', artifact.status === 'accepted' ? 'badge-success' : artifact.status === 'pending' ? 'badge-warning' : 'badge-neutral'] }, ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status),
          artifact.type === 'chapter' && artifact.complete === false ? h('span', { class: 'badge badge-warning' }, 'Unfinished') : null,
          artifactMeta(artifact)),
        artifact.worker === 'Author' ? null : confidenceMeter(artifact)),
      artifact.rationale ? h('p', { class: 'muted' }, artifact.rationale) : null,
      bulletList('Things to check', artifact.flags),
      artifact.notes ? h('p', { class: 'muted small' }, `Your notes: ${artifact.notes}`) : null,
      h('div', { class: 'artifact-body' }, renderMarkdown(artifact.content)),
      continuityNotesPanel(artifact),
    ],
  });
  modal.setActions([
    h('button', { class: 'btn', type: 'button', onclick: async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(artifact.content);
        button.textContent = 'Copied';
      } catch (error) {
        showError(error);
      }
    } }, 'Copy text'),
    h('span', { class: 'spacer' }),
    canAct && artifact.type === 'chapter' && artifact.complete === false
      ? h('button', { class: 'btn', type: 'button', onclick: () => { modal.close(); perform(project, 'continueAccepted', { artifactId: artifact.id }); } }, 'Continue writing')
      : null,
    canAct ? h('button', { class: 'btn', type: 'button', onclick: () => { modal.close(); perform(project, 'forceReview', { artifactId: artifact.id }); } }, 'Review it again') : null,
    canAct ? h('button', { class: 'btn', type: 'button', onclick: () => { modal.close(); prepareEdit(project, artifact); } }, 'Revise…') : null,
    h('button', { class: 'btn primary', type: 'button', onclick: () => modal.close() }, 'Close'),
  ]);
}

function prepareEdit(project, artifact) {
  setDraft(`step:${project.id}:action`, 'edit');
  setDraft(`step:${project.id}:target`, artifact.id);
  actions.navigate({ name: 'project', id: project.id, tab: 'studio' });
  requestAnimationFrame(() => document.querySelector('[data-key="step-notes"]')?.focus());
}

function openReview(project, review) {
  const artifact = project.artifacts[review.artifactId];
  const failed = review.reviewers.filter((item) => !item.ok);
  openModal({
    title: `Second opinion: ${artifact ? artifactLabel(artifact) : review.artifactId}`,
    size: 'large',
    content: [
      h('p', { class: 'muted small' }, `${review.reviewers.map((item) => `Reviewer ${item.label}: ${item.model}${item.ok ? '' : ' (failed)'}`).join(' · ')} · ${formatDateTime(review.createdAt)}`),
      review.focus ? h('p', { class: 'muted' }, `Focus: ${review.focus}`) : null,
      failed.length ? h('div', { class: 'callout callout-warning' }, failed.map((item) => `Reviewer ${item.label} failed: ${item.error}`).join(' ')) : null,
      h('div', { class: 'artifact-body' }, renderMarkdown(review.report)),
      review.mode === 'consolidated'
        ? h('details', { class: 'advanced' }, h('summary', null, 'Show each reviewer\'s full report'), review.reports.map((report) => h('div', { class: 'artifact-body' }, h('h3', null, `Reviewer ${report.label}: ${report.model}`), renderMarkdown(report.text))))
        : null,
      h('p', { class: 'hint' }, 'Reviews never change your story. To act on one, request changes or revise the piece with notes.'),
    ],
    actions: [],
  });
}

async function runSecondOpinion(project, args, button) {
  const settings = state.settings;
  if (!settings.reviewers.a && !settings.reviewers.b) {
    const ok = await confirmDialog({
      title: 'Choose reviewer models first',
      message: 'A second opinion uses one or two reviewer models that you choose in Settings, ideally two different ones.',
      confirmLabel: 'Open Settings',
    });
    if (ok) actions.navigate({ name: 'settings' });
    return;
  }
  try {
    if (button) button.disabled = true;
    let result;
    try {
      result = await runOp(project, 'secondOpinion', args);
    } catch (error) {
      if (error.code !== 'needs-consent') throw error;
      const ok = await confirmDialog({
        title: 'Use only one reviewer?',
        message: `${error.message} A single reviewer gives one perspective rather than two independent ones. Add a second reviewer in Settings for a fuller review.`,
        confirmLabel: 'Use one reviewer',
      });
      if (!ok) return;
      result = await runOp(state.project?.id === project.id ? state.project : project, 'secondOpinion', { ...args, allowSingle: true });
    }
    if (result?.review) openReview(result.project, result.review);
  } catch (error) {
    showError(error);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function openSecondOpinion(project, artifactId) {
  const targets = project.gate ? [project.artifacts[project.gate.artifactId]] : editTargets(project);
  if (!targets.length) {
    toast('There is nothing to review yet. Accept some work first.');
    return;
  }
  let target = artifactId ?? targets.at(-1).id;
  let focus = draft(`review:${project.id}:focus`);
  const modal = openModal({
    title: 'Get a second opinion',
    size: 'medium',
    content: [
      h('p', { class: 'muted' }, 'Two reviewer models read the piece independently, then your default model combines their reports. This can take a few minutes and uses all three models.'),
      targets.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'review-target' }, 'Piece to review'), h('select', { id: 'review-target', value: target, onchange: (event) => { target = event.target.value; } }, targets.map((item) => h('option', { value: item.id }, artifactLabel(item))))) : h('p', null, h('strong', null, artifactLabel(targets[0]))),
      h('div', { class: 'field' }, h('label', { for: 'review-focus' }, 'What should the reviewers look at? (optional)'), h('textarea', { id: 'review-focus', rows: '3', value: focus, placeholder: 'For example: Is the pacing too slow? Does the dialogue sound like 1920s Glasgow?', oninput: (event) => { focus = event.target.value; setDraft(`review:${project.id}:focus`, focus); } })),
    ],
  });
  modal.setActions([
    h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => {
      modal.close();
      setDraft(`review:${project.id}:focus`);
      runSecondOpinion(project, { artifactId: target, focus });
    } }, 'Get second opinion'),
  ]);
}

function openAddText(project) {
  let type = 'chapter';
  let chapter = nextChapter(project);
  let complete = true;
  const content = h('textarea', { id: 'add-text', rows: '14', class: 'prose-input', placeholder: 'Paste or type your text here.', value: draft(`add:${project.id}:text`), oninput: (event) => setDraft(`add:${project.id}:text`, event.target.value) });
  const chapterField = h('div', { class: 'field' }, h('label', { for: 'add-chapter' }, 'Chapter or unit number'), h('input', { id: 'add-chapter', type: 'number', min: '1', max: '9999', value: String(chapter), oninput: (event) => { chapter = Number(event.target.value); } }));
  const completeField = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (event) => { complete = event.target.checked; } }), h('span', null, 'This chapter is finished'));
  const modal = openModal({
    title: 'Add your own writing',
    size: 'large',
    content: [
      h('p', { class: 'muted' }, 'Add text you wrote yourself, such as a chapter drafted elsewhere. It is accepted as part of the story right away, and the helpers will build on it.'),
      h('div', { class: 'two-col' },
        h('div', { class: 'field' }, h('label', { for: 'add-type' }, 'What is it?'), h('select', { id: 'add-type', onchange: (event) => {
          type = event.target.value;
          chapterField.hidden = type !== 'chapter';
          completeField.hidden = type !== 'chapter';
        } }, ['chapter', 'research', 'world', 'plot'].map((value) => h('option', { value }, value === 'chapter' ? 'A chapter or unit' : typeLabel(value))))),
        chapterField),
      completeField,
      h('div', { class: 'field' }, h('label', { for: 'add-text' }, 'Text'), content, h('p', { class: 'hint' }, 'Markdown formatting such as *italics*, **bold**, and # headings is supported.')),
    ],
  });
  modal.setActions([
    h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: async (event) => {
      if (!content.value.trim()) {
        toast('Paste or type the text to add.');
        content.focus();
        return;
      }
      const result = await perform(project, 'addText', { type, chapter, content: content.value, complete }, { button: event.currentTarget });
      if (result) {
        setDraft(`add:${project.id}:text`);
        modal.close();
      }
    } }, 'Add to story'),
  ]);
}

function openRequestReview(project) {
  const targets = editTargets(project);
  if (!targets.length) {
    toast('There is nothing accepted yet to review.');
    return;
  }
  let target = targets.at(-1).id;
  const modal = openModal({
    title: 'Review something again',
    size: 'small',
    content: [
      h('p', { class: 'muted' }, 'Reopen an accepted piece for your review. You can keep it, request changes, or get a second opinion.'),
      h('div', { class: 'field' }, h('label', { for: 'force-target' }, 'Piece'), h('select', { id: 'force-target', value: target, onchange: (event) => { target = event.target.value; } }, targets.map((item) => h('option', { value: item.id }, artifactLabel(item))))),
    ],
  });
  modal.setActions([
    h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => { modal.close(); perform(project, 'forceReview', { artifactId: target }); } }, 'Review it'),
  ]);
}

async function exportManuscript(project, format, button) {
  return withBusy(button, async () => {
    const result = await call('files:exportManuscript', { projectId: project.id, format });
    if (!result.cancelled) toast(`Saved ${result.name}.`, { kind: 'success' });
    return result;
  });
}

export function openExportMenu(project, initialTarget) {
  const tabTargets = { manuscript: 'manuscript', bible: 'bible', brief: 'brief' };
  let target = initialTarget ?? tabTargets[state.view.tab] ?? 'planning';
  if (!canExport(project, target)) target = Object.keys(EXPORT_TARGETS).find((key) => canExport(project, key)) ?? 'planning';
  const description = h('p', { class: 'muted' }, EXPORT_TARGETS[target].description);
  const buttons = [
    ['docx', 'Word document (.docx)'],
    ['md', 'Markdown (.md)'],
    ['txt', 'Plain text (.txt)'],
  ].map(([format, label], index) => h('button', {
    class: ['btn', index === 0 && 'primary'],
    type: 'button',
    disabled: !canExport(project, target),
    onclick: (event) => withBusy(event.currentTarget, async () => {
      const result = await call('files:exportDocument', { projectId: project.id, target, format });
      if (!result.cancelled) {
        toast(`Saved ${result.name}.`, { kind: 'success' });
        modal.close();
      }
    }),
  }, label));
  const select = h('select', {
    id: 'export-target',
    value: target,
    onchange: (event) => {
      target = event.target.value;
      description.textContent = EXPORT_TARGETS[target].description;
      buttons.forEach((button) => { button.disabled = !canExport(project, target); });
    },
  }, Object.entries(EXPORT_TARGETS).map(([key, option]) => h('option', {
    value: key, disabled: !canExport(project, key),
  }, option.label)));
  const modal = openModal({
    title: 'Export project content',
    size: 'small',
    content: [
      h('div', { class: 'field' }, h('label', { for: 'export-target' }, 'Content to export'), select),
      description,
      h('p', { class: 'hint' }, 'Only saved, accepted content is included. Pending, rejected, and superseded versions are excluded.'),
      h('div', { class: 'stack' }, buttons),
    ],
  });
}

// ---------- write tab ----------

function runPanel(project) {
  const run = state.runs.get(project.id);
  if (!run) return null;
  const reviewers = Object.values(run.reviewers ?? {});
  const yolo = state.yolo.get(project.id);
  return h('section', { class: 'card run-card', 'aria-busy': 'true' },
    h('div', { class: 'run-head' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('div', { class: 'run-title' }, h('strong', null, `${run.label}…`), h('span', { class: 'muted small run-elapsed', dataset: { started: String(run.startedAt) } }, formatElapsed(Date.now() - run.startedAt))),
      yolo ? h('button', {
        class: 'btn small',
        type: 'button',
        disabled: yolo.stopAfter,
        onclick: () => {
          yolo.stopAfter = true;
          actions.render();
        },
      }, yolo.stopAfter ? 'Stopping after this chapter' : 'Stop after this chapter') : null,
      h('button', { class: 'btn small danger', type: 'button', onclick: () => stopRun(project.id) }, 'Stop')),
    yolo ? h('p', { class: 'muted small yolo-progress' }, `YOLO mode: chapter ${yolo.chapter} of ${yolo.first}–${yolo.last}. ${plural(yolo.written, 'chapter')} accepted so far. It pauses if a chapter needs your review.`) : null,
    reviewers.length ? h('ul', { class: 'reviewer-status' }, reviewers.map((item) => h('li', { class: `state-${item.state}` },
      `${item.reviewer === 'consolidation' ? 'Combining reports' : `Reviewer ${item.reviewer}`} (${item.model}): ${item.state === 'running' ? 'working' : item.state === 'done' ? 'done' : `failed. ${item.error ?? ''}`}`))) : null,
    h('div', { class: 'stream', id: `stream-${project.id}`, 'aria-live': 'off' }, run.text || 'Waiting for the model to start writing…'),
    h('p', { class: 'hint' }, yolo ? 'Stopping discards the chapter in progress; chapters already accepted are kept.' : 'Stopping discards this step; your story is not changed.'));
}

function reviewCard(project) {
  const gate = project.gate;
  const artifact = project.artifacts[gate.artifactId];
  const running = state.runs.has(project.id);
  const isReview = gate.kind === 'review';
  const confirmKey = `gate:${project.id}:${artifact.id}:confirmed`;
  const confirmed = new Set(draft(confirmKey, []));
  const allConfirmed = gate.contradictions.every((_, index) => confirmed.has(index));
  const patchLines = isReview ? [] : describePatch(artifact.proposedChanges, project.state);
  const reviews = project.reviews.filter((review) => review.artifactId === artifact.id);
  const notesKey = `gate:${project.id}:notes`;
  const changesOpen = draft(`gate:${project.id}:changesOpen`, false);
  const canRevise = RUNNABLE_WORKERS.has(artifact.worker);

  const approve = h('button', {
    class: 'btn primary',
    type: 'button',
    disabled: running || !allConfirmed,
    onclick: (event) => perform(project, 'approve', { confirmed: [...confirmed] }, { button: event.currentTarget }).then((result) => {
      if (result) setDraft(confirmKey);
    }),
  }, isReview ? 'Keep as it is' : 'Approve');

  const reject = h('button', {
    class: 'btn ghost danger-text',
    type: 'button',
    disabled: running,
    onclick: async (event) => {
      const button = event.currentTarget;
      if (!isReview && !await confirmDialog({
        title: `Set aside ${artifactLabel(artifact)}?`,
        message: 'This version is not added to your story. You can still read it in History.',
        confirmLabel: 'Set it aside',
        danger: true,
      })) return;
      perform(project, 'reject', {}, { button });
    },
  }, isReview ? 'Close review' : 'Reject');

  const notes = h('textarea', {
    id: 'gate-notes',
    dataset: { key: 'gate-notes' },
    rows: '4',
    placeholder: 'For example: Make the ending less tidy, and keep Mara\'s voice drier.',
    value: draft(notesKey),
    oninput: (event) => setDraft(notesKey, event.target.value),
    onkeydown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) reviseButton.click();
    },
  });
  const reviseButton = h('button', {
    class: 'btn primary',
    type: 'button',
    disabled: running,
    onclick: async (event) => {
      if (!notes.value.trim()) {
        toast('Describe the changes you want.');
        notes.focus();
        return;
      }
      const result = await perform(project, 'modify', { notes: notes.value }, { button: event.currentTarget });
      if (result) {
        setDraft(notesKey);
        setDraft(`gate:${project.id}:changesOpen`);
        actions.render();
      }
    },
  }, 'Revise');

  return h('section', { class: ['card', 'review-card', isReview && 'is-review'] },
    h('div', { class: 'review-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, isReview ? 'You asked to review this' : 'Needs your review'),
        h('h2', null, artifactLabel(artifact)),
        artifactMeta(artifact)),
      artifact.worker === 'Author' ? null : confidenceMeter(artifact)),
    bulletList('Why it is waiting for you', gate.reasons, 'reasons'),
    gate.contradictions.length ? h('div', { class: 'detail-block contradictions' },
      h('h3', null, 'Changes to your established story'),
      h('p', { class: 'muted small' }, 'This version changes things you already accepted. Tick each change you want to keep, or request changes instead.'),
      h('ul', { class: 'check-list' }, gate.contradictions.map((text, index) => h('li', null, h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: confirmed.has(index), disabled: running, onchange: (event) => {
          if (event.target.checked) confirmed.add(index);
          else confirmed.delete(index);
          setDraft(confirmKey, [...confirmed]);
          approve.disabled = running || !gate.contradictions.every((_, item) => confirmed.has(item));
        } }),
        h('span', null, text)))))) : null,
    artifact.rationale ? h('div', { class: 'detail-block' }, h('h3', null, 'The writer\'s assessment'), h('p', null, artifact.rationale)) : null,
    artifact.changeSummary ? h('div', { class: 'detail-block' }, h('h3', null, 'What changed'), h('p', null, artifact.changeSummary)) : null,
    bulletList('Things to check', artifact.flags),
    bulletList('Problems this revision did not fix', artifact.unresolved),
    bulletList('If you approve, the story bible gains', patchLines, 'patch'),
    continuityNotesPanel(artifact),
    artifact.complete === false ? h('div', { class: 'callout callout-warning' }, 'This text is unfinished. Continue writing to extend it, or approve it as it is and continue later.') : null,
    h('div', { class: 'review-text' }, renderMarkdown(artifact.content)),
    reviews.length ? h('div', { class: 'detail-block' },
      h('h3', null, 'Second opinions'),
      h('ul', { class: 'plain-list' }, reviews.map((review) => h('li', null, h('button', { class: 'link-button', type: 'button', onclick: () => openReview(project, review) }, `${review.mode === 'single' ? 'Single review' : 'Second opinion'} from ${timeAgo(review.createdAt)}`))))) : null,
    h('div', { class: 'review-actions' },
      approve,
      canRevise ? h('button', { class: 'btn', type: 'button', disabled: running, onclick: () => {
        setDraft(`gate:${project.id}:changesOpen`, !changesOpen || undefined);
        actions.render();
        requestAnimationFrame(() => document.getElementById('gate-notes')?.focus());
      } }, 'Request changes') : null,
      !isReview && artifact.complete === false && canRevise ? h('button', { class: 'btn', type: 'button', disabled: running, onclick: (event) => perform(project, 'continuePending', {}, { button: event.currentTarget }) }, 'Continue writing') : null,
      h('button', { class: 'btn', type: 'button', disabled: running, onclick: (event) => runSecondOpinion(project, { artifactId: artifact.id, focus: '' }, event.currentTarget) }, 'Second opinion'),
      h('span', { class: 'spacer' }),
      reject),
    changesOpen && canRevise ? h('div', { class: 'changes-panel' },
      h('label', { for: 'gate-notes' }, 'What should change?'),
      notes,
      h('div', { class: 'button-row' }, h('button', { class: 'btn', type: 'button', onclick: () => { setDraft(`gate:${project.id}:changesOpen`); actions.render(); } }, 'Cancel'), reviseButton)) : null,
  );
}

function composer(project) {
  const id = project.id;
  const running = state.runs.has(id);
  const connection = activeConnection();
  const suggested = suggestStep(project);
  const targets = editTargets(project);
  let action = draft(`step:${id}:action`, suggested);
  if (action === 'edit' && !targets.length) action = suggested;
  const chapter = draft(`step:${id}:chapter`, String(nextChapter(project)));
  const targetDraft = draft(`step:${id}:target`, targets.at(-1)?.id ?? '');
  const target = targets.some((item) => item.id === targetDraft) ? targetDraft : targets.at(-1)?.id ?? '';
  const notesKey = `step:${id}:notes`;
  const needsKey = connection && state.settings.connectionTypes[connection.type].needsKey && !connection.hasKey;
  const yoloKey = `step:${id}:yolo`;
  const yoloLastKey = `step:${id}:yoloLast`;
  const yoloOn = action === 'draft' && draft(yoloKey, false) === true;
  const yoloLastDefault = () => String((Number(draft(`step:${id}:chapter`, chapter)) || 1) + 4);
  const startLabel = () => {
    const current = draft(`step:${id}:chapter`, chapter);
    if (action === 'draft' && draft(yoloKey, false) === true) return `Write chapters ${current}–${draft(yoloLastKey, yoloLastDefault())}`;
    if (action === 'draft') return `Write chapter ${current}`;
    return action === 'edit' ? 'Revise' : `Start ${STEPS[action].title.toLowerCase()}`;
  };

  const start = h('button', {
    class: 'btn primary',
    type: 'button',
    disabled: running || state.yolo.has(id) || !connection || needsKey,
    onclick: async (event) => {
      const args = { action, notes: draft(notesKey) };
      if (action === 'draft') {
        args.chapter = Number(draft(`step:${id}:chapter`, chapter));
        if (!Number.isInteger(args.chapter) || args.chapter < 1) {
          toast('Choose a chapter number (1, 2, 3, …).');
          return;
        }
      }
      if (action === 'edit') args.target = target;
      if (yoloOn) {
        const last = Number(draft(yoloLastKey, yoloLastDefault()));
        if (!Number.isInteger(last) || last < args.chapter || last > MAX_CHAPTER) {
          toast(`Choose a last chapter from ${args.chapter} to ${MAX_CHAPTER}.`);
          return;
        }
        const result = await runYolo(project, { first: args.chapter, last, notes: args.notes }, { button: event.currentTarget });
        if (result.written) {
          setDraft(notesKey);
          setDraft(`step:${id}:chapter`);
          setDraft(yoloLastKey);
          actions.render();
        }
        return;
      }
      const result = await perform(project, 'step', args, { button: event.currentTarget });
      if (result) {
        setDraft(notesKey);
        setDraft(`step:${id}:chapter`);
        setDraft(`step:${id}:action`);
        actions.render();
      }
    },
  }, startLabel());

  const notes = h('textarea', {
    id: 'step-notes',
    dataset: { key: 'step-notes' },
    rows: '3',
    placeholder: action === 'edit' ? 'What should the Editor change? For example: Tighten the opening and cut the flashback.' : 'Anything the helper should know for this step (optional). For example: Introduce the rival baker; keep the tone light.',
    value: draft(notesKey),
    oninput: (event) => setDraft(notesKey, event.target.value),
    onkeydown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) start.click();
    },
  });

  return h('section', { class: 'card composer' },
    h('h2', null, 'What next?'),
    h('div', { class: 'step-picker', role: 'radiogroup', 'aria-label': 'Step' }, Object.entries(STEPS).map(([key, info]) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(action === key),
      class: ['step-option', action === key && 'is-selected'],
      disabled: key === 'edit' && !targets.length,
      title: key === 'edit' && !targets.length ? 'Accept something first, then you can revise it.' : info.text,
      onclick: () => {
        setDraft(`step:${id}:action`, key);
        actions.render();
      },
    }, info.title, key === suggested ? h('span', { class: 'suggested' }, 'Suggested') : null))),
    h('p', { class: 'muted' }, STEPS[action].text),
    action === 'draft' ? h('div', { class: 'field inline-field' }, h('label', { for: 'step-chapter' }, 'Chapter'), h('input', {
      id: 'step-chapter',
      dataset: { key: 'step-chapter' },
      type: 'number',
      min: '1',
      max: '9999',
      value: chapter,
      oninput: (event) => {
        setDraft(`step:${id}:chapter`, event.target.value);
        start.textContent = startLabel();
      },
    })) : null,
    action === 'draft' ? h('div', { class: 'yolo-options' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'step-yolo', checked: yoloOn, onchange: (event) => {
          setDraft(yoloKey, event.target.checked || undefined);
          actions.render();
        } }),
        h('span', null, h('strong', null, 'YOLO mode'), h('span', { class: 'block muted small' }, 'Keep writing chapters one after another without clicking Write each time. Chapters the writer is confident about are accepted automatically; it pauses as soon as one needs your review.'))),
      yoloOn ? h('div', { class: 'field inline-field' }, h('label', { for: 'step-yolo-last' }, 'Through chapter'), h('input', {
        id: 'step-yolo-last',
        dataset: { key: 'step-yolo-last' },
        type: 'number',
        min: '1',
        max: String(MAX_CHAPTER),
        value: draft(yoloLastKey, yoloLastDefault()),
        oninput: (event) => {
          setDraft(yoloLastKey, event.target.value);
          start.textContent = startLabel();
        },
      })) : null) : null,
    action === 'edit' ? h('div', { class: 'field' }, h('label', { for: 'step-target' }, 'Revise'), h('select', {
      id: 'step-target',
      value: target,
      onchange: (event) => setDraft(`step:${id}:target`, event.target.value),
    }, targets.map((item) => h('option', { value: item.id }, artifactLabel(item))))) : null,
    h('div', { class: 'field' }, h('label', { for: 'step-notes' }, action === 'edit' ? 'Your notes' : yoloOn ? 'Notes for the first chapter' : 'Notes for this step'), notes),
    h('div', { class: 'composer-foot' },
      connection
        ? h('span', { class: 'muted small' }, `Using ${connection.label}. `, h('button', { class: 'link-button', type: 'button', onclick: () => actions.navigate({ name: 'settings' }) }, 'Change'),
          needsKey ? h('span', { class: 'error-text' }, ' Add its API key in Settings.') : null,
          connection.type === 'apple' ? h('span', { class: 'block hint' }, 'Apple Intelligence is a small model: expect shorter, simpler text and more work to review.') : null)
        : h('span', { class: 'error-text small' }, 'Connect an AI model in Settings to run steps. ', h('button', { class: 'link-button', type: 'button', onclick: () => actions.navigate({ name: 'settings' }) }, 'Open Settings')),
      h('span', { class: 'spacer' }),
      start),
  );
}

function toolsRow(project) {
  const running = state.runs.has(project.id);
  return h('div', { class: 'tools-row' },
    h('button', { class: 'btn ghost', type: 'button', disabled: running, onclick: () => openAddText(project) }, 'Add your own writing'),
    h('button', { class: 'btn ghost', type: 'button', disabled: running, onclick: () => openRequestReview(project) }, 'Review something again'),
    h('button', { class: 'btn ghost', type: 'button', disabled: running, onclick: () => openSecondOpinion(project) }, 'Get a second opinion'));
}

function lastResultPanel(project) {
  const id = state.lastResult.get(project.id);
  const artifact = id ? project.artifacts[id] : null;
  if (!artifact || project.gate || artifact.status !== 'accepted') return null;
  return h('section', { class: 'card result-card' },
    h('div', { class: 'review-head' },
      h('div', null, h('p', { class: 'eyebrow success-text' }, 'Accepted'), h('h2', null, artifactLabel(artifact)), artifactMeta(artifact)),
      artifact.worker === 'Author' ? null : confidenceMeter(artifact)),
    artifact.type === 'chapter' && artifact.complete === false ? h('div', { class: 'callout callout-warning' }, 'This text is unfinished. You can continue it at any time.') : null,
    h('div', { class: 'result-text' }, renderMarkdown(artifact.content)),
    continuityNotesPanel(artifact),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => openArtifact(project, artifact.id) }, 'Open'),
      h('button', { class: 'btn', type: 'button', disabled: state.runs.has(project.id), onclick: () => prepareEdit(project, artifact) }, 'Revise…'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.lastResult.delete(project.id); actions.render(); } }, 'Dismiss')));
}

function activityList(project) {
  const items = [...project.activity].reverse().slice(0, 40);
  if (!items.length) return null;
  return h('section', { class: 'activity' },
    h('h2', null, 'Recent activity'),
    h('ol', { class: 'activity-list' }, items.map((item) => {
      const artifact = item.artifactId ? project.artifacts[item.artifactId] : null;
      const review = item.reviewId ? project.reviews.find((entry) => entry.id === item.reviewId) : null;
      const title = review
        ? h('button', { class: 'link-button', type: 'button', onclick: () => openReview(project, review) }, item.title)
        : artifact ? h('button', { class: 'link-button', type: 'button', onclick: () => openArtifact(project, artifact.id) }, item.title) : h('span', null, item.title);
      return h('li', { class: `activity-${item.kind}` },
        h('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'activity-body' }, title, item.reasons?.length ? h('ul', { class: 'small muted' }, item.reasons.map((reason) => h('li', null, reason))) : null),
        h('time', { class: 'muted small', datetime: item.at, title: formatDateTime(item.at) }, timeAgo(item.at)));
    })));
}

function studioTab(project) {
  return [
    runPanel(project),
    project.gate ? reviewCard(project) : composer(project),
    project.gate ? null : toolsRow(project),
    lastResultPanel(project),
    activityList(project),
  ];
}

// ---------- other tabs ----------

function manuscriptTab(project) {
  const chapters = acceptedChapters(project);
  const running = state.runs.has(project.id);
  const canAct = !running && !project.gate;
  return [
    h('div', { class: 'section-head' },
      h('div', null, h('h2', null, 'Manuscript'), h('p', { class: 'muted' }, `${plural(chapters.length, 'chapter')} · ${plural(manuscriptWords(project), 'word')}`)),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', disabled: !chapters.length, onclick: (event) => exportManuscript(project, 'docx', event.currentTarget) }, 'Export for Word'),
        h('button', { class: 'btn', type: 'button', disabled: !chapters.length, onclick: () => openExportMenu(project, 'manuscript') }, 'Other formats…'))),
    chapters.length
      ? h('article', { class: 'manuscript' },
        h('h1', { class: 'manuscript-title' }, project.state.project.title || 'Untitled'),
        chapters.map((chapter) => h('section', { class: 'manuscript-chapter' },
          h('div', { class: 'chapter-tools' },
            h('span', { class: 'muted small' }, `${artifactLabel(chapter)} · ${plural(chapter.words ?? 0, 'word')}${chapter.worker === 'Author' ? ' · written by you' : ''}`),
            chapter.complete === false ? h('span', { class: 'badge badge-warning' }, 'Unfinished') : null,
            h('span', { class: 'spacer' }),
            chapter.complete === false ? h('button', { class: 'btn small', type: 'button', disabled: !canAct, onclick: (event) => perform(project, 'continueAccepted', { artifactId: chapter.id }, { button: event.currentTarget }) }, 'Continue writing') : null,
            h('button', { class: 'btn small', type: 'button', disabled: !canAct, onclick: () => prepareEdit(project, chapter) }, 'Revise…'),
            h('button', { class: 'btn small', type: 'button', disabled: !canAct, onclick: (event) => perform(project, 'forceReview', { artifactId: chapter.id }, { button: event.currentTarget }) }, 'Review again')),
          renderMarkdown(/^#{1,6}\s/.test(chapter.content) ? chapter.content : `## Chapter ${chapter.chapter}\n\n${chapter.content}`, 'prose manuscript-text'))))
      : h('div', { class: 'empty-state' },
        h('h2', null, 'No chapters yet'),
        h('p', null, 'Accepted chapters appear here in order, ready to read and export.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          setDraft(`step:${project.id}:action`, 'draft');
          actions.navigate({ name: 'project', id: project.id, tab: 'studio' });
        } }, 'Write chapter 1')),
  ];
}

function textList(items, ordered = false) {
  return h(ordered ? 'ol' : 'ul', { class: 'bible-list' }, items.map((item) => h('li', null, toText(item))));
}

function bibleSection(title, hint, content) {
  return h('section', { class: 'bible-section' }, h('h3', null, title), hint ? h('p', { class: 'hint' }, hint) : null, content);
}

function bibleTab(project) {
  const { lore, plot, characters } = project.state;
  const chapterUpdates = acceptedChapters(project).filter((item) => item.continuityNotes || describePatch(item.proposedChanges).length);
  const documents = accepted(project).filter((item) => ['research', 'world', 'plot'].includes(item.type)).sort((a, b) => String(a.acceptedAt).localeCompare(String(b.acceptedAt)));
  const empty = !characters.length && !lore.tech_level && !lore.magic_system && !lore.key_factions.length && !lore.timeline_log.length
    && !plot.act_beats.length && !plot.loose_threads.length && !plot.twist_map.length && !documents.length && !chapterUpdates.length;
  if (empty) {
    return h('div', { class: 'empty-state' },
      h('h2', null, 'The story bible is empty'),
      h('p', null, 'As you accept research, setting, and story plans, the people, places, and plot points of your story collect here, so every helper stays consistent with what you have decided.'));
  }
  const characterKnown = ['name', 'role', 'arc_stage', 'voice_notes'];
  return [
    h('div', { class: 'section-head' },
      h('div', null, h('h2', null, 'Story bible'), h('p', { class: 'muted' }, 'What you have established so far. It updates when you accept work.')),
      h('button', { class: 'btn', type: 'button', disabled: !canExport(project, 'bible'), onclick: () => openExportMenu(project, 'bible') }, 'Export story bible…')),
    characters.length ? bibleSection('Characters', null, h('div', { class: 'character-grid' }, characters.map((character) => h('article', { class: 'character-card' },
      h('h4', null, character.name),
      character.role ? h('p', null, h('span', { class: 'label' }, 'Role '), character.role) : null,
      character.arc_stage ? h('p', null, h('span', { class: 'label' }, 'Arc '), character.arc_stage) : null,
      character.voice_notes ? h('p', null, h('span', { class: 'label' }, 'Voice '), character.voice_notes) : null,
      Object.entries(character).filter(([key, value]) => !characterKnown.includes(key) && toText(value)).map(([key, value]) => h('p', null, h('span', { class: 'label' }, `${key.replace(/_/g, ' ')} `), toText(value))))))) : null,
    lore.tech_level ? bibleSection('Technology and period', null, h('p', null, lore.tech_level)) : null,
    lore.magic_system ? bibleSection('Rules of the world', 'Magic, technology, institutions, or any system the story depends on.', h('p', null, lore.magic_system)) : null,
    lore.key_factions.length ? bibleSection('Groups and factions', null, textList(lore.key_factions)) : null,
    lore.timeline_log.length ? bibleSection('Timeline', null, textList(lore.timeline_log)) : null,
    plot.act_beats.length ? bibleSection('Story beats', null, textList(plot.act_beats, true)) : null,
    plot.loose_threads.length ? bibleSection('Open threads', 'Questions and promises the story still needs to pay off.', textList(plot.loose_threads)) : null,
    plot.twist_map.length ? bibleSection('Twists and reveals', null, textList(plot.twist_map)) : null,
    chapterUpdates.length ? bibleSection('Chapter updates', 'Updates submitted with each accepted chapter, including thread resolutions. Earlier versions remain in History.',
      chapterUpdates.map((item) => h('details', { class: 'detail-block' },
        h('summary', null, artifactLabel(item)),
        bulletList('Submitted story bible updates', describePatch(item.proposedChanges)),
        continuityNotesPanel(item)))) : null,
    documents.length ? bibleSection('Planning documents', null, h('ul', { class: 'plain-list' }, documents.map((item) => h('li', null, h('button', { class: 'link-button', type: 'button', onclick: () => openArtifact(project, item.id) }, artifactLabel(item)), h('span', { class: 'muted small' }, ` · ${plural(item.words ?? 0, 'word')}`))))) : null,
  ];
}

function briefTab(project) {
  const info = project.state.project;
  const brief = accepted(project).find((item) => item.type === 'brief');
  const key = (name) => `brief:${project.id}:${name}`;
  const running = state.runs.has(project.id);
  const input = (name, initial, props) => ({
    id: `brief-${name}`,
    dataset: { key: `brief-${name}` },
    value: draft(key(name), initial),
    oninput: (event) => setDraft(key(name), event.target.value),
    ...props,
  });
  return [
    h('div', { class: 'section-head' },
      h('div', null, h('h2', null, 'Idea and brief'), h('p', { class: 'muted' }, 'Every helper reads these before each step. Changes apply to future steps, not to work you have already accepted.')),
      h('button', { class: 'btn', type: 'button', disabled: !canExport(project, 'brief'), onclick: () => openExportMenu(project, 'brief') }, 'Export idea and brief…')),
    h('div', { class: 'card form-card' },
      h('div', { class: 'two-col' },
        h('div', { class: 'field' }, h('label', { for: 'brief-title' }, 'Title'), h('input', input('title', info.title, { type: 'text', maxlength: '120' }))),
        h('div', { class: 'field' }, h('label', { for: 'brief-genre' }, 'Genre'), h('input', input('genre', info.genre, { type: 'text', maxlength: '200' })))),
      h('div', { class: 'field' }, h('label', { for: 'brief-concept' }, 'Story idea'), h('textarea', input('concept', info.concept, { rows: '6' }))),
      h('div', { class: 'field' }, h('label', { for: 'brief-brief' }, 'Creative brief'), h('textarea', input('brief', brief?.content ?? '', { rows: '12', class: 'prose-input', placeholder: 'Form, length, point of view, tense, voice, audience, and anything to avoid.' })),
        h('p', { class: 'hint' }, 'Markdown formatting is supported.')),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { ['title', 'genre', 'concept', 'brief'].forEach((name) => setDraft(key(name))); actions.render(); } }, 'Undo changes'),
        h('button', { class: 'btn primary', type: 'button', disabled: running, onclick: async (event) => {
          const fields = {};
          for (const name of ['title', 'genre', 'concept', 'brief']) if (state.drafts.has(key(name))) fields[name] = state.drafts.get(key(name));
          if (!Object.keys(fields).length) {
            toast('There are no changes to save.');
            return;
          }
          const result = await perform(project, 'updateBrief', fields, { button: event.currentTarget });
          if (result) {
            Object.keys(fields).forEach((name) => setDraft(key(name)));
            toast(result.outcome === 'updated' ? 'Saved your changes.' : 'Nothing changed.', { kind: 'success' });
            actions.render();
          }
        } }, 'Save changes'))),
  ];
}

function historyTab(project) {
  const artifacts = Object.values(project.artifacts).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const log = [...project.state.orchestrator_log].reverse();
  return [
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, 'History'), h('p', { class: 'muted' }, 'Every version, review, and decision in this project.'))),
    h('section', { class: 'history-section' },
      h('h3', null, 'Versions'),
      artifacts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, ['Piece', 'Status', 'By', 'Confidence', 'Words', 'Created', ''].map((label) => h('th', null, label)))),
        h('tbody', null, artifacts.map((item) => h('tr', null,
          h('td', null, artifactLabel(item)),
          h('td', null, h('span', { class: ['badge', item.status === 'accepted' ? 'badge-success' : item.status === 'pending' ? 'badge-warning' : 'badge-neutral'] }, ARTIFACT_STATUS_LABELS[item.status] ?? item.status)),
          h('td', null, item.worker === 'Author' ? 'You' : item.worker),
          h('td', null, typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '—'),
          h('td', { class: 'num' }, (item.words ?? 0).toLocaleString()),
          h('td', null, h('time', { datetime: item.createdAt, title: formatDateTime(item.createdAt) }, timeAgo(item.createdAt))),
          h('td', null, h('button', { class: 'btn small', type: 'button', onclick: () => openArtifact(project, item.id) }, 'View'))))))) : h('p', { class: 'muted' }, 'Nothing yet.')),
    project.reviews.length ? h('section', { class: 'history-section' },
      h('h3', null, 'Second opinions'),
      h('ul', { class: 'plain-list' }, [...project.reviews].reverse().map((review) => {
        const artifact = project.artifacts[review.artifactId];
        return h('li', null, h('button', { class: 'link-button', type: 'button', onclick: () => openReview(project, review) }, `${artifact ? artifactLabel(artifact) : review.artifactId}`), h('span', { class: 'muted small' }, ` · ${formatDateTime(review.createdAt)}`));
      }))) : null,
    h('section', { class: 'history-section' },
      h('h3', null, 'Decision log'),
      h('p', { class: 'hint' }, 'The same log the Author Studio plugin keeps, so you can follow how the story developed.'),
      log.length ? h('ol', { class: 'log-list' }, log.map((entry) => h('li', null,
        h('span', { class: 'log-step' }, Object.hasOwn(LOG_STEP_LABELS, entry.step) ? LOG_STEP_LABELS[entry.step] : entry.step),
        h('span', { class: 'muted small' }, `${entry.worker}${typeof entry.confidence === 'number' ? ` · ${Math.round(entry.confidence * 100)}%` : ''}`),
        h('p', null, entry.action)))) : h('p', { class: 'muted' }, 'Nothing yet.')),
    h('section', { class: 'history-section' },
      h('h3', null, 'Backups and sharing'),
      h('p', { class: 'muted' }, 'A backup holds everything in this project, including every version. A state file holds the story bible and progress in the format the Author Studio plugin for GitHub Copilot and Claude Code uses, so you can continue there.'),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: (event) => withBusy(event.currentTarget, async () => {
          const result = await call('files:exportBackup', { projectId: project.id });
          if (!result.cancelled) toast(`Saved ${result.name}.`, { kind: 'success' });
        }) }, 'Back up project…'),
        h('button', { class: 'btn', type: 'button', onclick: (event) => withBusy(event.currentTarget, async () => {
          const result = await call('files:exportSnapshot', { projectId: project.id });
          if (!result.cancelled) toast(`Saved ${result.name}.`, { kind: 'success' });
        }) }, 'Export state file for the plugin…'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost danger-text', type: 'button', disabled: state.runs.has(project.id), onclick: () => deleteProject(project) }, 'Delete project…'))),
  ];
}

const TAB_RENDERERS = { studio: studioTab, manuscript: manuscriptTab, bible: bibleTab, brief: briefTab, history: historyTab };

export function renderWorkspace() {
  const project = state.project;
  if (!project) return h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Opening…'));
  const tab = TAB_RENDERERS[state.view.tab] ? state.view.tab : 'studio';
  const info = project.state.project;
  const status = project.gate ? STATUS_LABELS.review : STATUS_LABELS[info.status] ?? info.status;
  return h('div', { class: 'page workspace' },
    h('header', { class: 'workspace-header' },
      h('div', { class: 'section-head' },
        h('div', null,
          h('h1', null, info.title || 'Untitled'),
          h('p', { class: 'muted' }, [info.genre, status, plural(manuscriptWords(project), 'word')].filter(Boolean).join(' · '))),
        h('button', { class: 'btn', type: 'button', onclick: () => openExportMenu(project) }, 'Export…')),
      h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Project sections' }, TABS.map(([key, label]) => h('button', {
        type: 'button',
        role: 'tab',
        id: `tab-${key}`,
        'aria-selected': String(tab === key),
        'aria-controls': 'tab-panel',
        class: ['tab', tab === key && 'is-selected'],
        onclick: () => actions.navigate({ name: 'project', id: project.id, tab: key }),
      }, label, key === 'studio' && project.gate ? h('span', { class: 'tab-dot', title: 'Something is waiting for your review' }) : null)))),
    h('div', { class: 'tab-panel', id: 'tab-panel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, TAB_RENDERERS[tab](project)));
}

export function updateRunView(projectId) {
  const run = state.runs.get(projectId);
  const element = document.getElementById(`stream-${projectId}`);
  if (!run || !element) return;
  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  element.textContent = run.text || 'Waiting for the model to start writing…';
  if (atBottom) element.scrollTop = element.scrollHeight;
}
