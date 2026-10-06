// The project list, the first-run welcome, new projects, and imports.
import { STATUS_LABELS } from '../../core/labels.js';
import { call } from '../api.js';
import { h, plural, timeAgo } from '../dom.js';
import { actions, activeConnection, draft, setDraft, state } from '../store.js';
import { confirmDialog, openModal, showError, toast, withBusy } from '../ui.js';
import { chooseConnectionType, openConnectionEditor, typeCards } from './settings.js';

const GENRES = ['Literary fiction', 'Romance', 'Mystery', 'Thriller', 'Horror', 'Historical fiction', 'Fantasy', 'Science fiction', 'Young adult', 'Short story', 'Poetry collection', 'Screenplay'];

export function renderWelcome() {
  return h('div', { class: 'page welcome-page' },
    h('header', { class: 'welcome-header' },
      h('h1', null, 'Welcome to Author Studio'),
      h('p', { class: 'lead' }, 'A writing studio where you stay in charge. AI helpers research, plan, draft, and revise; you review their work and decide what becomes part of your story.')),
    h('h2', null, 'First, choose an AI model'),
    typeCards((type) => openConnectionEditor({ type })),
    h('p', { class: 'muted' }, 'You can connect more models later in Settings and switch between them at any time.'),
    h('div', { class: 'button-row' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => actions.navigate({ name: 'projects' }) }, 'Skip for now'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => actions.navigate({ name: 'help' }) }, 'How Author Studio works')),
  );
}

function projectCard(summary) {
  const running = state.runs.has(summary.id);
  const status = summary.damaged ? 'Damaged' : summary.pending ? 'Waiting for your review' : STATUS_LABELS[summary.status] ?? summary.status;
  return h('li', null, h('button', {
    class: ['project-card', summary.damaged && 'is-damaged'],
    type: 'button',
    dataset: { id: summary.id },
    onclick: () => actions.openProject(summary.id),
  },
  h('span', { class: 'project-card-title' }, summary.title),
  summary.genre ? h('span', { class: 'project-card-genre muted' }, summary.genre) : null,
  h('span', { class: 'project-card-meta' },
    running ? h('span', { class: 'badge badge-accent' }, 'Working…') : h('span', { class: ['badge', summary.pending ? 'badge-warning' : summary.damaged ? 'badge-error' : 'badge-neutral'] }, status),
    summary.damaged ? null : h('span', { class: 'muted' }, `${plural(summary.words ?? 0, 'word')} · ${plural(summary.chapters ?? 0, 'chapter')}`)),
  h('span', { class: 'project-card-time muted' }, summary.recovered ? 'Restored from backup' : `Edited ${timeAgo(summary.updatedAt)}`)));
}

