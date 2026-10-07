// Apple Intelligence through the bundled Swift helper, which wraps Apple's
// on-device Foundation Models framework (macOS 26 or later).
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { abortError, ProviderError } from './errors.js';

export const APPLE_DEFAULT_CONTEXT = 4096;

const REASONS = {
  deviceNotEligible: 'This Mac does not support Apple Intelligence.',
  appleIntelligenceNotEnabled: 'Apple Intelligence is turned off. Turn it on in System Settings > Apple Intelligence & Siri.',
  modelNotReady: 'Apple Intelligence is still getting ready (its model may be downloading). Try again later.',
  unsupportedOS: 'Apple Intelligence in Author Studio needs macOS 26 (Tahoe) or later.',
  unsupportedPlatform: 'Apple Intelligence is available only on a Mac.',
  helperMissing: 'The Apple Intelligence helper is missing from this copy of Author Studio.',
  helperFailed: 'The Apple Intelligence helper could not start.',
  unknown: 'Apple Intelligence is not available right now.',
};

export function appleReasonText(reason) {
  return REASONS[reason] ?? REASONS.unknown;
}

const ERRORS = {
  exceededContextWindowSize: ['too-large', 'The material for this step is too long for Apple Intelligence, which reads about 3,000 words at a time. Use a larger model for this step, or shorten the text.'],
  guardrailViolation: ['guardrail', 'Apple Intelligence\'s safety filter blocked this request. Try rephrasing your notes, or use a cloud or local model for this step.'],
  refusal: ['refused', 'Apple Intelligence declined to write this. Try rephrasing your notes, or use a different model for this step.'],
  assetsUnavailable: ['unavailable', REASONS.modelNotReady],
  unsupportedLanguageOrLocale: ['unsupported-language', 'Apple Intelligence does not support this language or region yet.'],
  rateLimited: ['rate-limit', 'Apple Intelligence is busy. Wait a moment, then try again.'],
  concurrentRequests: ['rate-limit', 'Apple Intelligence is busy with another request. Wait a moment, then try again.'],
  unavailable: ['unavailable', REASONS.unknown],
};

function isSupportedOS() {
  return process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25;
}

function runHelper(spawn, helperPath, args, { input, signal, onLine }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      settle(reject, abortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => settle(reject, error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch (error) {
          if (error instanceof ProviderError) {
            child.kill('SIGTERM');
            settle(reject, error);
          }
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on('close', (code, signalName) => {
      if (buffer.trim()) {
        try {
          onLine(JSON.parse(buffer.trim()));
        } catch {
          // Ignore a partial final line.
        }
      }
      settle(resolve, { code, signal: signalName, stderr });
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

// matureThemes uses Apple's permissive guardrails, which let the model work
// with the crime, conflict, and horror that much fiction needs; Apple's
// standard filter blocks even non-graphic mystery scenes. The model can still
// decline a request.
export function createAppleProvider({ helperPath, spawn = nodeSpawn, label = 'Apple Intelligence', platformCheck = isSupportedOS, matureThemes = true }) {
  async function status({ signal } = {}) {
    if (process.platform !== 'darwin') return { available: false, reason: 'unsupportedPlatform', message: REASONS.unsupportedPlatform };
    if (!platformCheck()) return { available: false, reason: 'unsupportedOS', message: REASONS.unsupportedOS };
    let result = null;
    try {
      const run = await runHelper(spawn, helperPath, ['status'], { signal, onLine: (line) => { result = line; } });
      if (!result) return { available: false, reason: 'helperFailed', message: REASONS.helperFailed, detail: run.stderr };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const reason = error?.code === 'ENOENT' || error?.code === 'EACCES' ? 'helperMissing' : 'helperFailed';
      return { available: false, reason, message: REASONS[reason], detail: String(error?.message ?? error) };
    }
    const reason = result.available ? null : result.reason ?? 'unknown';
    return {
      available: Boolean(result.available),
      reason,
      message: result.available ? 'Apple Intelligence is ready.' : appleReasonText(reason),
      contextWindow: Number.isInteger(result.contextSize) && result.contextSize > 0 ? result.contextSize : APPLE_DEFAULT_CONTEXT,
      osVersion: result.osVersion,
    };
  }

  return {
    type: 'apple',
    label,
    model: 'apple-on-device',
    status,
    async listModels() {
      return [{ id: 'apple-on-device', name: 'On-device model' }];
    },
    async generate({ system, prompt, maxTokens, temperature, signal, onDelta }) {
      if (!platformCheck()) throw new ProviderError('unavailable', process.platform === 'darwin' ? REASONS.unsupportedOS : REASONS.unsupportedPlatform);
      let text = '';
      let emitted = '';
      let finishReason = null;
      let failure = null;
      const emit = () => {
        if (text.startsWith(emitted) && text.length > emitted.length) {
          const delta = text.slice(emitted.length);
          emitted = text;
          onDelta?.(delta);
        }
      };
      const input = {
        instructions: system,
        prompt,
        maxResponseTokens: maxTokens,
        guardrails: matureThemes ? 'permissive' : 'default',
        ...(Number.isFinite(temperature) ? { temperature } : {}),
      };
      let run;
      try {
        run = await runHelper(spawn, helperPath, ['generate'], {
          input,
          signal,
          onLine: (line) => {
            if (line.type === 'delta' && typeof line.text === 'string') {
              text += line.text;
              emit();
            } else if (line.type === 'replace' && typeof line.text === 'string') {
              text = line.text;
              emit();
            } else if (line.type === 'done') {
              finishReason = line.finishReason === 'length' ? 'length' : 'stop';
            } else if (line.type === 'error') {
              const [code, message] = ERRORS[line.code] ?? ['server', `Apple Intelligence stopped with an error: ${String(line.message ?? line.code ?? 'unknown').slice(0, 200)}`];
              let text = line.code === 'unavailable' && line.reason ? appleReasonText(line.reason) : message;
              if (line.code === 'guardrailViolation' && !matureThemes) {
                text = 'Apple Intelligence\'s standard safety filter blocked this request; it often blocks crime, conflict, and horror scenes. Turn on "Allow mature fiction themes" for this connection in Settings, or use another model for this step.';
              }
              failure = new ProviderError(code, text, { detail: line.message });
            }
          },
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new ProviderError('unavailable', REASONS.helperMissing, { detail: error.message });
        throw new ProviderError('unavailable', REASONS.helperFailed, { detail: error?.message });
      }
      if (failure) throw failure;
      if (!finishReason) {
        if (signal?.aborted) throw abortError();
        throw new ProviderError('server', 'The Apple Intelligence helper stopped unexpectedly. Try again.', { detail: run?.stderr });
      }
      return { text, finishReason, model: 'apple-on-device' };
    },
  };
}
