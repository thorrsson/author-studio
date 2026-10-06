// Claude through the Anthropic Messages API.
import { errorFromStreamPayload, ProviderError } from './errors.js';
import { getJson, guardStream, joinUrl, readSSE, send } from './http.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const IDLE_MS = 90_000;

function headers(apiKey) {
  return { 'x-api-key': apiKey, 'anthropic-version': VERSION };
}

// Adjusts a rejected request once when the error names the problem.
function adjustment(error, body) {
  if (error.code !== 'bad-request') return null;
  const detail = error.detail ?? '';
  const limit = /max_tokens:\s*\d+\s*>\s*(\d+)/i.exec(detail);
  if (limit && Number(limit[1]) < body.max_tokens) return { ...body, max_tokens: Number(limit[1]) };
  if ('temperature' in body && /temperature/i.test(detail)) {
    const { temperature, ...rest } = body;
    return rest;
  }
  return null;
}

export function createAnthropicProvider({ apiKey, model, baseUrl = ANTHROPIC_BASE_URL, fetch, label = 'Claude', timeouts = {} }) {
  const idleMs = timeouts.idleMs ?? IDLE_MS;
  const firstByteMs = timeouts.firstByteMs ?? 120_000;
  const root = String(baseUrl || ANTHROPIC_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const info = { provider: label, model, baseUrl: root };

  async function stream(body, { signal, onDelta }) {
    const { response, watchdog } = await send({ fetch, url: joinUrl(root, '/v1/messages'), headers: headers(apiKey), body, signal, info, firstByteMs });
    return guardStream(async () => {
      let text = '';
      let stopReason = null;
      let finished = false;
      for await (const record of readSSE(response.body, watchdog, idleMs)) {
        let payload;
        try {
          payload = JSON.parse(record.data);
        } catch {
          continue;
        }
        const type = payload.type ?? record.event;
        if (type === 'content_block_delta' && payload.delta?.type === 'text_delta' && payload.delta.text) {
          text += payload.delta.text;
          onDelta?.(payload.delta.text);
        } else if (type === 'message_delta' && payload.delta?.stop_reason) {
          stopReason = payload.delta.stop_reason;
        } else if (type === 'error') {
          throw errorFromStreamPayload(payload, info);
        } else if (type === 'message_stop') {
          finished = true;
        }
      }
      if (stopReason === 'refusal') {
        throw new ProviderError('refused', `${label} declined to write this. Try rephrasing the request in your notes, or use a different model for this step.`);
      }
      if (!finished && !text) throw new ProviderError('network', `The connection to ${label} closed before any text arrived. Try again.`);
      const finishReason = !finished || stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded' ? 'length' : 'stop';
      return { text, finishReason, model };
    }, { signal, watchdog, info, idleMs });
  }

  return {
    type: 'anthropic',
    label,
    model,
    async generate({ system, prompt, maxTokens, temperature, signal, onDelta }) {
      if (!apiKey) throw new ProviderError('auth', `Add your Anthropic API key in Settings to use ${label}.`);
      if (!model) throw new ProviderError('model-not-found', `Choose a ${label} model in Settings.`);
      let body = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
      };
      try {
        return await stream(body, { signal, onDelta });
      } catch (error) {
        const next = error instanceof ProviderError ? adjustment(error, body) : null;
        if (!next) throw error;
        body = next;
        return stream(body, { signal, onDelta });
      }
    },
    async listModels({ signal } = {}) {
      if (!apiKey) throw new ProviderError('auth', 'Add your Anthropic API key first.');
      const models = [];
      let after = '';
      for (let page = 0; page < 5; page += 1) {
        const query = `limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const result = await getJson({ fetch, url: joinUrl(root, `/v1/models?${query}`), headers: headers(apiKey), signal, info });
        for (const item of result?.data ?? []) {
          if (item?.id) models.push({ id: String(item.id), name: String(item.display_name || item.id), created: item.created_at ?? '' });
        }
        if (!result?.has_more || !result.last_id) break;
        after = result.last_id;
      }
      return models;
    },
  };
}

// Prefers the newest Sonnet model, then the newest model of any kind.
export function defaultAnthropicModel(models) {
  const sorted = [...models].sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return (sorted.find((model) => /sonnet/i.test(model.id)) ?? sorted[0])?.id ?? '';
}
