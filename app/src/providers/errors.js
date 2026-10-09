// Provider errors carry a stable code and a message written for authors, not
// developers. The original detail is kept for the activity log.
export class ProviderError extends Error {
  constructor(code, message, { status, detail, retryAfter, param } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (detail) this.detail = String(detail).slice(0, 2000);
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (param) this.param = param;
  }
}

export function abortError() {
  const error = new Error('The request was stopped.');
  error.name = 'AbortError';
  return error;
}

export function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url ?? 'the server');
  }
}

function errorParts(body) {
  if (!body || typeof body !== 'object') return { message: typeof body === 'string' ? body : '', type: '', code: '', param: '' };
  const inner = body.error && typeof body.error === 'object' ? body.error : body;
  return {
    message: String(inner.message ?? (typeof body.error === 'string' ? body.error : '') ?? body.detail ?? ''),
    type: String(inner.type ?? ''),
    code: String(inner.code ?? ''),
    param: String(inner.param ?? ''),
  };
}

// Local servers also reject prompts that do not fit in free memory, even below the advertised window.
const CONTEXT_PATTERN = /context[ _-]?(length|window|size)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long|exceeds? the (model|available)|context too large|prefill (memory|capacity|context|would require)|memory guard|(not enough|insufficient|out of) memory|kv[ -]?cache (is )?full/i;

function retryAfterSeconds(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}

// Turns an HTTP error response into a ProviderError.
export async function errorFromResponse(response, { provider, model, baseUrl }) {
  const raw = await response.text().catch(() => '');
  let body = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // Not JSON; keep the text.
  }
  const { message, type, code, param } = errorParts(body);
  const detail = message || raw.slice(0, 500) || response.statusText || '';
  const status = response.status;
  const options = { status, detail, param, retryAfter: retryAfterSeconds(response) };
  const said = detail ? ` (${provider} said: ${detail.slice(0, 300)})` : '';

  if (status === 401 || type === 'authentication_error' || code === 'invalid_api_key') {
    return new ProviderError('auth', `${provider} did not accept the API key. Open Settings and check the key for this connection.`, options);
  }
  if (code === 'insufficient_quota' || /credit balance|insufficient[_ ]quota|billing/i.test(detail)) {
    return new ProviderError('quota', `Your ${provider} account is out of credit or over its spending limit. Check billing on the provider's website, then try again.`, options);
  }
  if (status === 403 || type === 'permission_error') {
    return new ProviderError('forbidden', `${provider} refused the request. Your account or key may not have access to ${model ? `"${model}"` : 'this model'}.${said}`, options);
  }
  if (status === 404 || type === 'not_found_error' || code === 'model_not_found') {
    if (/model/i.test(detail) || code === 'model_not_found') {
      return new ProviderError('model-not-found', `${provider} could not find the model "${model}". Open Settings and choose another model.${said}`, options);
    }
    return new ProviderError('not-found', `The server at ${hostOf(baseUrl)} did not recognize this request. Check the server address in Settings.${said}`, options);
  }
  if (status === 413 || CONTEXT_PATTERN.test(detail)) {
    return new ProviderError('too-large', `The material for this step is too long for ${model ? `"${model}"` : 'this model'}. Choose a model with a larger context window in Settings, or shorten the text.${said}`, options);
  }
  if (status === 429 || type === 'rate_limit_error') {
    return new ProviderError('rate-limit', `${provider} is limiting requests right now. Wait a minute, then try again.`, options);
  }
  if (status === 529 || type === 'overloaded_error') {
    return new ProviderError('overloaded', `${provider} is overloaded right now. Try again in a few minutes.`, options);
  }
  if (/only supported in v1\/responses|not a chat model|not supported in the v1\/chat\/completions/i.test(detail)) {
    return new ProviderError('unsupported-model', `"${model}" cannot be used for chat. Open Settings and choose another model.`, options);
  }
  if (status >= 500) {
    return new ProviderError('server', `${provider} had a temporary problem (error ${status}). Try again in a moment.${said}`, options);
  }
  return new ProviderError('bad-request', `${provider} rejected the request${detail ? `: ${detail.slice(0, 400)}` : ` (error ${status}).`}`, options);
}

// Errors a stream reports after it started (Anthropic "error" events, or an
// OpenAI-compatible chunk with an "error" member).
export function errorFromStreamPayload(payload, { provider, model }) {
  const { message, type, code } = errorParts(payload);
  const detail = message || type || code || 'unknown error';
  if (type === 'overloaded_error') return new ProviderError('overloaded', `${provider} is overloaded right now. Try again in a few minutes.`, { detail });
  if (type === 'rate_limit_error' || /rate limit/i.test(detail)) return new ProviderError('rate-limit', `${provider} is limiting requests right now. Wait a minute, then try again.`, { detail });
  if (CONTEXT_PATTERN.test(detail)) {
    return new ProviderError('too-large', `The material for this step is too long for ${model ? `"${model}"` : 'this model'}. Choose a model with a larger context window in Settings, or shorten the text.`, { detail });
  }
  return new ProviderError('server', `${provider} stopped with an error: ${detail.slice(0, 300)}`, { detail });
}

function causeCodes(error) {
  const codes = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (value.code) codes.push(String(value.code));
    if (value.message) codes.push(String(value.message));
    if (Array.isArray(value.errors)) value.errors.forEach((item) => visit(item, depth + 1));
    visit(value.cause, depth + 1);
  };
  visit(error);
  return codes.join(' ');
}

// Turns a network failure (Node or Chromium networking) into a ProviderError.
export function errorFromNetwork(error, { provider, baseUrl }) {
  if (error instanceof ProviderError || error?.name === 'AbortError') return error;
  const host = hostOf(baseUrl);
  const text = causeCodes(error);
  const detail = text.slice(0, 500);
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(text)) {
    return new ProviderError('network', `Could not connect to ${host}. Make sure the server is running and that this computer can reach it.`, { detail });
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(text)) {
    return new ProviderError('network', `Could not find ${host}. Check the address and your internet connection.`, { detail });
  }
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED/.test(text)) {
    return new ProviderError('network', `This computer could not reach ${host}. Check your network connection${/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ? ' and, on a Mac, allow Author Studio to find devices on your local network in System Settings > Privacy & Security > Local Network' : ''}.`, { detail });
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(text)) {
    return new ProviderError('timeout', `Timed out connecting to ${host}. Check the address and that the server is running.`, { detail });
  }
  if (/CERT|SSL|TLS|ERR_SSL/i.test(text)) {
    return new ProviderError('network', `The security certificate for ${host} was not accepted. If this is a local server, use an http:// address.`, { detail });
  }
  if (/ECONNRESET|UND_ERR_SOCKET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|terminated|other side closed/i.test(text)) {
    return new ProviderError('network', `The connection to ${host} was interrupted. Try again.`, { detail });
  }
  if (/ERR_UNSAFE_PORT/.test(text)) {
    return new ProviderError('network', `The port in ${host} is blocked for safety. Configure the server to use another port, such as 8080.`, { detail });
  }
  return new ProviderError('network', `Could not reach ${host}: ${String(error?.message ?? error).slice(0, 200)}`, { detail });
}

export const RETRYABLE = new Set(['rate-limit', 'overloaded', 'server']);
