// App settings and API keys. Keys never leave the main process; on disk they
// are encrypted with the operating system's credential store through
// Electron's safeStorage.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeBaseUrl } from '../providers/openai.js';
import { clampContext, CONNECTION_TYPES, connectionLabel, DEFAULT_COMPATIBLE_CONTEXT } from '../providers/registry.js';
import { AppError, readJsonFile, writeFileAtomic } from './files.js';

const SETTINGS_VERSION = 1;
const SERVERS = ['ollama', 'lmstudio', 'llamacpp', 'generic'];
const THEMES = ['system', 'light', 'dark'];
const MAX_CONNECTIONS = 40;
const MAX_KEY = 1000;

const KEY_STORAGE_MESSAGES = {
  encrypted: 'API keys are encrypted with your system keychain.',
  basic: 'No system keyring was found, so API keys are saved with only basic protection. Install and unlock a keyring (such as GNOME Keyring or KWallet) for stronger protection.',
  memory: 'This computer has no secure place to save API keys, so keys are kept only until you quit Author Studio.',
};

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    connections: [],
    activeConnectionId: null,
    reviewers: { a: null, b: null },
    temperature: null,
    theme: 'system',
  };
}

function line(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

function positiveInt(value, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : null;
}

// Validates a connection coming from the renderer or from disk. A draft (used
// to list models before one is chosen) may leave the model empty.
export function sanitizeConnection(input, { id, draft = false } = {}) {
  const type = input?.type;
  if (!Object.hasOwn(CONNECTION_TYPES, type)) throw new AppError('invalid-input', 'Choose which kind of AI model to connect.');
  const info = CONNECTION_TYPES[type];
  const connection = {
    id: id ?? (typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : randomUUID()),
    type,
    name: line(input.name, 60) || info.short,
    model: type === 'apple' ? 'apple-on-device' : line(input.model, 200),
  };
  if (type !== 'apple' && !connection.model && !draft) throw new AppError('invalid-input', 'Choose a model for this connection.');
  if (type === 'compatible') {
    connection.baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!connection.baseUrl) throw new AppError('invalid-input', 'Enter the server address, for example http://localhost:11434.');
    connection.server = SERVERS.includes(input.server) ? input.server : 'generic';
    connection.contextWindow = clampContext(input.contextWindow, DEFAULT_COMPATIBLE_CONTEXT);
  }
  if (type === 'apple') connection.matureThemes = input.matureThemes !== false;
  const maxOutput = positiveInt(input.maxOutputTokens, 200_000);
  if (maxOutput) connection.maxOutputTokens = Math.max(256, maxOutput);
  return connection;
}

function sanitizeSettings(raw) {
  const settings = defaultSettings();
  if (!raw || typeof raw !== 'object') return settings;
  const seen = new Set();
  for (const item of Array.isArray(raw.connections) ? raw.connections.slice(0, MAX_CONNECTIONS) : []) {
    try {
      const connection = sanitizeConnection(item);
      if (seen.has(connection.id)) continue;
      seen.add(connection.id);
      settings.connections.push(connection);
    } catch {
      // Drop a damaged connection rather than the whole file.
    }
  }
  const known = (value) => (typeof value === 'string' && seen.has(value) ? value : null);
  settings.activeConnectionId = known(raw.activeConnectionId) ?? settings.connections[0]?.id ?? null;
  settings.reviewers = { a: known(raw.reviewers?.a), b: known(raw.reviewers?.b) };
  settings.temperature = sanitizeTemperature(raw.temperature);
  settings.theme = THEMES.includes(raw.theme) ? raw.theme : 'system';
  return settings;
}

function sanitizeTemperature(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2 ? Math.round(number * 100) / 100 : null;
}

function keyStorageMode(safeStorage, forced) {
  if (forced === 'memory' || !safeStorage?.isEncryptionAvailable?.()) return 'memory';
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text' || backend === 'unknown') return 'basic';
  }
  return 'encrypted';
}

function hintFor(key) {
  return key.length > 12 ? `…${key.slice(-4)}` : '';
}

