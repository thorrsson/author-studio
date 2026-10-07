// Electron main process: window, app:// protocol, menus, and security policy.
// Model calls, keys, and files stay here; the renderer reaches them only
// through the IPC handlers in ipc.js.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadResources } from '../core/resources.js';
import { paperForCountry } from './docx.js';
import { createHandlers, registerHandlers } from './ipc.js';
import { appleHelperPath, resourcesRoot, SRC_ROOT } from './paths.js';
import { createProjectStore } from './project-store.js';
import { createSettingsStore } from './settings-store.js';

const ORIGIN = 'app://author-studio';
const START_URL = `${ORIGIN}/renderer/index.html`;
const HOMEPAGE = 'https://github.com/thorrsson/author-studio';
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
// Pure modules the renderer shares with the engine (no Node.js APIs).
const SHARED_MODULES = new Set(['core/address.js', 'core/labels.js', 'core/markdown.js', 'core/patch.js', 'core/state.js']);
const devTools = !app.isPackaged || process.env.AUTHOR_STUDIO_DEVTOOLS === '1';

if (process.env.AUTHOR_STUDIO_USER_DATA) app.setPath('userData', path.resolve(process.env.AUTHOR_STUDIO_USER_DATA));
app.setName('Author Studio');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

let mainWindow = null;
let handlers = null;
let quitting = false;

function sendCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.webContents.send('menu:command', command);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== 'author-studio') return notFound();
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.normalize(path.join(SRC_ROOT, relative));
    const rendererDir = path.join(SRC_ROOT, 'renderer') + path.sep;
    const shared = SHARED_MODULES.has(relative) && resolved === path.join(SRC_ROOT, relative);
    if (!shared && !resolved.startsWith(rendererDir)) return notFound();
    try {
      const data = await readFile(resolved);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return notFound();
    }
  });
}

function lockDownSessions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => {
      if (!target.startsWith(`${ORIGIN}/`)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function isTrusted(event) {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(`${ORIGIN}/`) && mainWindow && event.sender === mainWindow.webContents;
}

function showContextMenu(contents, params) {
  const items = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
    items.push(
      { label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: 'separator' },
    );
  }
  const flags = params.editFlags;
  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
    );
  }
  if (params.isEditable || params.selectionText) items.push({ role: 'copy', enabled: flags.canCopy });
  if (params.isEditable) items.push({ role: 'paste', enabled: flags.canPaste });
  items.push({ role: 'selectAll' });
  if (devTools) items.push({ type: 'separator' }, { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

async function confirmStop(window) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Stop and Close', 'Keep Working'],
    defaultId: 1,
    cancelId: 1,
    message: 'Author Studio is still working on a step.',
    detail: 'If you close now, the step stops and its result is not saved. Your project is otherwise unchanged.',
  });
  return response === 0;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Author Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1b19' : '#f7f4ef',
    webPreferences: {
      preload: path.join(SRC_ROOT, 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('context-menu', (_event, params) => showContextMenu(mainWindow.webContents, params));
  let closeConfirmed = false;
  mainWindow.on('close', async (event) => {
    if (quitting || closeConfirmed || !handlers?.busyCount()) return;
    event.preventDefault();
    const window = mainWindow;
    if (await confirmStop(window)) {
      handlers.cancelAll();
      closeConfirmed = true;
      if (!window.isDestroyed()) window.close();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(START_URL);
}

function buildMenu(dataDir) {
  const isMac = process.platform === 'darwin';
  const settingsItem = { label: isMac ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('settings') };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-project') },
        { label: 'Open Backup or State File…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('import') },
        { type: 'separator' },
        { label: 'Export Manuscript…', accelerator: 'CmdOrCtrl+E', click: () => sendCommand('export') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [settingsItem, { type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(devTools ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Author Studio Help', accelerator: isMac ? 'Cmd+?' : 'F1', click: () => sendCommand('help') },
        { label: 'Show Projects Folder', click: () => shell.openPath(dataDir) },
        { label: 'Author Studio on GitHub', click: () => shell.openExternal(HOMEPAGE) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  registerProtocol();
  lockDownSessions();
  const userData = app.getPath('userData');
  const projectsDir = path.join(userData, 'projects');
  let resources;
  try {
    resources = await loadResources(resourcesRoot());
  } catch (error) {
    dialog.showErrorBox('Author Studio cannot start', `Some of the app's files are missing or damaged. Reinstall Author Studio.\n\n${error.message}`);
    app.exit(1);
    return;
  }
  const settings = await createSettingsStore({ dir: userData, safeStorage, keyStorage: process.env.AUTHOR_STUDIO_KEY_STORAGE });
  const projects = createProjectStore({ dir: projectsDir, trashItem: (file) => shell.trashItem(file) });
  handlers = createHandlers({
    settings,
    projects,
    resources,
    fetch: (url, init) => net.fetch(url, init),
    appleHelperPath: appleHelperPath(),
    dialogs: {
      save: (event, options) => dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        ...options,
        defaultPath: path.join(app.getPath('documents'), options.defaultPath),
      }),
      open: (event, options) => dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), options),
    },
    shell,
    onSettingsChanged: (current) => {
      nativeTheme.themeSource = current.theme;
    },
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      dataPath: userData,
      paper: paperForCountry(app.getLocaleCountryCode()),
    },
  });
  registerHandlers(ipcMain, handlers, { isTrusted });
  nativeTheme.themeSource = settings.get().theme;
  app.setAboutPanelOptions({
    applicationName: 'Author Studio',
    applicationVersion: app.getVersion(),
    copyright: 'MIT License',
    website: HOMEPAGE,
  });
  buildMenu(projectsDir);
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('before-quit', (event) => {
    if (quitting || !handlers?.busyCount() || !mainWindow) return;
    event.preventDefault();
    confirmStop(mainWindow).then((stop) => {
      if (!stop) return;
      handlers.cancelAll();
      quitting = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (handlers && !mainWindow) createWindow();
  });
  // Top-level await would block the "ready" event in an ES module entry point.
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Author Studio cannot start', String(error?.stack ?? error));
    app.exit(1);
  });
}
