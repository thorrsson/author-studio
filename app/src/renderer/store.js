// Shared app state and a few cross-view actions that app.js fills in.
export const state = {
  info: null,
  settings: null,
  projects: [],
  view: { name: 'projects' },
  project: null,
  // projectId (or 'new-project') -> { op, label, text, startedAt, reviewers }
  runs: new Map(),
  // Unsaved form input, keyed by a stable name, so re-renders keep it.
  drafts: new Map(),
  // projectId -> artifactId of the last result to show in the studio.
  lastResult: new Map(),
  // projectId -> { first, last, chapter, written, stopAfter } while YOLO mode writes chapters.
  yolo: new Map(),
};

export const actions = {
  navigate: () => {},
  render: () => {},
  renderSidebar: () => {},
  refreshProjects: async () => {},
  openProject: async () => {},
  setProject: () => {},
  setSettings: () => {},
};

export function draft(key, fallback = '') {
  return state.drafts.has(key) ? state.drafts.get(key) : fallback;
}

export function setDraft(key, value) {
  if (value === undefined || value === '') state.drafts.delete(key);
  else state.drafts.set(key, value);
}

export function activeConnection() {
  const settings = state.settings;
  return settings?.connections.find((item) => item.id === settings.activeConnectionId) ?? null;
}
