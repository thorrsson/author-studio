// App settings and API keys. Keys never leave the main process; on disk they
// are encrypted with the operating system's credential store through
// Electron's safeStorage.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { addressOrigin } from '../core/address.js';
import { normalizeBaseUrl } from '../providers/openai.js';
import { clampContext, CONNECTION_TYPES, connectionLabel, DEFAULT_COMPATIBLE_CONTEXT } from '../providers/registry.js';
import { AppError, readJsonFile, writeFileAtomic } from './files.js';

const SETTINGS_VERSION = 1;
const SERVERS = ['ollama', 'lmstudio', 'llamacpp', 'generic'];
const THEMES = ['system', 'light', 'dark'];
const MAX_CONNECTIONS = 40;
const MAX_KEY = 1000;
const MAX_CONTEXT_LIMITS = 200;
const MIN_LEARNED_CONTEXT = 1024;

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
    contextLimits: {},
  };
}

// Learned context limits belong to one model on one host, never to a whole
// connection type or to every model on a server.
export function contextLimitKey(connection) {
  const type = connection?.type;
  const model = String(connection?.model ?? '').trim();
  if (!type || type === 'apple' || !model) return '';
  const host = type === 'compatible' ? addressOrigin(connection.baseUrl) : addressOrigin(connection.baseUrl || CONNECTION_TYPES[type]?.baseUrl) || type;
  return host ? `${type} ${host} ${model}` : '';
}

function sanitizeContextLimits(raw) {
  const limits = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return limits;
  const entries = Object.entries(raw)
    .filter(([key, value]) => typeof key === 'string' && key.length <= 400 && !['__proto__', 'constructor', 'prototype'].includes(key)
      && positiveInt(value?.tokens, 2_000_000) >= MIN_LEARNED_CONTEXT)
    .sort(([, a], [, b]) => String(b.learnedAt ?? '').localeCompare(String(a.learnedAt ?? '')))
    .slice(0, MAX_CONTEXT_LIMITS);
  for (const [key, value] of entries) {
    limits[key] = { tokens: positiveInt(value.tokens, 2_000_000), learnedAt: line(value.learnedAt, 40) };
  }
  return limits;
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
    id: id ?? (typeof input.id === 'string' && /^[A-Za-z0-9][\w-]{0,63}$/.test(input.id) ? input.id : randomUUID()),
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
  settings.contextLimits = sanitizeContextLimits(raw.contextLimits);
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
      if (existing && saved.type !== existing.type) {
        throw new AppError('invalid-input', 'A saved connection cannot switch to another kind of model. Add a new connection instead.');
      }
      // A saved key belongs to the server it was entered for, so moving the
      // connection to another server drops the key unless it is entered again.
      const moved = existing?.type === 'compatible' && addressOrigin(saved.baseUrl) !== addressOrigin(existing.baseUrl);
      const key = apiKey === undefined && moved ? '' : apiKey;
      if (key !== undefined) {
        if (!CONNECTION_TYPES[saved.type].needsKey && saved.type !== 'compatible' && key) {
          throw new AppError('invalid-input', 'This kind of connection does not use an API key.');
        }
        await setKey(saved.id, key);
      }
      // Changing a server's configured window means the author reconfigured
      // it, so a limit learned for that model and host starts over.
      if (existing?.contextWindow !== saved.contextWindow) delete settings.contextLimits[contextLimitKey(saved)];
      if (existing) settings.connections[settings.connections.indexOf(existing)] = saved;
      else settings.connections.push(saved);
      if (!settings.activeConnectionId) settings.activeConnectionId = saved.id;
      await saveSettings();
      return structuredClone(saved);
    },

    contextLimit(connectionInfo) {
      const key = contextLimitKey(connectionInfo);
      return key && Object.hasOwn(settings.contextLimits, key) ? settings.contextLimits[key].tokens : null;
    },

    // Only ever lowers the saved limit for this model and host.
    async saveContextLimit(connectionInfo, tokens, now = new Date()) {
      const key = contextLimitKey(connectionInfo);
      const value = Math.max(MIN_LEARNED_CONTEXT, Math.floor(Number(tokens)));
      if (!key || !Number.isFinite(value)) return null;
      const current = Object.hasOwn(settings.contextLimits, key) ? settings.contextLimits[key].tokens : Infinity;
      if (value >= current) return current;
      settings.contextLimits[key] = { tokens: value, learnedAt: now.toISOString() };
      settings.contextLimits = sanitizeContextLimits(settings.contextLimits);
      await saveSettings();
      return value;
    },

    async clearContextLimit(connectionInfo) {
      const key = contextLimitKey(connectionInfo);
      if (!key || !Object.hasOwn(settings.contextLimits, key)) return;
      delete settings.contextLimits[key];
      await saveSettings();
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
