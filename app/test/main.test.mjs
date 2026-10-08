import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addressOrigin } from '../src/core/address.js';
import { startProject } from '../src/core/engine.js';
import { readJsonFile, writeFileAtomic } from '../src/main/files.js';
import { createHandlers, registerHandlers, safeFileName, throttle, toFailure } from '../src/main/ipc.js';
import { createProjectStore, isProjectId } from '../src/main/project-store.js';
import { createSettingsStore, sanitizeConnection } from '../src/main/settings-store.js';
import { good, resources, respond, template } from './helpers.mjs';
import { json, openaiEvents, pause, sse, startServer } from './mock-server.mjs';

const KEY = 'sk-test-1234567890abcdef';

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(`enc:${[...value].reverse().join('')}`),
  decryptString: (buffer) => [...buffer.toString().slice(4)].reverse().join(''),
};

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'author-studio-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('atomic writes keep a backup and readJsonFile tolerates a BOM', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.json');
  assert.equal(await readJsonFile(file), undefined);
  await writeFileAtomic(file, '{"v":1}', { backup: true });
  await writeFileAtomic(file, '\uFEFF{"v":2}', { backup: true });
  assert.deepEqual(await readJsonFile(file), { v: 2 });
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), { v: 1 });
});

test('settings keep API keys encrypted and out of settings.json', async (t) => {
  const dir = await tempDir(t);
  const store = await createSettingsStore({ dir, safeStorage: fakeSafeStorage });
  assert.equal(store.keyStorage().mode, 'encrypted');
  const saved = await store.saveConnection({ type: 'anthropic', name: 'Claude', model: 'claude-sonnet-4-5' }, KEY);
  assert.equal(store.get().activeConnectionId, saved.id);
  assert.equal(store.getKey(saved.id), KEY);

  const settingsText = await readFile(path.join(dir, 'settings.json'), 'utf8');
  const secretsText = await readFile(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!settingsText.includes(KEY));
  assert.ok(!secretsText.includes(KEY));

  const view = store.view();
  assert.equal(view.connections[0].hasKey, true);
  assert.equal(view.connections[0].keyHint, '…cdef');
  assert.ok(!JSON.stringify(view).includes(KEY));

  const reopened = await createSettingsStore({ dir, safeStorage: fakeSafeStorage });
  assert.equal(reopened.getKey(saved.id), KEY);

  await reopened.saveConnection({ ...saved, name: 'Renamed' });
  assert.equal(reopened.getKey(saved.id), KEY, 'an omitted key is kept');
  await reopened.saveConnection(saved, '');
  assert.equal(reopened.getKey(saved.id), '', 'an empty key removes it');
  await assert.rejects(reopened.saveConnection(saved, 'has space'), { code: 'invalid-input' });
});

test('memory key storage never writes keys to disk', async (t) => {
  const dir = await tempDir(t);
  const store = await createSettingsStore({ dir, safeStorage: fakeSafeStorage, keyStorage: 'memory' });
  const saved = await store.saveConnection({ type: 'openai', model: 'gpt-5' }, KEY);
  assert.equal(store.keyStorage().mode, 'memory');
  assert.equal(store.getKey(saved.id), KEY);
  assert.equal(await readJsonFile(path.join(dir, 'secrets.json')), undefined);
  const unavailable = await createSettingsStore({ dir, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(unavailable.keyStorage().mode, 'memory');
});

test('deleting a connection clears it from active and reviewer slots', async (t) => {
  const dir = await tempDir(t);
  const store = await createSettingsStore({ dir, safeStorage: fakeSafeStorage });
  const a = await store.saveConnection({ type: 'anthropic', model: 'claude-sonnet-4-5' }, KEY);
  const b = await store.saveConnection({ type: 'compatible', baseUrl: 'localhost:11434', server: 'ollama', model: 'llama3' });
  await store.update({ activeConnectionId: b.id, reviewers: { a: a.id, b: b.id }, temperature: '0.7', theme: 'dark' });
  assert.deepEqual(store.get().reviewers, { a: a.id, b: b.id });
  assert.equal(store.get().temperature, 0.7);
  await assert.rejects(store.update({ activeConnectionId: 'missing' }), { code: 'invalid-input' });
  await store.deleteConnection(b.id);
  const settings = store.get();
  assert.equal(settings.activeConnectionId, a.id);
  assert.deepEqual(settings.reviewers, { a: a.id, b: null });
  assert.equal(settings.theme, 'dark');
});

test('a damaged settings file falls back to defaults and reports it', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'settings.json'), '{not json');
  const store = await createSettingsStore({ dir, safeStorage: fakeSafeStorage });
  assert.match(store.loadProblem(), /could not be read/);
  assert.deepEqual(store.get().connections, []);
});

