// Starts the renderer: loads settings and projects, draws the sidebar and the
// current view, and routes engine events and menu commands.
import { call, onEngineEvent, onMenuCommand } from './api.js';
import { formatElapsed, h, preserveFocus } from './dom.js';
import { actions, state } from './store.js';
import { showError, toast } from './ui.js';
import { renderHelp } from './views/help.js';
import { importProject, openNewProject, renderProjects, renderWelcome } from './views/projects.js';
import { renderSettings } from './views/settings.js';
import { openExportMenu, renderWorkspace, updateRunView } from './views/workspace.js';

const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');

const VIEWS = {
  welcome: renderWelcome,
  projects: renderProjects,
  project: renderWorkspace,
  settings: renderSettings,
  help: renderHelp,
};

let renderedViewKey = null;

const viewKey = (view) => (view.name === 'project' ? `project:${view.id}:${view.tab ?? 'studio'}` : view.name);

function renderFailure(error) {
  console.error(error);
  return h('div', { class: 'page' },
    h('h1', null, 'Something went wrong'),
    h('p', { class: 'error-text' }, error?.message ?? String(error)),
    h('button', { class: 'btn', type: 'button', onclick: () => navigate({ name: 'projects' }) }, 'Back to your projects'));
}

function render() {
  if (!state.info) return;
  const key = viewKey(state.view);
  const sameView = key === renderedViewKey;
  const scroll = sameView ? main.scrollTop : 0;
  preserveFocus(() => {
    let content;
    try {
      content = (VIEWS[state.view.name] ?? renderProjects)();
    } catch (error) {
      content = renderFailure(error);
    }
    main.replaceChildren(content);
    renderSidebar();
  });
  main.scrollTop = scroll;
  if (!sameView) {
    renderedViewKey = key;
    const heading = main.querySelector('h1');
    if (heading && !main.contains(document.activeElement)) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
}

function navItem({ label, current, onclick, extra, title, className }) {
  return h('button', {
    class: ['nav-item', current && 'is-current', className],
    type: 'button',
    'aria-current': current ? 'page' : null,
    title,
    onclick,
  }, h('span', { class: 'nav-label' }, label), extra);
}

function projectIndicator(summary) {
  if (state.runs.has(summary.id)) return h('span', { class: 'spinner small', role: 'img', 'aria-label': 'Working' });
  if (summary.pending) return h('span', { class: 'tab-dot', role: 'img', 'aria-label': 'Waiting for your review' });
  return null;
}

function modelSwitcher() {
  const settings = state.settings;
  if (!settings.connections.length) {
    return h('button', { class: 'btn small block', type: 'button', onclick: () => navigate({ name: 'settings' }) }, 'Connect an AI model');
  }
  return h('label', { class: 'model-switcher' },
    h('span', { class: 'eyebrow' }, 'AI model'),
    h('select', {
      dataset: { key: 'sidebar-model' },
      onchange: async (event) => {
        try {
          setSettings(await call('settings:update', { activeConnectionId: event.currentTarget.value }));
        } catch (error) {
          showError(error);
          render();
        }
      },
    }, settings.connections.map((connection) => h('option', { value: connection.id, selected: connection.id === settings.activeConnectionId }, connection.label))));
}

function renderSidebar() {
  const view = state.view;
  const currentId = view.name === 'project' ? view.id : null;
  const projects = state.projects.filter((summary) => !summary.damaged);
  sidebar.replaceChildren(
    h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: 'icon.svg', alt: '' }), h('span', null, 'Author Studio')),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => openNewProject() }, 'New project'),
    h('div', { class: 'nav-section' },
      navItem({ label: 'All projects', current: view.name === 'projects' || view.name === 'welcome', onclick: () => navigate({ name: 'projects' }) }),
      projects.length ? h('ul', { class: 'nav-projects', 'aria-label': 'Projects' }, projects.map((summary) => h('li', null, navItem({
        label: summary.title,
        title: summary.title,
        current: summary.id === currentId,
        className: 'nav-project',
        onclick: () => openProject(summary.id),
        extra: projectIndicator(summary),
      })))) : null),
    h('div', { class: 'spacer' }),
    h('div', { class: 'nav-section nav-footer' },
      modelSwitcher(),
      navItem({ label: 'Settings', current: view.name === 'settings', onclick: () => navigate({ name: 'settings' }) }),
      navItem({ label: 'Help', current: view.name === 'help', onclick: () => navigate({ name: 'help' }) })),
  );
}

async function navigate(view) {
  if (view.name === 'project' && state.project?.id !== view.id) {
    await openProject(view.id, { tab: view.tab });
    return;
  }
  state.view = view;
  render();
}