export async function createSettingsStore({ dir, safeStorage, keyStorage } = {}) {
  const settingsFile = path.join(dir, 'settings.json');
  const secretsFile = path.join(dir, 'secrets.json');
  const mode = keyStorageMode(safeStorage, keyStorage);
  let settings;
  let loadProblem = null;
  try {
    settings = sanitizeSettings(await readJsonFile(settingsFile));
  } catch (error) {
    loadProblem = `Your settings file could not be read (${error.message}), so default settings are in use.`;
    settings = defaultSettings();
  }
  const memoryKeys = new Map();
  let stored = {};
  if (mode !== 'memory') {
    try {
      const raw = await readJsonFile(secretsFile);
      if (raw && typeof raw.keys === 'object' && raw.keys) stored = raw.keys;
    } catch {
      stored = {};
    }
  }

  const saveSettings = () => writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  const saveSecrets = () => writeFileAtomic(secretsFile, `${JSON.stringify({ version: 1, keys: stored }, null, 2)}\n`);

  function getKey(id) {
    if (memoryKeys.has(id)) return memoryKeys.get(id);
    const entry = stored[id];
    if (!entry?.data || mode === 'memory') return '';
    try {
      const key = safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
      memoryKeys.set(id, key);
      return key;
    } catch {
      return '';
    }
  }

  async function setKey(id, key) {
    const value = String(key ?? '').trim();
    if (value.length > MAX_KEY || /\s/.test(value)) throw new AppError('invalid-input', 'That API key does not look right. Copy it again from the provider\'s website.');
    if (!value) {
      memoryKeys.delete(id);
      if (stored[id]) {
        delete stored[id];
        await saveSecrets();
      }
      return;
    }
    memoryKeys.set(id, value);
    if (mode !== 'memory') {
      stored[id] = { data: safeStorage.encryptString(value).toString('base64'), hint: hintFor(value) };
      await saveSecrets();
    }
  }

  function connection(id) {
    return settings.connections.find((item) => item.id === id) ?? null;
  }

  return {
    keyStorage: () => ({ mode, message: KEY_STORAGE_MESSAGES[mode] }),
    loadProblem: () => loadProblem,
    get: () => structuredClone(settings),
    connection: (id) => structuredClone(connection(id)),
    activeConnection: () => structuredClone(connection(settings.activeConnectionId)),
    getKey,

    // What the renderer may see: never the keys themselves.
    view() {
      return {
        ...structuredClone(settings),
        connections: settings.connections.map((item) => {
          const hasKey = Boolean(memoryKeys.get(item.id) || (mode !== 'memory' && stored[item.id]?.data));
          return {
            ...structuredClone(item),
            label: connectionLabel(item),
            hasKey,
            keyHint: hasKey ? stored[item.id]?.hint || hintFor(memoryKeys.get(item.id) ?? '') : '',
          };
        }),
        keyStorage: { mode, message: KEY_STORAGE_MESSAGES[mode] },
      };
    },

    // apiKey: undefined keeps the saved key, '' removes it.
    async saveConnection(input, apiKey) {
      const existing = typeof input?.id === 'string' ? connection(input.id) : null;
      if (!existing && settings.connections.length >= MAX_CONNECTIONS) {
        throw new AppError('invalid-input', `You can save up to ${MAX_CONNECTIONS} connections. Remove one first.`);
      }
      const saved = sanitizeConnection(input, existing ? { id: existing.id } : {});
      if (apiKey !== undefined) {
        if (!CONNECTION_TYPES[saved.type].needsKey && saved.type !== 'compatible' && apiKey) {
          throw new AppError('invalid-input', 'This kind of connection does not use an API key.');
        }
        await setKey(saved.id, apiKey);
      }
      if (existing) settings.connections[settings.connections.indexOf(existing)] = saved;
      else settings.connections.push(saved);
      if (!settings.activeConnectionId) settings.activeConnectionId = saved.id;
      await saveSettings();
      return structuredClone(saved);
    },

    async deleteConnection(id) {
      const existing = connection(id);
      if (!existing) return;
      settings.connections = settings.connections.filter((item) => item.id !== id);
      if (settings.activeConnectionId === id) settings.activeConnectionId = settings.connections[0]?.id ?? null;
      if (settings.reviewers.a === id) settings.reviewers.a = null;
      if (settings.reviewers.b === id) settings.reviewers.b = null;
      await setKey(id, '');
      await saveSettings();
    },

    async update(patch = {}) {
      const known = (value) => value === null || (typeof value === 'string' && connection(value));
      if ('activeConnectionId' in patch) {
        if (!known(patch.activeConnectionId)) throw new AppError('invalid-input', 'That connection no longer exists.');
        settings.activeConnectionId = patch.activeConnectionId;
      }
      if ('reviewers' in patch) {
        const a = patch.reviewers?.a ?? null;
        const b = patch.reviewers?.b ?? null;
        if (!known(a) || !known(b)) throw new AppError('invalid-input', 'That connection no longer exists.');
        settings.reviewers = { a, b };
      }
      if ('temperature' in patch) settings.temperature = sanitizeTemperature(patch.temperature);
      if ('theme' in patch && THEMES.includes(patch.theme)) settings.theme = patch.theme;
      await saveSettings();
      return structuredClone(settings);
    },
  };
}