test('sanitizeConnection validates types, addresses, and models', () => {
  assert.throws(() => sanitizeConnection({ type: 'nope' }), { code: 'invalid-input' });
  assert.throws(() => sanitizeConnection({ type: 'compatible', model: 'x', baseUrl: 'ftp://host' }), { code: 'invalid-input' });
  assert.throws(() => sanitizeConnection({ type: 'openai' }), { code: 'invalid-input' });
  const draft = sanitizeConnection({ type: 'openai' }, { draft: true });
  assert.equal(draft.model, '');
  const local = sanitizeConnection({ type: 'compatible', model: 'm', baseUrl: '192.168.1.20:1234/v1/chat/completions', server: 'evil' });
  assert.equal(local.baseUrl, 'http://192.168.1.20:1234/v1');
  assert.equal(local.server, 'generic');
  const apple = sanitizeConnection({ type: 'apple', model: 'anything' });
  assert.equal(apple.model, 'apple-on-device');
  assert.equal(apple.matureThemes, true);
  assert.equal(sanitizeConnection({ type: 'apple', matureThemes: false }).matureThemes, false);
  assert.notEqual(sanitizeConnection({ type: 'apple', id: '__proto__' }).id, '__proto__');
  assert.equal(addressOrigin('localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(addressOrigin('HTTPS://Example.com:443/v1/'), 'https://example.com');
  assert.equal(addressOrigin('ftp://host'), '');
});

async function sampleProject(title = 'The Baker') {
  return startProject({ concept: 'A baker solves a murder.', title, skipAi: true }, template, {});
}

test('project store saves, lists, recovers from .bak, and removes', async (t) => {
  const dir = await tempDir(t);
  const trashed = [];
  const store = createProjectStore({ dir, trashItem: async (file) => { trashed.push(file); await rm(file); } });
  assert.deepEqual(await store.list(), []);
  const project = await sampleProject();
  assert.ok(isProjectId(project.id));
  await store.save(project);
  const second = { ...project, updatedAt: new Date(Date.now() + 1000).toISOString() };
  await store.save(second);
  const [summary] = await store.list();
  assert.equal(summary.title, 'The Baker');
  assert.equal(summary.id, project.id);

  await writeFile(path.join(dir, `${project.id}.json`), '{"damaged": true}');
  const loaded = await store.load(project.id);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.project.state.project.title, 'The Baker');
  const [recovered] = await store.list();
  assert.equal(recovered.recovered, true);

  await writeFile(path.join(dir, `${project.id}.json.bak`), 'nope');
  await assert.rejects(store.load(project.id), { code: 'damaged' });
  const [damaged] = await store.list();
  assert.equal(damaged.damaged, true);

  await store.remove(project.id);
  assert.equal(trashed.length, 1);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.load(project.id), { code: 'project-missing' });
  await assert.rejects(store.load('../../etc/passwd'), { code: 'invalid-input' });
});

test('project store keeps the project when the trash fails', async (t) => {
  const dir = await tempDir(t);
  const store = createProjectStore({ dir, trashItem: async () => { throw new Error('Trash unavailable'); } });
  const project = await sampleProject();
  await store.save(project);
  await store.save({ ...project });
  await assert.rejects(store.remove(project.id), { code: 'trash-failed' });
  assert.equal((await store.load(project.id)).project.id, project.id);
  await stat(path.join(dir, `${project.id}.json.bak`));

  const gone = createProjectStore({ dir, trashItem: async () => { throw new Error('No such file'); } });
  await rm(path.join(dir, `${project.id}.json`));
  await gone.remove(project.id);
});

test('helpers: safe file names, throttling, and failure envelopes', async () => {
  assert.equal(safeFileName('A/B: "C"?'), 'A B C');
  assert.equal(safeFileName('  ..  '), 'Untitled');
  assert.equal(safeFileName('CON'), 'Untitled');
  const seen = [];
  const send = throttle((value) => seen.push(value), 20);
  send(1);
  send(2);
  send(3);
  await pause(40);
  assert.deepEqual(seen, [3]);
  const abort = new Error('x');
  abort.name = 'AbortError';
  assert.equal(toFailure(abort).code, 'cancelled');
  assert.equal(toFailure(new TypeError('boom')).code, 'internal');
});

