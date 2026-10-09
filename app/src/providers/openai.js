// OpenAI's Chat Completions API, and servers that copy it (Ollama, LM Studio,
// llama.cpp, vLLM, and hosted gateways). Ollama is called through its native
// chat API so the app can set the context window it relies on.
import { errorFromStreamPayload, ProviderError } from './errors.js';
import { getJson, guardStream, joinUrl, readLines, readSSE, send } from './http.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const IDLE_MS = 90_000;
const LOCAL_IDLE_MS = 180_000;
const LOCAL_FIRST_BYTE_MS = 300_000;

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

const tokenKey = (body) => ('max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens');

// Adjusts a rejected request when the error names the problem.
function adjustment(error, body) {
  if (!['bad-request', 'too-large'].includes(error.code)) return null;
  const detail = error.detail ?? '';
  const key = tokenKey(body);
  const { [key]: limit, ...rest } = body;
  if ('temperature' in body && (error.param === 'temperature' || /temperature/i.test(detail))) {
    const { temperature, ...withoutTemperature } = body;
    return withoutTemperature;
  }
  if (key === 'max_tokens' && /max_tokens/.test(detail) && /max_completion_tokens/.test(detail)) {
    return { ...rest, max_completion_tokens: limit };
  }
  if (key === 'max_completion_tokens' && /max_completion_tokens/.test(detail) && /(unsupported|unrecognized|unknown|not supported|extra)/i.test(detail)) {
    return { ...rest, max_tokens: limit };
  }
  const most = /at most (\d+) (?:completion|output) tokens/i.exec(detail);
  if (most && Number(most[1]) < limit) return { ...body, [key]: Number(most[1]) };
  const context = /maximum context length is (\d+) tokens[\s\S]*?\((\d+) in the messages/i.exec(detail);
  if (context) {
    const room = Number(context[1]) - Number(context[2]) - 16;
    if (room >= 256 && room < limit) return { ...body, [key]: room };
  }
  return null;
}

async function readChatStream(response, { watchdog, onDelta, info, idleMs }) {
  let text = '';
  let finishReason = null;
  let done = false;
  const type = response.headers.get('content-type') ?? '';
  if (/json/i.test(type) && !/event-stream/i.test(type)) {
    watchdog.arm(idleMs);
    const payload = await response.json();
    if (payload?.error) throw errorFromStreamPayload(payload, info);
    const choice = payload?.choices?.[0];
    text = contentText(choice?.message?.content);
    if (text) onDelta?.(text);
    return { text, finishReason: choice?.finish_reason ?? 'stop', done: true };
  }
  for await (const record of readSSE(response.body, watchdog, idleMs)) {
    if (record.data.trim() === '[DONE]') {
      done = true;
      break;
    }
    let payload;
    try {
      payload = JSON.parse(record.data);
    } catch {
      continue;
    }
    if (payload?.error) throw errorFromStreamPayload(payload, info);
    const choice = payload?.choices?.[0];
    const delta = contentText(choice?.delta?.content ?? choice?.text);
    if (delta) {
      text += delta;
      onDelta?.(delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  return { text, finishReason, done };
}

async function readOllamaStream(response, { watchdog, onDelta, info, idleMs }) {
  let text = '';
  let finishReason = null;
  let done = false;
  for await (const line of readLines(response.body, watchdog, idleMs)) {
    if (!line.trim()) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (payload?.error) throw errorFromStreamPayload({ error: { message: String(payload.error) } }, info);
    const delta = contentText(payload?.message?.content);
    if (delta) {
      text += delta;
      onDelta?.(delta);
    }
    if (payload?.done) {
      done = true;
      finishReason = payload.done_reason ?? 'stop';
    }
  }
  return { text, finishReason, done };
}

function finish({ text, finishReason, done }, { label }) {
  if (finishReason === 'content_filter') {
    throw new ProviderError('content-filter', `${label}'s content filter stopped this response. Try rephrasing the request in your notes, or use a different model for this step.`);
  }
  if (!done && !finishReason && !text) throw new ProviderError('network', `The connection to ${label} closed before any text arrived. Try again.`);
  return { text, finishReason: finishReason === 'length' || (!done && !finishReason) ? 'length' : 'stop' };
}

export function createOpenAIProvider({ apiKey, model, baseUrl, fetch, label, compatible = false, server = 'generic', contextWindow, timeouts = {} }) {
  const base = String(baseUrl || (compatible ? '' : OPENAI_BASE_URL)).replace(/\/+$/, '');
  const name = label || (compatible ? 'The server' : 'OpenAI');
  const info = { provider: name, model, baseUrl: base };
  const local = compatible;
  const idleMs = timeouts.idleMs ?? (local ? LOCAL_IDLE_MS : IDLE_MS);
  const firstByteMs = timeouts.firstByteMs ?? (local ? LOCAL_FIRST_BYTE_MS : 120_000);

  async function chat(body, { signal, onDelta }) {
    const { response, watchdog } = await send({ fetch, url: joinUrl(base, '/chat/completions'), headers: authHeaders(apiKey), body, signal, info, firstByteMs });
    return guardStream(async () => finish(await readChatStream(response, { watchdog, onDelta, info, idleMs }), { label: name }), { signal, watchdog, info, idleMs });
  }

  async function ollama(body, { signal, onDelta }) {
    const root = base.replace(/\/v1$/, '');
    const { response, watchdog } = await send({ fetch, url: joinUrl(root, '/api/chat'), headers: authHeaders(apiKey), body, signal, info, firstByteMs });
    return guardStream(async () => finish(await readOllamaStream(response, { watchdog, onDelta, info, idleMs }), { label: name }), { signal, watchdog, info, idleMs });
  }

  return {
    type: compatible ? 'compatible' : 'openai',
    label: name,
    model,
    async generate({ system, prompt, maxTokens, temperature, signal, onDelta }) {
      if (!compatible && !apiKey) throw new ProviderError('auth', `Add your OpenAI API key in Settings to use ${name}.`);
      if (!model) throw new ProviderError('model-not-found', `Choose a model for ${name} in Settings.`);
      if (!base) throw new ProviderError('not-found', 'Add the server address in Settings.');
      const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
      if (compatible && server === 'ollama') {
        const options = { num_predict: maxTokens, ...(contextWindow ? { num_ctx: contextWindow } : {}), ...(Number.isFinite(temperature) ? { temperature } : {}) };
        return ollama({ model, messages, stream: true, options }, { signal, onDelta });
      }
      let body = {
        model,
        messages,
        stream: true,
        [compatible ? 'max_tokens' : 'max_completion_tokens']: maxTokens,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
      };
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await chat(body, { signal, onDelta });
        } catch (error) {
          const next = error instanceof ProviderError && attempt < 2 ? adjustment(error, body) : null;
          if (!next) throw error;
          body = next;
        }
      }
    },
    async listModels({ signal } = {}) {
      if (!compatible && !apiKey) throw new ProviderError('auth', 'Add your OpenAI API key first.');
      const result = await getJson({ fetch, url: joinUrl(base, '/models'), headers: authHeaders(apiKey), signal, info });
      const items = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
      return items
        .map((item) => ({
          id: String(item?.id ?? item?.name ?? ''),
          name: String(item?.name ?? item?.id ?? ''),
          created: Number(item?.created ?? 0),
          contextWindow: positiveInt(item?.max_model_len ?? item?.context_length ?? item?.context_window ?? item?.loaded_context_length),
        }))
        .filter((item) => item.id)
        .filter((item) => (compatible ? !/embed|rerank|whisper|tts\b|bge-/i.test(item.id) : isOpenAIChatModel(item.id)));
    },
  };
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function isOpenAIChatModel(id) {
  return /^(gpt-|o\d|chatgpt-)/i.test(id)
    && !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|-pro\b|computer-use|deep-research|dall-e|whisper|diarize)/i.test(id);
}

// Prefers the newest undated flagship model.
export function defaultOpenAIModel(models) {
  const sorted = [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return (sorted.find((model) => !/(mini|nano|chatgpt|-\d{4}-\d{2}-\d{2}|preview)/i.test(model.id)) ?? sorted[0])?.id ?? '';
}

export const SERVER_PRESETS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', contextWindow: 8192 },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', contextWindow: 4096 },
  { id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', contextWindow: 4096 },
];

// Accepts what people paste: a host and port, an address with or without
// /v1, or a full endpoint URL.
export function normalizeBaseUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(url.protocol)) return '';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models|api\/chat|api\/tags|api\/generate)$/i, '');
  return url.toString().replace(/\/+$/, '');
}

