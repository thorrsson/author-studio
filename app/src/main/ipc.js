// IPC handlers: the only way the renderer can reach settings, projects, and
// models. Every payload is treated as untrusted. Handlers return an envelope
// ({ok, value} or {ok: false, error}) so error codes survive the bridge.
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addressOrigin } from '../core/address.js';
import {
  addAuthorText,
  approvePending,
  continueAccepted,
  continuePending,
  EngineError,
  forceReview,
  importProjectBackup,
  importSnapshot,
  modifyPending,
  PROJECT_FORMAT,
  rejectPending,
  runStep,
  secondOpinion,
  snapshotOf,
  startProject,
  updateBrief,
} from '../core/engine.js';
import { markdownToText } from '../core/markdown.js';
import { canExport, exportMarkdown, EXPORT_TARGETS } from '../core/exports.js';
import { isPlainObject } from '../core/state.js';
import { ProviderError } from '../providers/errors.js';
import { inspectCompatibleServer } from '../providers/openai.js';
import { CONNECTION_TYPES, connectionLabel, createProvider, defaultModelFor, profileFor } from '../providers/registry.js';
import { createDocx } from './docx.js';
import { AppError } from './files.js';
import { isProjectId } from './project-store.js';
import { sanitizeConnection } from './settings-store.js';

const MODEL_OPS = new Set(['step', 'modify', 'continuePending', 'continueAccepted', 'secondOpinion']);
const OPS = new Set([...MODEL_OPS, 'approve', 'reject', 'forceReview', 'addText', 'updateBrief']);
const NEW_PROJECT = 'new-project';
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_STRING = 1_000_000;
const TEST_TIMEOUT_MS = 120_000;
const APPLE_STATUS_TTL_MS = 60_000;
const EXTERNAL_HOSTS = new Set([
  'console.anthropic.com',
  'platform.openai.com',
  'github.com',
  'ollama.com',
  'lmstudio.ai',
  'support.apple.com',
]);

const str = (value, max = MAX_STRING) => (typeof value === 'string' ? value.slice(0, max) : '');

function requireProjectId(value) {
  if (!isProjectId(value)) throw new AppError('invalid-input', 'That project could not be found.');
  return value;
}

function plain(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function toFailure(error) {
  if (error?.name === 'AbortError') return { code: 'cancelled', message: 'Stopped. Nothing was changed.' };
  if (error instanceof AppError || error instanceof EngineError) {
    return { code: error.code, message: error.message, details: plain(error.details) };
  }
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message, details: plain({ detail: error.detail, status: error.status }) };
  }
  console.error('[author-studio]', error);
  return { code: 'internal', message: `Something went wrong: ${String(error?.message ?? error).slice(0, 500)}` };
}

// Sends at most one update per interval, always delivering the latest value.
export function throttle(fn, ms) {
  let timer = null;
  let last = 0;
  let pending;
  const run = () => {
    timer = null;
    last = Date.now();
    fn(pending);
  };
  const call = (value) => {
    pending = value;
    if (!timer) timer = setTimeout(run, Math.max(0, ms - (Date.now() - last)));
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return call;
}

export function safeFileName(title, fallback = 'Untitled') {
  const name = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 80)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) || !name ? fallback : name;
}

function send(sender, channel, data) {
  if (sender && !sender.isDestroyed?.()) sender.send(channel, data);
}