// Builds the IPC handlers against a temp folder and a scripted
// OpenAI-compatible server.
async function harness(t, script) {
  const dir = await tempDir(t);
  const server = await startServer({
    'GET /v1/models': (_req, res) => json(res, 200, { object: 'list', data: [{ id: 'local-model', object: 'model' }] }),
    'POST /v1/chat/completions': async (req, res, entry) => script(req, res, entry),
  });
  t.after(() => server.close());
  const settings = await createSettingsStore({ dir, safeStorage: fakeSafeStorage });
  const projects = createProjectStore({ dir: path.join(dir, 'projects') });
  const saves = [];
  const opens = [];
  const handlers = createHandlers({
    settings,
    projects,
    resources,
    fetch: globalThis.fetch,
    appleHelperPath: path.join(dir, 'missing-helper'),
    dialogs: {
      save: async (_event, options) => {
        const filePath = path.join(dir, options.defaultPath);
        saves.push(filePath);
        return { canceled: false, filePath };
      },
      open: async () => ({ canceled: false, filePaths: [opens.shift()] }),
    },
    shell: { openPath: async () => '', openExternal: async () => {} },
    appInfo: { version: '1.0.0', platform: process.platform, paper: 'a4' },
  });
  const events = [];
  const event = { sender: { send: (channel, data) => events.push({ channel, ...data }), isDestroyed: () => false } };
  const call = (channel, payload = {}) => handlers.channels[channel](payload, event);
  return { dir, server, settings, projects, handlers, call, events, saves, opens };
}

test('IPC exports planning documents without a manuscript and validates targets and formats', async (t) => {
  const h = await harness(t, async (_req, res) => json(res, {}));
  const { project } = await h.call('projects:create', { concept: 'Research a coastal village.', title: 'Planning only', useAi: false });
  await h.call('engine:run', { projectId: project.id, op: 'addText', args: { type: 'research', content: '## Findings\n\nA **harbour** and a source: [Archive](https://example.com).' } });
  for (const target of ['bible', 'research', 'brief', 'planning']) {
    for (const format of ['md', 'txt', 'docx']) {
      const result = await h.call('files:exportDocument', { projectId: project.id, target, format });
      assert.equal(path.extname(result.path), `.${format}`);
      if (format === 'docx') assert.equal((await readFile(result.path)).subarray(0, 2).toString(), 'PK');
      else {
        const text = await readFile(result.path, 'utf8');
        assert.match(text, target === 'brief' ? /Research a coastal village/ : /harbour/);
        if (target !== 'brief') assert.ok(text.includes('https://example.com'));
        assert.doesNotMatch(text, /No accepted chapters/);
        if (format === 'txt') assert.doesNotMatch(text, /\*\*harbour\*\*/);
      }
    }
  }
  const saved = h.saves.length;
  for (const target of ['unknown', '__proto__']) {
    await assert.rejects(h.call('files:exportDocument', { projectId: project.id, target, format: 'md' }), { code: 'invalid-input' });
  }
  await assert.rejects(h.call('files:exportDocument', { projectId: project.id, target: 'research', format: 'pdf' }), { code: 'invalid-input' });
  await assert.rejects(h.call('files:exportDocument', { projectId: '../project', target: 'research', format: 'md' }), { code: 'invalid-input' });
  await assert.rejects(h.call('files:exportDocument', { projectId: project.id, target: 'world', format: 'md' }), { code: 'empty-export' });
  assert.equal(h.saves.length, saved, 'invalid or empty exports do not open a save dialog');
});