async function refreshProjects() {
  try {
    state.projects = await call('projects:list');
  } catch (error) {
    showError(error);
  }
  render();
}

function startOrphanRun(projectId, busy) {
  if (!busy || state.runs.has(projectId)) return;
  state.runs.set(projectId, {
    op: busy.op,
    opId: busy.opId,
    label: 'Finishing an earlier step',
    text: '',
    startedAt: Date.parse(busy.startedAt) || Date.now(),
    reviewers: {},
    orphan: true,
  });
}

// Loads a project and shows it. With quiet, only refreshes the loaded copy.
async function openProject(id, { project, tab, quiet = false } = {}) {
  let loaded = project;
  if (!loaded) {
    try {
      const result = await call('projects:get', { id });
      loaded = result.project;
      startOrphanRun(id, result.busy);
      if (result.recovered && !quiet) toast('This project\'s main file was damaged, so Author Studio opened its automatic backup copy. Saving again repairs it.', { kind: 'info', timeout: 12000 });
    } catch (error) {
      showError(error);
      if (error.code === 'project-missing' || error.code === 'damaged') {
        if (state.project?.id === id) state.project = null;
        if (state.view.name === 'project' && state.view.id === id) state.view = { name: 'projects' };
        await refreshProjects();
      }
      return null;
    }
  }
  if (quiet && state.project?.id !== id) return loaded;
  state.project = loaded;
  if (!quiet) {
    const sameProject = state.view.name === 'project' && state.view.id === id;
    state.view = { name: 'project', id, tab: tab ?? (sameProject ? state.view.tab : 'studio') };
  }
  render();
  return loaded;
}

function setProject(project) {
  if (state.project?.id === project.id) state.project = project;
  render();
  refreshProjects();
}

function setSettings(settings) {
  state.settings = settings;
  if (state.view.name === 'welcome' && settings.connections.length) state.view = { name: 'projects' };
  render();
}

Object.assign(actions, { navigate, render, renderSidebar, refreshProjects, openProject, setProject, setSettings });

function handleEngineEvent(event) {
  const run = state.runs.get(event.projectId);
  if (!run) return;
  switch (event.type) {
    case 'started':
      run.opId = event.opId;
      break;
    case 'delta':
      run.text = event.text ?? '';
      if (event.projectId === 'new-project') state.newProjectModal?.updateStream(run.text);
      else updateRunView(event.projectId);
      break;
    case 'review-status':
      run.reviewers = { ...run.reviewers, [event.reviewer]: event };
      render();
      break;
    case 'finished':
      // Runs started before a reload have no caller waiting on them.
      if (run.orphan && (!run.opId || run.opId === event.opId)) {
        state.runs.delete(event.projectId);
        if (state.project?.id === event.projectId) openProject(event.projectId, { quiet: true });
        refreshProjects();
      }
      break;
    default:
      break;
  }
}

function modalOpen() {
  return document.getElementById('modal-root').childElementCount > 0;
}

function handleMenuCommand(command) {
  if (!state.info || modalOpen()) return;
  switch (command) {
    case 'new-project':
      openNewProject();
      break;
    case 'import':
      importProject();
      break;
    case 'export':
      if (state.view.name === 'project' && state.project) openExportMenu(state.project);
      else toast('Open a project to export its manuscript.');
      break;
    case 'settings':
      navigate({ name: 'settings' });
      break;
    case 'help':
      navigate({ name: 'help' });
      break;
    default:
      break;
  }
}

function tickElapsed() {
  for (const element of document.querySelectorAll('.run-elapsed[data-started]')) {
    element.textContent = formatElapsed(Date.now() - Number(element.dataset.started));
  }
}

async function boot() {
  try {
    const [info, settings, projects] = await Promise.all([call('app:info'), call('settings:get'), call('projects:list')]);
    Object.assign(state, { info, settings, projects });
  } catch (error) {
    main.replaceChildren(h('div', { class: 'page' },
      h('h1', null, 'Author Studio could not start'),
      h('p', { class: 'error-text' }, error?.message ?? String(error)),
      h('p', null, 'Quit and reopen Author Studio. If this keeps happening, restart your computer.')));
    return;
  }
  document.documentElement.dataset.platform = state.info.platform;
  onEngineEvent(handleEngineEvent);
  onMenuCommand(handleMenuCommand);
  setInterval(tickElapsed, 1000);
  state.view = !state.settings.connections.length && !state.projects.length ? { name: 'welcome' } : { name: 'projects' };
  render();
  if (state.info.settingsProblem) toast(state.info.settingsProblem, { kind: 'error', timeout: 0 });
}

boot();
