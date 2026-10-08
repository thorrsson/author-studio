// The renderer's only bridge to the main process. It exposes a fixed set of
// calls; each returns {ok, value} or {ok: false, error} from the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'app:info',
  'app:openDataFolder',
  'app:openExternal',
  'settings:get',
  'settings:saveConnection',
  'settings:deleteConnection',
  'settings:update',
  'providers:listModels',
  'providers:test',
  'providers:appleStatus',
  'projects:list',
  'projects:get',
  'projects:create',
  'projects:delete',
  'engine:run',
  'engine:cancel',
  'files:exportManuscript',
  'files:exportDocument',
  'files:exportSnapshot',
  'files:exportBackup',
  'files:import',
  'files:confirmImport',
];

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('authorStudio', {
  call(channel, payload) {
    if (!CHANNELS.includes(channel)) return Promise.resolve({ ok: false, error: { code: 'invalid-input', message: 'Unknown request.' } });
    return ipcRenderer.invoke(channel, payload ?? {});
  },
  onEngineEvent: (callback) => subscribe('engine:event', callback),
  onMenuCommand: (callback) => subscribe('menu:command', callback),
  platform: process.platform,
});