test('IPC runs steps against a local server, gates low confidence, and exports', async (t) => {
  const replies = [
    good('The village of Kilmore has a bakery and a bell tower.'),
    respond('Chapter text that rings true.', { confidence: 0.5, rationale: 'Unsure about pacing.', flags: ['Pacing'], contradictions: [], complete: true, summary: 'Chapter 1', proposed_changes: {} }),
  ];
  const h = await harness(t, async (_req, res) => sse(res, openaiEvents([replies.shift() ?? 'Ready'])));

  const listed = await h.call('providers:listModels', { connection: { type: 'compatible', baseUrl: h.server.url } });
  assert.equal(listed.baseUrl, `${h.server.url}/v1`);
  assert.equal(listed.defaultModel, 'local-model');

  const { saved, settings } = await h.call('settings:saveConnection', { connection: { type: 'compatible', baseUrl: listed.baseUrl, server: listed.server, model: listed.defaultModel } });
  assert.equal(settings.activeConnectionId, saved.id);
  assert.equal(settings.connectionTypes.compatible.needsKey, false);

  const { project } = await h.call('projects:create', { concept: 'A baker solves a murder in a quiet village.', title: 'Bread and Bones', useAi: false });
  assert.equal((await h.call('projects:list'))[0].title, 'Bread and Bones');

  const world = await h.call('engine:run', { projectId: project.id, op: 'step', args: { action: 'world' } });
  assert.equal(world.outcome, 'accepted');
  const types = h.events.filter((item) => item.projectId === project.id).map((item) => item.type);
  assert.equal(types[0], 'started');
  assert.ok(types.includes('delta'));
  assert.equal(types.at(-1), 'finished');

  const draft = await h.call('engine:run', { projectId: project.id, op: 'step', args: { action: 'draft', chapter: 1 } });
  assert.equal(draft.outcome, 'gated');
  assert.ok(draft.reasons.some((reason) => /confidence/i.test(reason)));
  const approved = await h.call('engine:run', { projectId: project.id, op: 'approve', args: {} });
  assert.equal(approved.project.gate, null);
  const reloaded = await h.call('projects:get', { id: project.id });
  assert.equal(reloaded.busy, null);
  assert.equal(reloaded.project.state.draft_progress.completed_chapters.length, 1);

  const docx = await h.call('files:exportManuscript', { projectId: project.id, format: 'docx' });
  assert.equal(docx.name, 'Bread and Bones.docx');
  assert.equal((await readFile(docx.path)).subarray(0, 2).toString(), 'PK');
  const text = await h.call('files:exportManuscript', { projectId: project.id, format: 'txt' });
  assert.match(await readFile(text.path, 'utf8'), /Chapter text that rings true\./);
  const snapshot = await h.call('files:exportSnapshot', { projectId: project.id });
  assert.equal(JSON.parse(await readFile(snapshot.path, 'utf8')).project.title, 'Bread and Bones');
  const backup = await h.call('files:exportBackup', { projectId: project.id });

  h.opens.push(backup.path);
  const restored = await h.call('files:import');
  assert.equal(restored.kind, 'backup');
  assert.notEqual(restored.project.id, project.id);
  assert.equal((await h.call('projects:list')).length, 2);
});

