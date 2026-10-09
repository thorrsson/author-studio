import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createAnthropicProvider, defaultAnthropicModel } from '../src/providers/anthropic.js';
import { createAppleProvider } from '../src/providers/apple.js';
import { errorFromNetwork, ProviderError } from '../src/providers/errors.js';
import { createOpenAIProvider, defaultOpenAIModel, detectContextWindow, inspectCompatibleServer, isOpenAIChatModel, normalizeBaseUrl } from '../src/providers/openai.js';
import { connectionLabel, createProvider, profileFor } from '../src/providers/registry.js';
import { anthropicEvents, json, openaiEvents, pause, sse, startServer } from './mock-server.mjs';

const request = (extra = {}) => ({ system: 'SYSTEM', prompt: 'PROMPT', maxTokens: 500, ...extra });

async function collect(provider, extra) {
  const deltas = [];
  const result = await provider.generate(request({ onDelta: (delta) => deltas.push(delta), ...extra }));
  return { result, deltas };
}

test('Anthropic streams text through split and CRLF event boundaries', async (t) => {
  const server = await startServer({
    'POST /v1/messages': (req, res) => sse(res, anthropicEvents(['Once ', 'upon ', 'a time.']), { split: 7, newline: '\r\n' }),
  });
  t.after(server.close);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-test', baseUrl: server.url, fetch });
  const { result, deltas } = await collect(provider, { temperature: 0.7 });
  assert.equal(result.text, 'Once upon a time.');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(deltas, ['Once ', 'upon ', 'a time.']);
  const [sent] = server.requests;
  assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(sent.body, { model: 'claude-test', max_tokens: 500, system: 'SYSTEM', messages: [{ role: 'user', content: 'PROMPT' }], stream: true, temperature: 0.7 });
});

test('Anthropic reports truncation, refusals, and stream errors', async (t) => {
  let mode = 'length';
  const server = await startServer({
    'POST /v1/messages': (req, res) => {
      if (mode === 'length') return sse(res, anthropicEvents(['Half'], 'max_tokens'));
      if (mode === 'refusal') return sse(res, anthropicEvents([''], 'refusal'));
      return sse(res, [...anthropicEvents(['Partial']).slice(0, 4), { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
    },
  });
  t.after(server.close);
  const provider = createAnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: server.url, fetch });
  assert.equal((await provider.generate(request())).finishReason, 'length');
  mode = 'refusal';
  await assert.rejects(provider.generate(request()), { code: 'refused' });
  mode = 'error';
  await assert.rejects(provider.generate(request()), { code: 'overloaded' });
});

test('Anthropic retries once with the output limit the API names', async (t) => {
  const server = await startServer({
    'POST /v1/messages': (req, res, entry, all) => {
      if (all.length === 1) {
        return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 8192 > 4096, which is the maximum allowed number of output tokens for claude-old' } });
      }
      return sse(res, anthropicEvents(['ok']));
    },
  });
  t.after(server.close);
  const provider = createAnthropicProvider({ apiKey: 'k', model: 'claude-old', baseUrl: server.url, fetch });
  const result = await provider.generate(request({ maxTokens: 8192 }));
  assert.equal(result.text, 'ok');
  assert.equal(server.requests[1].body.max_tokens, 4096);
});

test('temporary failures are retried; account problems are explained, not retried', async (t) => {
  let status = 529;
  const server = await startServer({
    'POST /v1/messages': (req, res, entry, all) => {
      if (status === 529 && all.length === 1) return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after': '0' });
      if (status === 401) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (status === 400) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
      return sse(res, anthropicEvents(['fine']));
    },
  });
  t.after(server.close);
  const provider = createAnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: server.url, fetch, label: 'Claude' });
  assert.equal((await provider.generate(request())).text, 'fine');
  assert.equal(server.requests.length, 2);
  status = 401;
  await assert.rejects(provider.generate(request()), (error) => {
    assert.equal(error.code, 'auth');
    assert.match(error.message, /Claude did not accept the API key/);
    return true;
  });
  status = 400;
  await assert.rejects(provider.generate(request()), { code: 'quota' });
  assert.equal(server.requests.length, 4);
});

