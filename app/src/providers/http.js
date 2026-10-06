// Shared HTTP plumbing for providers: timeouts, retries, and stream reading.
import { abortError, errorFromNetwork, errorFromResponse, ProviderError, RETRYABLE } from './errors.js';

// Combines the caller's signal with a resettable inactivity timer.
export function createWatchdog(signal, ms) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    arm(duration = ms) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, duration);
      timer.unref?.();
    },
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Sends a request and returns the successful Response. Retries temporary
// failures (before any output exists) and maps every failure to a
// ProviderError, or an AbortError when the caller stopped it.
export async function send({ fetch, url, method = 'POST', headers = {}, body, signal, info, firstByteMs = 120_000, attempts = 3, watchdog }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const dog = watchdog ?? createWatchdog(signal, firstByteMs);
    dog.arm(firstByteMs);
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: dog.signal,
      });
      if (response.ok) return { response, watchdog: dog };
      lastError = await errorFromResponse(response, info);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (dog.timedOut) {
        lastError = new ProviderError('timeout', `${info.provider} did not answer within ${Math.round(firstByteMs / 1000)} seconds. Check the connection and try again.`);
      } else {
        lastError = errorFromNetwork(error, info);
        if (lastError?.name === 'AbortError') throw abortError();
      }
    }
    if (!watchdog) dog.dispose();
    if (!RETRYABLE.has(lastError.code) || attempt === attempts - 1) break;
    const wait = Math.min(20, lastError.retryAfter ?? 2 * 3 ** attempt) * 1000;
    if ((lastError.retryAfter ?? 0) > 20) break;
    await sleep(wait, signal);
  }
  throw lastError;
}

// Yields text lines from a response body as they arrive.
export async function* readLines(body, watchdog, idleMs) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const takeLine = () => {
    const match = /\r\n|\n|\r(?=[\s\S])/.exec(buffer);
    if (!match) return null;
    const line = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return line;
  };
  try {
    for (;;) {
      watchdog?.arm(idleMs);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let line = takeLine(); line !== null; line = takeLine()) yield line;
    }
    buffer += decoder.decode();
    for (let line = takeLine(); line !== null; line = takeLine()) yield line;
    if (buffer.replace(/\r$/, '')) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock?.();
  }
}

// Yields {event, data} records from a Server-Sent Events body.
export async function* readSSE(body, watchdog, idleMs) {
  let event = '';
  let data = [];
  for await (const line of readLines(body, watchdog, idleMs)) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

// Runs a streaming read, converting watchdog and caller aborts into the right errors.
export async function guardStream(run, { signal, watchdog, info, idleMs }) {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (watchdog?.timedOut) {
      throw new ProviderError('timeout', `${info.provider} stopped responding for ${Math.round(idleMs / 1000)} seconds, so the request was stopped. Try again.`);
    }
    if (error instanceof ProviderError) throw error;
    throw errorFromNetwork(error, info);
  } finally {
    watchdog?.dispose();
  }
}

export async function getJson({ fetch, url, headers, signal, info, timeoutMs = 15_000 }) {
  const { response, watchdog } = await send({ fetch, url, method: 'GET', headers, signal, info, firstByteMs: timeoutMs, attempts: 1 });
  try {
    watchdog.arm(timeoutMs);
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (watchdog.timedOut) throw new ProviderError('timeout', `${info.provider} did not answer in time.`);
    throw new ProviderError('bad-response', `${info.provider} sent a response that could not be read.`, { detail: error?.message });
  } finally {
    watchdog.dispose();
  }
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}