test('IPC refuses parallel work on one project and can stop a step', async (t) => {
  const h = await harness(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(openaiEvents(['Slow start'])[1].data)}\n\n`);
    await pause(5000);
    res.end();
  });
  await h.call('settings:saveConnection', { connection: { type: 'compatible', baseUrl: `${h.server.url}/v1`, model: 'local-model' } });
  const { project } = await h.call('projects:create', { concept: 'Slow story.', useAi: false });
  const running = h.call('engine:run', { projectId: project.id, op: 'step', args: { action: 'world' } });
  await pause(100);
  assert.equal(h.handlers.busyCount(), 1);
  await assert.rejects(h.call('engine:run', { projectId: project.id, op: 'step', args: { action: 'plot' } }), { code: 'busy' });
  await assert.rejects(h.call('projects:delete', { id: project.id }), { code: 'busy' });
  assert.equal((await h.call('projects:get', { id: project.id })).busy.op, 'step');
  assert.deepEqual(await h.call('engine:cancel', { projectId: project.id }), { cancelled: true });
  await assert.rejects(running, { code: 'cancelled' });
  assert.equal(h.handlers.busyCount(), 0);
  const after = await h.call('projects:get', { id: project.id });
  assert.equal(Object.keys(after.project.artifacts).length, 0);
});

test('IPC asks before migrating an old plugin snapshot', async (t) => {
  const h = await harness(t, async (_req, res) => sse(res, openaiEvents(['Ready'])));
  const legacy = structuredClone(template);
  delete legacy.pending_review;
  legacy.project = { title: 'Starfall', genre: 'sci_fantasy', status: 'drafting' };
  const file = path.join(h.dir, 'legacy.json');
  await writeFile(file, JSON.stringify(legacy));
  h.opens.push(file);
  const first = await h.call('files:import');
  assert.equal(first.needsMigration, true);
  assert.ok(first.migrations.length >= 2);
  assert.deepEqual(await h.call('projects:list'), []);
  const confirmed = await h.call('files:confirmImport', { token: first.token });
  assert.equal(confirmed.kind, 'snapshot');
  assert.equal(confirmed.project.state.project.title, 'Starfall');
  await assert.rejects(h.call('files:confirmImport', { token: first.token }), { code: 'expired' });

  await writeFile(file, 'not json');
  h.opens.push(file);
  await assert.rejects(h.call('files:import'), { code: 'invalid-file' });
});

test('IPC requires keys, connections, and safe links', async (t) => {
  const h = await harness(t, async (_req, res) => sse(res, openaiEvents(['Ready'])));
  await assert.rejects(h.call('projects:create', { concept: 'Needs a model.' }), { code: 'no-connection' });
  await h.call('settings:saveConnection', { connection: { type: 'anthropic', model: 'claude-sonnet-4-5' } });
  await assert.rejects(h.call('projects:create', { concept: 'Needs a key.' }), { code: 'no-key' });
  await assert.rejects(h.call('app:openExternal', { url: 'https://evil.example.com' }), { code: 'invalid-input' });
  await assert.rejects(h.call('app:openExternal', { url: 'http://github.com' }), { code: 'invalid-input' });
  assert.deepEqual(await h.call('app:openExternal', { url: 'https://console.anthropic.com/settings/keys' }), { opened: true });
  await assert.rejects(h.call('projects:get', { id: '../settings' }), { code: 'invalid-input' });
  await assert.rejects(h.call('engine:run', { projectId: '00000000-0000-4000-8000-000000000000', op: 'rm -rf' }), { code: 'invalid-input' });

  const check = await h.call('providers:test', { connection: { type: 'compatible', baseUrl: `${h.server.url}/v1`, model: 'local-model' } });
  assert.equal(check.reply, 'Ready');
});

test('a saved key is only sent with its own connection and server', async (t) => {
  const h = await harness(t, async (_req, res) => sse(res, openaiEvents(['Ready'])));
  const other = await startServer({ 'GET /v1/models': (_req, res) => json(res, 200, { object: 'list', data: [{ id: 'other-model', object: 'model' }] }) });
  t.after(() => other.close());
  const sent = (server, key) => server.requests.some((entry) => String(entry.headers.authorization ?? '').includes(key));

  const { saved: claude } = await h.call('settings:saveConnection', { connection: { type: 'anthropic', model: 'claude-sonnet-4-5' }, apiKey: KEY });
  await h.call('providers:listModels', { connection: { id: claude.id, type: 'compatible', baseUrl: other.url } });
  assert.ok(other.requests.length > 0);
  assert.ok(!sent(other, KEY), 'a Claude key never goes to a server address');
  await assert.rejects(h.call('providers:test', { connection: { id: claude.id, type: 'openai', model: 'gpt-5' } }), { code: 'no-key' });
  await assert.rejects(h.call('settings:saveConnection', { connection: { id: claude.id, type: 'compatible', baseUrl: other.url, model: 'other-model' } }), { code: 'invalid-input' });
  assert.equal(h.settings.connection(claude.id).type, 'anthropic');
  assert.equal(h.settings.getKey(claude.id), KEY);

  const token = 'local-token-123';
  const { saved: local } = await h.call('settings:saveConnection', { connection: { type: 'compatible', baseUrl: `${h.server.url}/v1`, model: 'local-model' }, apiKey: token });
  await h.call('providers:listModels', { connection: { id: local.id, type: 'compatible', baseUrl: h.server.url } });
  assert.ok(sent(h.server, token), 'the same server still gets its key');
  await h.call('providers:listModels', { connection: { id: local.id, type: 'compatible', baseUrl: other.url } });
  assert.ok(!sent(other, token), 'another server does not');

  await h.call('settings:saveConnection', { connection: { ...local, baseUrl: `${h.server.url}/v1/` } });
  assert.equal(h.settings.getKey(local.id), token, 'the same origin keeps the key');
  const { settings } = await h.call('settings:saveConnection', { connection: { ...local, baseUrl: `${other.url}/v1` } });
  assert.equal(h.settings.getKey(local.id), '', 'moving to another server drops the key');
  assert.equal(settings.connections.find((item) => item.id === local.id).hasKey, false);
});

test('registered handlers wrap results in envelopes and reject untrusted senders', async () => {
  const registered = new Map();
  const ipcMain = { handle: (channel, fn) => registered.set(channel, fn) };
  const channels = {
    'ok:channel': async (payload) => ({ echo: payload.value }),
    'fail:channel': async () => { const error = new Error('nope'); error.name = 'AbortError'; throw error; },
  };
  registerHandlers(ipcMain, { channels }, { isTrusted: (event) => event.trusted });
  assert.deepEqual(await registered.get('ok:channel')({ trusted: true }, { value: 1 }), { ok: true, value: { echo: 1 } });
  assert.deepEqual(await registered.get('ok:channel')({ trusted: true }, 'not an object'), { ok: true, value: { echo: undefined } });
  assert.equal((await registered.get('fail:channel')({ trusted: true })).error.code, 'cancelled');
  assert.equal((await registered.get('ok:channel')({ trusted: false }, { value: 1 })).error.code, 'forbidden');
});