test('Anthropic lists models across pages and prefers Sonnet', async (t) => {
  const server = await startServer({
    'GET /v1/models': (req, res, entry) => {
      if (!entry.search.includes('after_id')) {
        return json(res, 200, { data: [{ id: 'claude-opus-new', display_name: 'Opus', created_at: '2026-03-01' }], has_more: true, last_id: 'claude-opus-new' });
      }
      return json(res, 200, { data: [{ id: 'claude-sonnet-new', display_name: 'Sonnet', created_at: '2026-02-01' }, { id: 'claude-haiku', display_name: 'Haiku', created_at: '2025-01-01' }], has_more: false });
    },
  });
  t.after(server.close);
  const provider = createAnthropicProvider({ apiKey: 'k', model: '', baseUrl: server.url, fetch });
  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), ['claude-opus-new', 'claude-sonnet-new', 'claude-haiku']);
  assert.equal(defaultAnthropicModel(models), 'claude-sonnet-new');
  await assert.rejects(createAnthropicProvider({ apiKey: '', model: 'm', fetch }).generate(request()), { code: 'auth' });
});

test('OpenAI streams chat completions and drops unsupported parameters', async (t) => {
  const server = await startServer({
    'POST /v1/chat/completions': (req, res, entry, all) => {
      if (all.length === 1) {
        return json(res, 400, { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' } });
      }
      return sse(res, openaiEvents(['Hello', ' there.']), { split: 5 });
    },
  });
  t.after(server.close);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', model: 'gpt-test', baseUrl: `${server.url}/v1`, fetch });
  const { result, deltas } = await collect(provider, { temperature: 0.7 });
  assert.equal(result.text, 'Hello there.');
  assert.deepEqual(deltas, ['Hello', ' there.']);
  assert.equal(server.requests[0].headers.authorization, 'Bearer sk-test');
  assert.equal(server.requests[0].body.max_completion_tokens, 500);
  assert.equal('temperature' in server.requests[1].body, false);
  assert.deepEqual(server.requests[1].body.messages, [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'PROMPT' }]);
});

test('OpenAI quota errors are explained and not retried', async (t) => {
  const server = await startServer({
    'POST /v1/chat/completions': (req, res) => json(res, 429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }),
  });
  t.after(server.close);
  const provider = createOpenAIProvider({ apiKey: 'k', model: 'gpt', baseUrl: `${server.url}/v1`, fetch, label: 'GPT' });
  await assert.rejects(provider.generate(request()), (error) => {
    assert.equal(error.code, 'quota');
    assert.match(error.message, /out of credit/);
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test('OpenAI model lists keep chat models and prefer the newest flagship', () => {
  assert.equal(isOpenAIChatModel('gpt-6-astra'), true);
  assert.equal(isOpenAIChatModel('o4-mini'), true);
  for (const id of ['gpt-4o-realtime-preview', 'text-embedding-3-large', 'gpt-image-1', 'dall-e-3', 'gpt-5-codex', 'o3-pro', 'whisper-1', 'gpt-4o-transcribe']) {
    assert.equal(isOpenAIChatModel(id), false, id);
  }
  assert.equal(defaultOpenAIModel([{ id: 'gpt-old', created: 1 }, { id: 'gpt-new-mini', created: 3 }, { id: 'gpt-new', created: 2 }]), 'gpt-new');
});

test('compatible servers: non-streaming replies, max_tokens, and context errors', async (t) => {
  let mode = 'json';
  const server = await startServer({
    'POST /v1/chat/completions': (req, res, entry) => {
      if (mode === 'json') return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'Whole reply.' }, finish_reason: 'length' }] });
      if (entry.body.max_tokens > 1080) {
        return json(res, 400, { object: 'error', message: "This model's maximum context length is 4096 tokens. However, you requested 5096 tokens (3000 in the messages, 2096 in the completion). Please reduce the length of the messages or completion.", type: 'BadRequestError', code: 400 });
      }
      return sse(res, openaiEvents(['Short.']));
    },
  });
  t.after(server.close);
  const provider = createOpenAIProvider({ model: 'local', baseUrl: `${server.url}/v1`, fetch, compatible: true, label: 'My server' });
  const { result, deltas } = await collect(provider);
  assert.deepEqual(result, { text: 'Whole reply.', finishReason: 'length' });
  assert.deepEqual(deltas, ['Whole reply.']);
  assert.equal(server.requests[0].body.max_tokens, 500);
  assert.equal(server.requests[0].headers.authorization, undefined);
  mode = 'stream';
  const second = await provider.generate(request({ maxTokens: 2096 }));
  assert.equal(second.text, 'Short.');
  assert.equal(server.requests.at(-1).body.max_tokens, 1080);
});