async function probe(fetch, url, signal, headers = {}, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const init = body === undefined
      ? { headers, signal: controller.signal }
      : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal };
    const response = await fetch(url, init);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Finds the API base for a compatible server, identifies the server software
// when possible, lists its models, and reports context windows it publishes.
export async function inspectCompatibleServer({ baseUrl, apiKey, fetch, signal }) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new ProviderError('not-found', 'Enter the server address, for example http://localhost:11434 or 192.168.1.20:1234.');
  const candidates = /\/v1$/.test(normalized) ? [normalized] : [`${normalized}/v1`, normalized];
  let firstError;
  for (const candidate of candidates) {
    const provider = createOpenAIProvider({ apiKey, model: '', baseUrl: candidate, fetch, compatible: true, label: 'The server' });
    try {
      const models = await provider.listModels({ signal });
      const root = candidate.replace(/\/v1$/, '');
      const [ollama, lmstudio, llamacpp] = await Promise.all([
        probe(fetch, joinUrl(root, '/api/version'), signal, authHeaders(apiKey)),
        probe(fetch, joinUrl(root, '/api/v0/models'), signal, authHeaders(apiKey)),
        probe(fetch, joinUrl(root, '/props'), signal, authHeaders(apiKey)),
      ]);
      let server = 'generic';
      if (ollama?.version) server = 'ollama';
      else if (Array.isArray(lmstudio?.data)) {
        server = 'lmstudio';
        for (const entry of lmstudio.data) {
          const model = models.find((item) => item.id === entry?.id);
          const loaded = positiveInt(entry?.loaded_context_length);
          if (model && loaded) model.contextWindow = loaded;
        }
      } else if (llamacpp?.default_generation_settings) {
        server = 'llamacpp';
        const nCtx = positiveInt(llamacpp.default_generation_settings.n_ctx ?? llamacpp.n_ctx);
        if (nCtx) models.forEach((model) => { model.contextWindow = nCtx; });
      }
      return { baseUrl: candidate, server, models };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}

function ollamaContext(show) {
  const info = show?.model_info;
  if (!info || typeof info !== 'object') return undefined;
  const key = Object.keys(info).find((name) => name.endsWith('.context_length'));
  return key ? positiveInt(info[key]) : undefined;
}

// Asks a running compatible server how much context the selected model can
// take right now. Loaded sizes (LM Studio, llama.cpp) win over advertised
// maximums. Returns undefined when the server does not say.
export async function detectContextWindow({ baseUrl, apiKey, model, server, fetch, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !model) return undefined;
  const root = base.replace(/\/v1$/, '');
  const headers = authHeaders(apiKey);
  const [models, lmstudio, llamacpp, ollama] = await Promise.all([
    probe(fetch, joinUrl(base, '/models'), signal, headers)
      .then((result) => result ?? (/\/v1$/.test(base) ? null : probe(fetch, joinUrl(base, '/v1/models'), signal, headers))),
    server === 'lmstudio' || server === 'generic' || !server ? probe(fetch, joinUrl(root, '/api/v0/models'), signal, headers) : null,
    server === 'llamacpp' || server === 'generic' || !server ? probe(fetch, joinUrl(root, '/props'), signal, headers) : null,
    server === 'ollama' ? probe(fetch, joinUrl(root, '/api/show'), signal, headers, { model }) : null,
  ]);
  const loaded = positiveInt(lmstudio?.data?.find?.((entry) => entry?.id === model)?.loaded_context_length);
  if (loaded) return loaded;
  const nCtx = positiveInt(llamacpp?.default_generation_settings?.n_ctx ?? llamacpp?.n_ctx);
  if (nCtx) return nCtx;
  if (server === 'ollama') return ollamaContext(ollama);
  const items = Array.isArray(models?.data) ? models.data : Array.isArray(models?.models) ? models.models : [];
  const item = items.find((entry) => String(entry?.id ?? entry?.name ?? '') === model);
  return positiveInt(item?.max_model_len ?? item?.context_length ?? item?.context_window ?? item?.loaded_context_length);
}