export function createHandlers({ settings, projects, resources, fetch, appleHelperPath, spawn, dialogs, shell, appInfo, onSettingsChanged }) {
  const busy = new Map();
  const pendingImports = new Map();
  let appleCache = null;

  async function appleStatus({ refresh = false } = {}) {
    if (!refresh && appleCache && Date.now() - appleCache.at < APPLE_STATUS_TTL_MS) return appleCache.status;
    const provider = createProvider({ type: 'apple' }, { appleHelperPath, ...(spawn ? { spawn } : {}) });
    const status = await provider.status();
    appleCache = { at: Date.now(), status };
    return status;
  }

  // A saved key is only used with the connection it was saved for: the same
  // kind of model and, for a server, the same origin. A changed draft must
  // not be able to send it to another host.
  function keyFor(connection, apiKey) {
    if (typeof apiKey === 'string') return apiKey.trim();
    const saved = settings.connection(connection.id);
    if (!saved || saved.type !== connection.type) return '';
    if (saved.type === 'compatible' && addressOrigin(saved.baseUrl) !== addressOrigin(connection.baseUrl)) return '';
    return settings.getKey(saved.id);
  }

  function providerFor(connection, apiKey) {
    if (CONNECTION_TYPES[connection.type].needsKey && !apiKey) {
      throw new AppError('no-key', `Add the API key for ${connectionLabel(connection)} in Settings.`);
    }
    return createProvider(connection, { apiKey, fetch, appleHelperPath, ...(spawn ? { spawn } : {}) });
  }

  async function modelContext(connection, { signal, onDelta } = {}) {
    if (!connection) throw new AppError('no-connection', 'Set up an AI model in Settings first.');
    const provider = providerFor(connection, settings.getKey(connection.id));
    const appleContext = connection.type === 'apple' ? (await appleStatus()).contextWindow : undefined;
    const temperature = settings.get().temperature;
    return {
      generate: (request) => provider.generate(request),
      profile: profileFor(connection, { appleContext }),
      label: connectionLabel(connection),
      resources,
      ...(temperature === null ? {} : { temperature }),
      signal,
      onDelta,
    };
  }

  function claim(key, op) {
    if (busy.has(key)) {
      throw new AppError('busy', key === NEW_PROJECT
        ? 'A new project is still being set up. Wait for it to finish.'
        : 'Author Studio is still working on this project. Wait for it to finish, or press Stop.');
    }
    const entry = { controller: new AbortController(), op, opId: randomUUID(), startedAt: new Date().toISOString() };
    busy.set(key, entry);
    return entry;
  }

  function busyInfo(key) {
    const entry = busy.get(key);
    return entry ? { op: entry.op, opId: entry.opId, startedAt: entry.startedAt } : null;
  }

  async function perform(op, project, args, ctx, emit) {
    switch (op) {
      case 'step':
        return runStep(project, { action: str(args.action, 40), chapter: args.chapter, target: str(args.target, 100) || undefined, notes: str(args.notes) }, ctx);
      case 'approve': {
        const confirmed = args.confirmed === true ? true : Array.isArray(args.confirmed) ? args.confirmed.filter((item) => Number.isInteger(item) || typeof item === 'string').slice(0, 200) : [];
        return approvePending(project, { confirmedContradictions: confirmed }, ctx);
      }
      case 'reject':
        return rejectPending(project, ctx);
      case 'modify':
        return modifyPending(project, { notes: str(args.notes) }, ctx);
      case 'continuePending':
        return continuePending(project, ctx);
      case 'continueAccepted':
        return continueAccepted(project, str(args.artifactId, 100), ctx);
      case 'forceReview':
        return forceReview(project, { artifactId: str(args.artifactId, 100) || undefined }, ctx);
      case 'addText':
        return addAuthorText(project, { type: str(args.type, 20), chapter: args.chapter, content: str(args.content), complete: args.complete !== false }, ctx);
      case 'updateBrief': {
        const fields = {};
        for (const name of ['title', 'genre', 'concept', 'brief']) {
          if (typeof args[name] === 'string') fields[name] = args[name].slice(0, MAX_STRING);
        }
        return updateBrief(project, fields, ctx);
      }
      case 'secondOpinion': {
        const { reviewers: chosen } = settings.get();
        const ids = [chosen.a, chosen.b].filter(Boolean);
        const reviewers = await Promise.all(ids.map((id) => modelContext(settings.connection(id), { signal: ctx.signal })));
        const consolidator = ctx;
        return secondOpinion(
          project,
          { artifactId: str(args.artifactId, 100) || undefined, focus: str(args.focus), allowSingle: args.allowSingle === true },
          { ...ctx, reviewers, consolidator, onStatus: (status) => emit({ type: 'review-status', ...status }) },
        );
      }
      default:
        throw new AppError('invalid-input', 'Unknown action.');
    }
  }

  async function writeExport(event, { title, defaultName, filters }, data) {
    const result = await dialogs.save(event, { title, defaultPath: defaultName, filters });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await writeFile(result.filePath, data);
    return { path: result.filePath, name: path.basename(result.filePath) };
  }

  async function exportDocument({ projectId, target, format }, event, { allowEmpty = false } = {}) {
    if (!Object.hasOwn(EXPORT_TARGETS, target) || !['docx', 'md', 'txt'].includes(format)) {
      throw new AppError('invalid-input', 'Choose an export option and Word, Markdown, or plain text.');
    }
    const { project } = await projects.load(requireProjectId(projectId));
    if (!allowEmpty && !canExport(project, target)) throw new AppError('empty-export', 'There is no accepted content to export for this option.');
    const label = EXPORT_TARGETS[target].label;
    const name = safeFileName(project.state.project.title);
    const defaultName = `${name}${target === 'manuscript' ? '' : ` - ${label}`}.${format}`;
    const markdown = exportMarkdown(project, target);
    const formats = {
      txt: { name: 'Plain text', title: 'as plain text' },
      md: { name: 'Markdown', title: 'as Markdown' },
      docx: { name: 'Word document', title: 'for Word' },
    };
    const data = format === 'docx'
      ? createDocx(markdown, { title: project.state.project.title, paper: appInfo.paper })
      : format === 'txt' ? markdownToText(markdown, { includeLinks: target !== 'manuscript' }) : markdown;
    return writeExport(event, {
      title: `Export ${label.toLowerCase()} ${formats[format].title}`,
      defaultName,
      filters: [{ name: formats[format].name, extensions: [format] }],
    }, data);
  }

  async function importData(data, consent) {
    if (data?.format === PROJECT_FORMAT) {
      const project = importProjectBackup(data);
      await projects.save(project);
      return { kind: 'backup', project, warnings: [], migrations: [] };
    }
    try {
      const { project, warnings, migrations } = importSnapshot(data, resources.template, { consentToMigrations: consent });
      await projects.save(project);
      return { kind: 'snapshot', project, warnings, migrations };
    } catch (error) {
      if (error instanceof EngineError && error.code === 'needs-migration' && !consent) {
        const token = randomUUID();
        for (const [key, value] of pendingImports) if (value.expires < Date.now()) pendingImports.delete(key);
        pendingImports.set(token, { data, expires: Date.now() + 15 * 60_000 });
        return { needsMigration: true, token, migrations: error.details.migrations, warnings: error.details.warnings };
      }
      throw error;
    }
  }

  const channels = {
    'app:info': async () => ({ ...appInfo, keyStorage: settings.keyStorage(), settingsProblem: settings.loadProblem() }),

    'settings:get': async () => ({ ...settings.view(), connectionTypes: CONNECTION_TYPES }),

    'settings:saveConnection': async ({ connection, apiKey }) => {
      if (!isPlainObject(connection)) throw new AppError('invalid-input', 'Choose which kind of AI model to connect.');
      const saved = await settings.saveConnection(connection, typeof apiKey === 'string' ? apiKey : undefined);
      return { saved, settings: { ...settings.view(), connectionTypes: CONNECTION_TYPES } };
    },

    'settings:deleteConnection': async ({ id }) => {
      await settings.deleteConnection(str(id, 100));
      return { ...settings.view(), connectionTypes: CONNECTION_TYPES };
    },

    'settings:update': async (patch) => {
      const allowed = {};
      for (const name of ['activeConnectionId', 'reviewers', 'temperature', 'theme']) if (name in patch) allowed[name] = patch[name];
      await settings.update(allowed);
      onSettingsChanged?.(settings.get());
      return { ...settings.view(), connectionTypes: CONNECTION_TYPES };
    },

    'providers:listModels': async ({ connection: draft, apiKey }) => {
      const connection = sanitizeConnection(draft, { draft: true });
      const key = keyFor(connection, apiKey);
      if (connection.type === 'apple') {
        const status = await appleStatus({ refresh: true });
        return { models: [{ id: 'apple-on-device', name: 'On-device model', contextWindow: status.contextWindow }], defaultModel: 'apple-on-device', status };
      }
      if (connection.type === 'compatible') {
        const info = await inspectCompatibleServer({ baseUrl: connection.baseUrl, apiKey: key, fetch });
        return { ...info, defaultModel: info.models[0]?.id ?? '' };
      }
      const provider = providerFor({ ...connection, model: connection.model || 'default' }, key);
      const models = await provider.listModels();
      if (connection.type === 'openai') models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
      return { models, defaultModel: defaultModelFor(connection.type, models) };
    },

    'providers:test': async ({ connection: draft, apiKey }) => {
      const connection = sanitizeConnection(draft);
      const provider = providerFor(connection, keyFor(connection, apiKey));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
      const started = Date.now();
      try {
        const result = await provider.generate({
          system: 'You are checking that a writing app can reach you.',
          prompt: 'Reply with one word: Ready',
          maxTokens: connection.type === 'apple' ? 16 : 400,
          signal: controller.signal,
        });
        return { ms: Date.now() - started, reply: String(result.text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim().slice(0, 200) };
      } catch (error) {
        if (error?.name === 'AbortError') throw new AppError('timeout', 'The model did not answer within two minutes. A local model may still be loading; try again shortly.');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    'providers:appleStatus': async ({ refresh }) => appleStatus({ refresh: refresh === true }),

    'projects:list': async () => projects.list(),

    'projects:get': async ({ id }) => {
      const projectId = requireProjectId(id);
      const loaded = await projects.load(projectId);
      return { ...loaded, busy: busyInfo(projectId) };
    },

    'projects:create': async ({ concept, title, genre, useAi }, event) => {
      const entry = claim(NEW_PROJECT, 'create');
      const emit = (data) => send(event?.sender, 'engine:event', { projectId: NEW_PROJECT, opId: entry.opId, op: 'create', ...data });
      const onDelta = throttle((text) => emit({ type: 'delta', text }), 60);
      try {
        emit({ type: 'started' });
        const ctx = useAi === false ? {} : await modelContext(settings.activeConnection(), { signal: entry.controller.signal, onDelta });
        const project = await startProject({ concept: str(concept), title: str(title, 1000), genre: str(genre, 1000), skipAi: useAi === false }, resources.template, ctx);
        await projects.save(project);
        return { project };
      } finally {
        onDelta.cancel();
        busy.delete(NEW_PROJECT);
        emit({ type: 'finished' });
      }
    },

    'projects:delete': async ({ id }) => {
      const projectId = requireProjectId(id);
      if (busy.has(projectId)) throw new AppError('busy', 'Stop the running step before deleting this project.');
      await projects.remove(projectId);
      return { deleted: true };
    },

    'engine:run': async ({ projectId: rawId, op, args }, event) => {
      const projectId = requireProjectId(rawId);
      if (!OPS.has(op)) throw new AppError('invalid-input', 'Unknown action.');
      const entry = claim(projectId, op);
      const emit = (data) => send(event?.sender, 'engine:event', { projectId, opId: entry.opId, op, ...data });
      const onDelta = throttle((text) => emit({ type: 'delta', text }), 60);
      try {
        const { project } = await projects.load(projectId);
        emit({ type: 'started' });
        const ctx = MODEL_OPS.has(op) ? await modelContext(settings.activeConnection(), { signal: entry.controller.signal, onDelta }) : {};
        const result = await perform(op, project, isPlainObject(args) ? args : {}, ctx, emit);
        if (result.project !== project) await projects.save(result.project);
        return {
          outcome: result.outcome ?? (result.review ? 'reviewed' : 'done'),
          artifactId: result.artifactId ?? result.review?.artifactId,
          reasons: result.reasons ?? [],
          review: result.review,
          project: result.project,
        };
      } finally {
        onDelta.cancel();
        busy.delete(projectId);
        emit({ type: 'finished' });
      }
    },

    'engine:cancel': async ({ projectId }) => {
      const key = projectId === NEW_PROJECT ? NEW_PROJECT : requireProjectId(projectId);
      const entry = busy.get(key);
      entry?.controller.abort();
      return { cancelled: Boolean(entry) };
    },

    'files:exportManuscript': ({ projectId, format = 'md' }, event) => exportDocument({ projectId, target: 'manuscript', format }, event, { allowEmpty: true }),
    'files:exportDocument': (payload, event) => exportDocument(payload, event),

    'files:exportSnapshot': async ({ projectId }, event) => {
      const { project } = await projects.load(requireProjectId(projectId));
      const name = safeFileName(project.state.project.title);
      return writeExport(event, { title: 'Export story state for the Author Studio plugin', defaultName: `${name} state.json`, filters: [{ name: 'JSON', extensions: ['json'] }] }, `${JSON.stringify(snapshotOf(project), null, 2)}\n`);
    },

    'files:exportBackup': async ({ projectId }, event) => {
      const { project } = await projects.load(requireProjectId(projectId));
      const name = safeFileName(project.state.project.title);
      return writeExport(event, { title: 'Back up project', defaultName: `${name}.authorstudio.json`, filters: [{ name: 'Author Studio project', extensions: ['json'] }] }, `${JSON.stringify(project, null, 1)}\n`);
    },

    'files:import': async (_payload, event) => {
      const result = await dialogs.open(event, {
        title: 'Open a project backup or a plugin state file',
        filters: [{ name: 'Author Studio files', extensions: ['json'] }],
        properties: ['openFile'],
      });
      const file = result.filePaths?.[0];
      if (result.canceled || !file) return { cancelled: true };
      const info = await stat(file);
      if (info.size > MAX_IMPORT_BYTES) throw new AppError('invalid-file', 'This file is too large to be an Author Studio project.');
      let data;
      try {
        data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      } catch {
        throw new AppError('invalid-file', 'This file is not an Author Studio project backup or state file.');
      }
      return importData(data, false);
    },

    'files:confirmImport': async ({ token }) => {
      const pending = pendingImports.get(str(token, 100));
      pendingImports.delete(str(token, 100));
      if (!pending || pending.expires < Date.now()) throw new AppError('expired', 'That import has expired. Choose the file again.');
      return importData(pending.data, true);
    },

    'app:openDataFolder': async () => {
      const error = await shell.openPath(projects.dir);
      if (error) throw new AppError('failed', error);
      return { opened: true };
    },

    'app:openExternal': async ({ url }) => {
      let parsed;
      try {
        parsed = new URL(str(url, 2000));
      } catch {
        throw new AppError('invalid-input', 'That link is not valid.');
      }
      if (parsed.protocol !== 'https:' || !EXTERNAL_HOSTS.has(parsed.hostname)) throw new AppError('invalid-input', 'Author Studio opens only its own help links.');
      await shell.openExternal(parsed.toString());
      return { opened: true };
    },
  };

  return {
    channels,
    busyCount: () => busy.size,
    cancelAll: () => {
      for (const entry of busy.values()) entry.controller.abort();
    },
  };
}

export function registerHandlers(ipcMain, { channels }, { isTrusted }) {
  for (const [channel, handler] of Object.entries(channels)) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrusted(event)) return { ok: false, error: { code: 'forbidden', message: 'This request was blocked.' } };
      try {
        return { ok: true, value: await handler(isPlainObject(payload) ? payload : {}, event) };
      } catch (error) {
        return { ok: false, error: toFailure(error) };
      }
    });
  }
}