test('compatible server discovery normalizes addresses and reads context windows', async (t) => {
  const server = await startServer({
    'GET /v1/models': (req, res) => json(res, 200, { object: 'list', data: [{ id: 'qwen3-8b' }, { id: 'nomic-embed-text' }] }),
    'GET /props': (req, res) => json(res, 200, { default_generation_settings: { n_ctx: 12288 } }),
  });
  t.after(server.close);
  const result = await inspectCompatibleServer({ baseUrl: `127.0.0.1:${server.port}/v1/chat/completions`, fetch });
  assert.equal(result.baseUrl, `${server.url}/v1`);
  assert.equal(result.server, 'llamacpp');
  assert.deepEqual(result.models.map((model) => [model.id, model.contextWindow]), [['qwen3-8b', 12288]]);
  const plain = await inspectCompatibleServer({ baseUrl: server.url, fetch });
  assert.equal(plain.baseUrl, `${server.url}/v1`);
  assert.equal(normalizeBaseUrl('localhost:11434'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('https://example.com/openai/v1/'), 'https://example.com/openai/v1');
  assert.equal(normalizeBaseUrl('ftp://example.com'), '');
  assert.equal(normalizeBaseUrl(''), '');
});

test('detects the window a running server reports for the selected model', async (t) => {
  const advertised = await startServer({
    'GET /v1/models': (req, res) => json(res, 200, { data: [{ id: 'other', max_model_len: 4096 }, { id: 'nemo', max_model_len: 32768 }] }),
  });
  t.after(advertised.close);
  assert.equal(await detectContextWindow({ baseUrl: advertised.url, model: 'nemo', server: 'generic', fetch }), 32768);
  assert.equal(await detectContextWindow({ baseUrl: advertised.url, model: 'missing', server: 'generic', fetch }), undefined);

  const loaded = await startServer({
    'GET /v1/models': (req, res) => json(res, 200, { data: [{ id: 'qwen', max_model_len: 131072 }] }),
    'GET /props': (req, res) => json(res, 200, { default_generation_settings: { n_ctx: 12288 } }),
  });
  t.after(loaded.close);
  assert.equal(await detectContextWindow({ baseUrl: `${loaded.url}/v1`, model: 'qwen', server: 'llamacpp', fetch }), 12288);

  const ollama = await startServer({
    'GET /v1/models': (req, res) => json(res, 200, { data: [{ id: 'llama3.2' }] }),
    'POST /api/show': (req, res, entry) => json(res, 200, { model_info: { 'llama.context_length': entry.body.model === 'llama3.2' ? 131072 : 0 } }),
  });
  t.after(ollama.close);
  assert.equal(await detectContextWindow({ baseUrl: `${ollama.url}/v1`, model: 'llama3.2', server: 'ollama', fetch }), 131072);
});

test('memory-limited prompt rejections from local servers count as too large', async (t) => {
  const server = await startServer({
    'POST /v1/chat/completions': (req, res) => json(res, 400, { error: { message: 'oMLX prefill memory guard rejected this prompt: Prefill would require ~26.13 GB peak. Close other apps.' } }),
  });
  t.after(server.close);
  const provider = createOpenAIProvider({ baseUrl: `${server.url}/v1`, model: 'nemo', fetch, compatible: true });
  await assert.rejects(provider.generate({ system: 's', prompt: 'p', maxTokens: 100 }), (error) => error.code === 'too-large');
});

test('Ollama is called natively so the context window is honored', async (t) => {
  const server = await startServer({
    'GET /v1/models': (req, res) => json(res, 200, { object: 'list', data: [{ id: 'llama3.2:latest' }] }),
    'GET /api/version': (req, res) => json(res, 200, { version: '0.12.0' }),
    'POST /api/chat': async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Bread ' }, done: false })}\n{"message":{"role":"assistant","con`);
      await pause(10);
      res.write(`tent":"rises."},"done":false}\n${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' })}\n`);
      res.end();
    },
  });
  t.after(server.close);
  const found = await inspectCompatibleServer({ baseUrl: `localhost:${server.port}`, fetch });
  assert.equal(found.server, 'ollama');
  const provider = createProvider({ type: 'compatible', name: 'Ollama', model: 'llama3.2:latest', baseUrl: found.baseUrl, server: found.server, contextWindow: 16384 }, { fetch });
  const { result, deltas } = await collect(provider, { temperature: 0.8 });
  assert.deepEqual(result, { text: 'Bread rises.', finishReason: 'length' });
  assert.deepEqual(deltas, ['Bread ', 'rises.']);
  const sent = server.requests.find((entry) => entry.path === '/api/chat').body;
  assert.deepEqual(sent.options, { num_predict: 500, num_ctx: 16384, temperature: 0.8 });
  assert.equal(sent.stream, true);
});

