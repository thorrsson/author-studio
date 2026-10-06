// Connection types, their model limits, and provider construction.
import { createAnthropicProvider, ANTHROPIC_BASE_URL, defaultAnthropicModel } from './anthropic.js';
import { createAppleProvider, APPLE_DEFAULT_CONTEXT } from './apple.js';
import { createOpenAIProvider, defaultOpenAIModel, normalizeBaseUrl, OPENAI_BASE_URL, SERVER_PRESETS } from './openai.js';

export const CONNECTION_TYPES = {
  anthropic: {
    name: 'Claude (Anthropic)',
    short: 'Claude',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Starts with sk-ant-',
    baseUrl: ANTHROPIC_BASE_URL,
  },
  openai: {
    name: 'GPT (OpenAI)',
    short: 'GPT',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Starts with sk-',
    baseUrl: OPENAI_BASE_URL,
  },
  compatible: {
    name: 'Local or network server (OpenAI-compatible)',
    short: 'Local server',
    needsKey: false,
    presets: SERVER_PRESETS,
  },
  apple: {
    name: 'Apple Intelligence (on this Mac)',
    short: 'Apple Intelligence',
    needsKey: false,
    macOnly: true,
  },
};

export const DEFAULT_COMPATIBLE_CONTEXT = 8192;
const MIN_CONTEXT = 2048;
const MAX_CONTEXT = 2_000_000;

export function clampContext(value, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, number));
}

// What the prompt builder may assume about a connection's model.
export function profileFor(connection, { appleContext } = {}) {
  const maxOutputOverride = Number(connection?.maxOutputTokens) > 0 ? Math.floor(Number(connection.maxOutputTokens)) : undefined;
  switch (connection?.type) {
    case 'anthropic':
      return { contextWindow: clampContext(connection.contextWindow, 200_000), maxOutputTokens: maxOutputOverride ?? 8192, compact: false };
    case 'openai':
      return { contextWindow: clampContext(connection.contextWindow, 128_000), maxOutputTokens: maxOutputOverride ?? 16_384, compact: false };
    case 'apple': {
      const contextWindow = clampContext(appleContext ?? connection.contextWindow, APPLE_DEFAULT_CONTEXT);
      return { contextWindow, maxOutputTokens: maxOutputOverride ?? contextWindow, compact: true };
    }
    case 'compatible':
    default: {
      const contextWindow = clampContext(connection?.contextWindow, DEFAULT_COMPATIBLE_CONTEXT);
      return {
        contextWindow,
        maxOutputTokens: maxOutputOverride ?? Math.min(contextWindow >= 32_768 ? 8192 : 4096, Math.floor(contextWindow / 2)),
        compact: contextWindow < 16_384,
      };
    }
  }
}

export function connectionLabel(connection) {
  if (!connection) return 'the model';
  const type = CONNECTION_TYPES[connection.type];
  const name = String(connection.name || type?.short || 'Model').trim();
  return connection.model && connection.type !== 'apple' ? `${name} (${connection.model})` : name;
}

export function createProvider(connection, { apiKey, fetch, appleHelperPath, spawn } = {}) {
  const label = String(connection?.name || CONNECTION_TYPES[connection?.type]?.short || 'The model');
  switch (connection?.type) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey, model: connection.model, baseUrl: connection.baseUrl || ANTHROPIC_BASE_URL, fetch, label });
    case 'openai':
      return createOpenAIProvider({ apiKey, model: connection.model, baseUrl: connection.baseUrl || OPENAI_BASE_URL, fetch, label });
    case 'compatible':
      return createOpenAIProvider({
        apiKey,
        model: connection.model,
        baseUrl: normalizeBaseUrl(connection.baseUrl),
        fetch,
        label,
        compatible: true,
        server: connection.server,
        contextWindow: profileFor(connection).contextWindow,
      });
    case 'apple':
      return createAppleProvider({ helperPath: appleHelperPath, label, matureThemes: connection.matureThemes !== false, ...(spawn ? { spawn } : {}) });
    default:
      throw new Error(`Unknown connection type: ${connection?.type}`);
  }
}

export function defaultModelFor(type, models) {
  if (type === 'anthropic') return defaultAnthropicModel(models);
  if (type === 'openai') return defaultOpenAIModel(models);
  if (type === 'apple') return 'apple-on-device';
  return models[0]?.id ?? '';
}
