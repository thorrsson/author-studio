import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResources } from '../src/core/resources.js';
import { ASSESSMENT_HEADING } from '../src/core/parse.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const resources = await loadResources(repoRoot);
export const template = resources.template;

export const FULL = Object.freeze({ contextWindow: 200000, maxOutputTokens: 8192, compact: false });
export const COMPACT = Object.freeze({ contextWindow: 4096, maxOutputTokens: 4096, compact: true });

export function respond(artifact, assessment) {
  return `${artifact}\n\n${ASSESSMENT_HEADING}\n\`\`\`json\n${JSON.stringify(assessment, null, 2)}\n\`\`\``;
}

export function good(artifact, extra = {}) {
  return respond(artifact, {
    confidence: 0.9,
    rationale: 'Fits the brief.',
    flags: [],
    contradictions: [],
    complete: true,
    summary: `Summary of ${artifact.slice(0, 20)}`,
    proposed_changes: {},
    ...extra,
  });
}

let ids = 0;

// A fake model that replays scripted responses and records each request.
export function makeCtx(responses = [], overrides = {}) {
  const queue = [...responses];
  const calls = [];
  let tick = 0;
  const generate = async (request) => {
    calls.push(request);
    if (!queue.length) throw new Error('No scripted response left.');
    const next = queue.shift();
    const value = typeof next === 'function' ? await next(request) : next;
    const result = typeof value === 'string' ? { text: value, finishReason: 'stop' } : value;
    for (const chunk of result.text.match(/[\s\S]{1,50}/g) ?? []) request.onDelta?.(chunk);
    return result;
  };
  const ctx = {
    generate,
    resources,
    label: 'Test model',
    profile: FULL,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    uuid: () => `uuid-${++ids}`,
    ...overrides,
  };
  return { ctx, calls, queue };
}