export function renderProjects() {
  const connection = activeConnection();
  return h('div', { class: 'page projects-page' },
    h('header', { class: 'page-header' },
      h('h1', null, 'Your projects'),
      h('div', { class: 'button-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => importProject() }, 'Open backup or state file…'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openNewProject() }, 'New project'))),
    connection ? null : h('div', { class: 'callout callout-info banner' },
      h('span', null, 'Connect an AI model to research, plan, and draft with Author Studio. You can still create projects and add your own writing without one.'),
      h('button', { class: 'btn small primary', type: 'button', onclick: chooseConnectionType }, 'Connect a model')),
    state.projects.length
      ? h('ul', { class: 'project-grid' }, state.projects.map(projectCard))
      : h('div', { class: 'empty-state' },
        h('h2', null, 'No projects yet'),
        h('p', null, 'Start with a story idea: a sentence, a paragraph, or a page of notes.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openNewProject() }, 'Start a project')),
  );
}

// Reads a JSON string field from a reply that may still be arriving.
function partialJsonField(text, name) {
  const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 's').exec(text);
  if (!match) return '';
  const raw = match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

// The brief arrives as JSON; show its title and text rather than the markup.
function briefPreview(text) {
  if (!/^\s*(?:```\w*\s*)?\{/.test(text)) return text.trim();
  const title = partialJsonField(text, 'title');
  const brief = partialJsonField(text, 'brief');
  return [title && `Working title: ${title}`, brief].filter(Boolean).join('\n\n');
}

export function openNewProject() {
  if (state.runs.has('new-project')) {
    toast('A new project is still being set up. Wait for it to finish.');
    return;
  }
  const connection = activeConnection();
  const canUseAi = Boolean(connection) && (!state.settings.connectionTypes[connection.type].needsKey || connection.hasKey);
  let useAi = canUseAi && draft('new-project:useAi', true);
  const modal = openModal({ title: 'New project', size: 'medium' });
  const concept = h('textarea', {
    id: 'new-concept',
    dataset: { key: 'new-concept' },
    rows: '7',
    autofocus: true,
    placeholder: 'For example: A retired lighthouse keeper on a Scottish island finds a message in a bottle written in her late husband\'s hand.',
    value: draft('new-project:concept'),
    oninput: (event) => setDraft('new-project:concept', event.target.value),
  });
  const title = h('input', { id: 'new-title', type: 'text', maxlength: '120', placeholder: 'Leave blank to choose one later', value: draft('new-project:title'), oninput: (event) => setDraft('new-project:title', event.target.value) });
  const genre = h('input', { id: 'new-genre', type: 'text', list: 'genre-list', maxlength: '200', placeholder: 'Any genre, or a blend', value: draft('new-project:genre'), oninput: (event) => setDraft('new-project:genre', event.target.value) });
  const aiBox = h('input', { type: 'checkbox', checked: useAi, disabled: !canUseAi, onchange: (event) => { useAi = event.target.checked; setDraft('new-project:useAi', useAi); } });
  const errorBox = h('div', { class: 'callout callout-error', role: 'alert', hidden: true });
  const stream = h('div', { class: 'stream small', hidden: true, 'aria-live': 'off' });

  modal.setContent(
    h('div', { class: 'field' }, h('label', { for: 'new-concept' }, 'What is your story about?'), concept, h('p', { class: 'hint' }, 'Include anything you already know: characters, setting, tone, length, or the form it should take.')),
    h('div', { class: 'two-col' },
      h('div', { class: 'field' }, h('label', { for: 'new-title' }, 'Title (optional)'), title),
      h('div', { class: 'field' }, h('label', { for: 'new-genre' }, 'Genre (optional)'), genre, h('datalist', { id: 'genre-list' }, GENRES.map((item) => h('option', { value: item }))))),
    h('label', { class: 'check' }, aiBox, h('span', null,
      canUseAi ? 'Turn this into a creative brief with AI' : 'Turn this into a creative brief (connect an AI model first)',
      h('span', { class: 'hint block' }, `${canUseAi ? `Uses ${connection.name}. ` : ''}The brief records the form, voice, and scope the helpers will follow. You can edit it at any time.`))),
    stream,
    errorBox,
  );

  const createButton = h('button', { class: 'btn primary', type: 'button' }, 'Create project');
  const cancelButton = h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel');
  const stopButton = h('button', { class: 'btn danger', type: 'button', hidden: true, onclick: () => call('engine:cancel', { projectId: 'new-project' }).catch(showError) }, 'Stop');
  modal.setActions([stopButton, h('span', { class: 'spacer' }), cancelButton, createButton]);

  createButton.addEventListener('click', async () => {
    errorBox.hidden = true;
    if (!concept.value.trim()) {
      errorBox.textContent = 'Describe your story idea to start.';
      errorBox.hidden = false;
      concept.focus();
      return;
    }
    const ai = useAi && canUseAi;
    state.runs.set('new-project', { op: 'create', label: 'Writing your creative brief', text: '', startedAt: Date.now(), reviewers: {} });
    modal.setBusy(true);
    createButton.disabled = true;
    createButton.textContent = ai ? 'Writing the brief…' : 'Creating…';
    cancelButton.hidden = true;
    stopButton.hidden = !ai;
    stream.hidden = !ai;
    stream.textContent = ai ? 'Waiting for the model…' : '';
    [concept, title, genre, aiBox].forEach((element) => { element.disabled = true; });
    try {
      const { project } = await call('projects:create', { concept: concept.value, title: title.value, genre: genre.value, useAi: ai });
      for (const key of ['new-project:concept', 'new-project:title', 'new-project:genre']) setDraft(key);
      modal.setBusy(false);
      modal.close();
      await actions.refreshProjects();
      await actions.openProject(project.id, { project });
      toast(`Created "${project.state.project.title}".`, { kind: 'success' });
    } catch (error) {
      modal.setBusy(false);
      createButton.disabled = false;
      createButton.textContent = 'Create project';
      cancelButton.hidden = false;
      stopButton.hidden = true;
      stream.hidden = true;
      [concept, title, genre].forEach((element) => { element.disabled = false; });
      aiBox.disabled = !canUseAi;
      if (error.code === 'cancelled') {
        errorBox.textContent = 'Stopped. Nothing was created.';
      } else {
        errorBox.replaceChildren(h('span', null, error.message));
        if (['no-key', 'auth', 'no-connection'].includes(error.code)) {
          errorBox.append(' ', h('button', { class: 'link-button', type: 'button', onclick: () => { modal.close(); actions.navigate({ name: 'settings' }); } }, 'Open Settings'));
        }
      }
      errorBox.hidden = false;
    } finally {
      state.runs.delete('new-project');
    }
  });

  modal.updateStream = (text) => {
    stream.textContent = briefPreview(text) || 'Writing the brief…';
    stream.scrollTop = stream.scrollHeight;
  };
  state.newProjectModal = modal;
}

export async function importProject(button) {
  await withBusy(button, async () => {
    let result = await call('files:import');
    if (result.cancelled) return;
    if (result.needsMigration) {
      const ok = await confirmDialog({
        title: 'Update this state file?',
        message: 'This file was saved by an older version of Author Studio. To open it, these small additions are needed. Your original file is not changed.',
        details: [...result.migrations, ...result.warnings],
        confirmLabel: 'Update and open',
      });
      if (!ok) return;
      result = await call('files:confirmImport', { token: result.token });
    }
    await actions.refreshProjects();
    await actions.openProject(result.project.id, { project: result.project });
    const title = result.project.state.project.title || 'the project';
    if (result.warnings?.length) {
      toast(`Opened ${title}. Some parts were not imported: ${result.warnings.join(' ')}`, { kind: 'info', timeout: 15000 });
    } else {
      toast(result.kind === 'backup' ? `Restored "${title}" as a new project.` : `Imported "${title}".`, { kind: 'success' });
    }
  });
}

export async function deleteProject(project) {
  const title = project.state.project.title || 'this project';
  const ok = await confirmDialog({
    title: `Delete "${title}"?`,
    message: 'The project moves to your computer\'s trash, so you can still recover it from there. Consider making a backup first.',
    confirmLabel: 'Delete project',
    danger: true,
  });
  if (!ok) return false;
  try {
    await call('projects:delete', { id: project.id });
    state.lastResult.delete(project.id);
    await actions.refreshProjects();
    actions.navigate({ name: 'projects' });
    toast(`Deleted "${title}".`);
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}