test('stopping and stalled streams end cleanly', async (t) => {
  const server = await startServer({
    'POST /v1/chat/completions': async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'First.' } }] })}\n\n`);
      await pause(2000);
      res.end();
    },
  });
  t.after(server.close);
  const controller = new AbortController();
  const provider = createOpenAIProvider({ model: 'm', baseUrl: `${server.url}/v1`, fetch, compatible: true });
  await assert.rejects(
    provider.generate(request({ signal: controller.signal, onDelta: () => controller.abort() })),
    (error) => error.name === 'AbortError',
  );
  const slow = createOpenAIProvider({ model: 'm', baseUrl: `${server.url}/v1`, fetch, compatible: true, label: 'Slow server', timeouts: { idleMs: 150 } });
  await assert.rejects(slow.generate(request()), (error) => {
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /Slow server stopped responding/);
    return true;
  });
});

test('network failures become plain-language errors', async () => {
  const closed = await startServer({});
  const { url } = closed;
  await closed.close();
  const provider = createOpenAIProvider({ model: 'm', baseUrl: `${url}/v1`, fetch, compatible: true });
  await assert.rejects(provider.generate(request()), (error) => {
    assert.equal(error.code, 'network');
    assert.match(error.message, /Could not connect to 127\.0\.0\.1:\d+\. Make sure the server is running/);
    return true;
  });
  const chromium = errorFromNetwork(new Error('net::ERR_NAME_NOT_RESOLVED'), { provider: 'X', baseUrl: 'http://nas.local:1234/v1' });
  assert.match(chromium.message, /Could not find nas\.local:1234/);
  const lan = errorFromNetwork(new Error('net::ERR_ADDRESS_UNREACHABLE'), { provider: 'X', baseUrl: 'http://192.168.1.5:1234/v1' });
  assert.match(lan.message, /Local Network/);
  assert.ok(errorFromNetwork(new ProviderError('auth', 'x'), {}) instanceof ProviderError);
});

function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = '';
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      stdout.end();
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        input += chunk;
        callback();
      },
      final(callback) {
        calls.push({ command, args, input: input ? JSON.parse(input) : undefined, child });
        callback();
        setImmediate(async () => {
          await script(args, child, (line) => stdout.write(`${JSON.stringify(line)}\n`));
          if (!child.killed) {
            stdout.end();
            setImmediate(() => child.emit('close', 0, null));
          }
        });
      },
    });
    return child;
  };
  return { spawn, calls };
}

test('Apple Intelligence: status, streaming, truncation, and guardrails', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  let mode = 'ok';
  const { spawn, calls } = fakeSpawn(async (args, child, write) => {
    if (args[0] === 'status') return write({ available: mode !== 'off', reason: mode === 'off' ? 'appleIntelligenceNotEnabled' : undefined, contextSize: 4096 });
    if (mode === 'guardrail') return write({ type: 'error', code: 'guardrailViolation', message: 'Unsafe' });
    write({ type: 'delta', text: 'The lamp ' });
    write({ type: 'replace', text: 'The lamp flickered' });
    write({ type: 'delta', text: '.' });
    write({ type: 'done', finishReason: mode === 'length' ? 'length' : 'stop' });
  });
  const provider = createAppleProvider({ helperPath: '/fake/helper', spawn, platformCheck: () => true });
  assert.deepEqual(await provider.status(), { available: true, reason: null, message: 'Apple Intelligence is ready.', contextWindow: 4096, osVersion: undefined });
  const { result, deltas } = await collect(provider, { temperature: 0.5 });
  assert.equal(result.text, 'The lamp flickered.');
  assert.deepEqual(deltas, ['The lamp ', 'flickered', '.']);
  assert.deepEqual(calls[1].input, { instructions: 'SYSTEM', prompt: 'PROMPT', maxResponseTokens: 500, guardrails: 'permissive', temperature: 0.5 });
  assert.deepEqual(calls[1].args, ['generate']);
  mode = 'length';
  assert.equal((await provider.generate(request())).finishReason, 'length');
  mode = 'guardrail';
  await assert.rejects(provider.generate(request()), (error) => error.code === 'guardrail' && /safety filter blocked/.test(error.message));
  const standard = createAppleProvider({ helperPath: '/fake/helper', spawn, platformCheck: () => true, matureThemes: false });
  await assert.rejects(standard.generate(request()), (error) => error.code === 'guardrail' && /Allow mature fiction themes/.test(error.message));
  assert.equal(calls.at(-1).input.guardrails, 'default');
  mode = 'off';
  const off = await provider.status();
  assert.equal(off.available, false);
  assert.match(off.message, /Turn it on in System Settings/);
  const missing = createAppleProvider({ helperPath: '/nonexistent/helper', platformCheck: () => true });
  assert.equal((await missing.status()).reason, 'helperMissing');
  await assert.rejects(missing.generate(request()), (error) => error.code === 'unavailable' && /helper is missing/.test(error.message));
});

test('Apple Intelligence requests can be stopped', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const { spawn, calls } = fakeSpawn(async (args, child, write) => {
    write({ type: 'delta', text: 'Start' });
    await pause(5000);
  });
  const controller = new AbortController();
  const provider = createAppleProvider({ helperPath: '/fake/helper', spawn, platformCheck: () => true });
  await assert.rejects(provider.generate(request({ signal: controller.signal, onDelta: () => controller.abort() })), (error) => error.name === 'AbortError');
  assert.equal(calls[0].child.killed, true);
});

test('connection profiles describe each model family', () => {
  assert.deepEqual(profileFor({ type: 'anthropic' }), { contextWindow: 200000, maxOutputTokens: 8192, compact: false });
  assert.deepEqual(profileFor({ type: 'openai' }), { contextWindow: 128000, maxOutputTokens: 16384, compact: false });
  assert.deepEqual(profileFor({ type: 'apple' }, { appleContext: 4096 }), { contextWindow: 4096, maxOutputTokens: 4096, compact: true });
  assert.deepEqual(profileFor({ type: 'compatible' }), { contextWindow: 8192, maxOutputTokens: 4096, compact: true });
  assert.deepEqual(profileFor({ type: 'compatible', contextWindow: 32768 }), { contextWindow: 32768, maxOutputTokens: 8192, compact: false });
  assert.deepEqual(profileFor({ type: 'compatible', contextWindow: 100 }), { contextWindow: 2048, maxOutputTokens: 1024, compact: true });
  assert.equal(connectionLabel({ type: 'anthropic', name: 'Claude', model: 'claude-x' }), 'Claude (claude-x)');
  assert.equal(connectionLabel({ type: 'apple', name: 'Apple Intelligence', model: 'apple-on-device' }), 'Apple Intelligence');
  assert.throws(() => createProvider({ type: 'other' }), /Unknown connection type/);
});
