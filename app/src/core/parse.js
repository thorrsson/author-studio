// Splits a worker response into the artifact and its trailing JSON assessment.
// Everything here treats model output as untrusted text.
import { isPlainObject } from './state.js';

export const ASSESSMENT_HEADING = '### AUTHOR STUDIO ASSESSMENT';

const MARKER_LINE = /^[ \t>#*=_~-]*(?:author[ \t-]*studio[ \t-]*)?assessment[ \t*=_~:-]*$/gim;
const LIVE_MARKER = /^[ \t>#*=_~-]*author[ \t-]*studio[ \t-]*assessment/im;
const MAX_LIST = 20;
const MAX_ITEM = 600;

export function stripThinking(text) {
  let output = String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, '');
  const orphanClose = output.search(/<\/think(?:ing)?>/i);
  if (orphanClose !== -1) output = output.slice(orphanClose).replace(/^<\/think(?:ing)?>\s*/i, '');
  const open = output.search(/<think(?:ing)?>/i);
  if (open !== -1) output = output.slice(0, open);
  return output;
}

function cleanArtifact(text) {
  return text.replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*)+\s*$/, '').trim();
}

// Finds the end of the JSON object that starts at `start`, honoring strings.
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lenientParse(text) {
  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
    text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, '$1'),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next repair.
    }
  }
  return undefined;
}

export function extractJsonObject(text) {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  const end = matchingBrace(text, start);
  const candidate = end === -1 ? text.slice(start) : text.slice(start, end + 1);
  const parsed = lenientParse(candidate);
  return isPlainObject(parsed) ? parsed : undefined;
}

function hasConfidenceJson(text) {
  return /\{[\s\S]*"?confidence"?\s*:/i.test(text);
}

function findTrailingJson(text) {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith('```')) {
    const close = trimmed.length - 3;
    const open = trimmed.lastIndexOf('```', close - 1);
    if (open !== -1) {
      const inner = trimmed.slice(open + 3, close).replace(/^(?:json)?[ \t]*\n/i, '');
      if (hasConfidenceJson(inner) && extractJsonObject(inner)) return { index: open, text: inner };
    }
  }
  if (!trimmed.endsWith('}')) return undefined;
  for (let start = trimmed.lastIndexOf('{'); start !== -1; start = trimmed.lastIndexOf('{', start - 1)) {
    const end = matchingBrace(trimmed, start);
    if (end === trimmed.length - 1) {
      const body = trimmed.slice(start);
      if (hasConfidenceJson(body) && extractJsonObject(body)) return { index: start, text: body };
    }
  }
  return undefined;
}

// A generic "Assessment" heading only counts when an assessment follows it directly,
// so a story section with that title is not cut off.
function startsAssessment(text) {
  const first = (/^\s*([^\n]*)/.exec(text)?.[1] ?? '').trim();
  if (first.startsWith('```') || first.startsWith('{')) return true;
  const field = FIELD_LINE.exec(first);
  return Boolean(field && FIELD_NAMES.has(field[1].trim().toLowerCase()));
}

export function splitResponse(raw) {
  const text = stripThinking(raw);
  let marker = null;
  for (const match of text.matchAll(MARKER_LINE)) {
    const rest = text.slice(match.index + match[0].length);
    if (!hasConfidenceJson(rest)) continue;
    if (/author[ \t-]*studio/i.test(match[0]) || startsAssessment(rest)) marker = match;
  }
  if (marker) {
    return {
      artifact: cleanArtifact(text.slice(0, marker.index)),
      assessmentText: text.slice(marker.index + marker[0].length),
      markerFound: true,
    };
  }
  const trailing = findTrailingJson(text);
  if (trailing) {
    return { artifact: cleanArtifact(text.slice(0, trailing.index)), assessmentText: trailing.text, markerFound: false };
  }
  const bareMarker = [...text.matchAll(MARKER_LINE)].at(-1);
  if (bareMarker && /author[ \t-]*studio/i.test(bareMarker[0])) {
    return { artifact: cleanArtifact(text.slice(0, bareMarker.index)), assessmentText: text.slice(bareMarker.index + bareMarker[0].length), markerFound: true };
  }
  return { artifact: cleanArtifact(text), assessmentText: null, markerFound: false };
}

// The text to show while a response is still streaming.
export function visibleArtifact(raw) {
  const text = stripThinking(raw);
  const marker = LIVE_MARKER.exec(text);
  let visible = marker ? text.slice(0, marker.index) : text;
  const lastLine = visible.slice(visible.lastIndexOf('\n') + 1);
  const partial = lastLine.trim().toUpperCase();
  if ((partial.startsWith('#') && ASSESSMENT_HEADING.startsWith(partial))
    || (partial.length >= 6 && 'AUTHOR STUDIO ASSESSMENT'.startsWith(partial))) {
    visible = visible.slice(0, visible.length - lastLine.length);
  }
  return cleanArtifact(visible);
}

export function toConfidence(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function textList(value) {
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return items
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .map((item) => item.trim())
    .filter((item) => item && !/^(none|n\/a|no (issues|contradictions))\.?$/i.test(item))
    .slice(0, MAX_LIST)
    .map((item) => (item.length > MAX_ITEM ? `${item.slice(0, MAX_ITEM - 1)}…` : item));
}

const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Small models sometimes answer with "- **confidence:** 0.8" lines instead of JSON.
const FIELD_LINE = /^[ \t>]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?[*_`"']*([a-z][a-z _]{2,30}?)[*_`"']*[ \t]*:[ \t]*[*_`]*[ \t]*(.*?)[ \t]*$/i;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*?)[ \t]*$/;
const FIELD_NAMES = new Map([
  ['confidence', 'confidence'],
  ['rationale', 'rationale'],
  ['flags', 'flags'],
  ['contradictions', 'contradictions'],
  ['complete', 'complete'],
  ['summary', 'summary'],
  ['change summary', 'change_summary'],
  ['change_summary', 'change_summary'],
  ['unresolved', 'unresolved'],
  ['proposed changes', 'proposed_changes'],
  ['proposed_changes', 'proposed_changes'],
]);

function fieldValue(value) {
  return value.replace(/,$/, '').trim().replace(/^(["'`])(.*)\1$/, '$2').replace(/[*_]+$/, '').trim();
}

function lineConfidence(value) {
  const match = /(\d+(?:\.\d+)?|\.\d+)[ \t]*(%|\/[ \t]*(?:10|100)\b)?/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  if (!match[2]) return toConfidence(number);
  return toConfidence(match[2] === '%' ? number / 100 : number / Number(match[2].replace(/\D/g, '')));
}

function parseFieldLines(source) {
  const lines = source.split(/\r?\n/);
  const fields = {};
  let listKey = null;
  for (let index = 0; index < lines.length; index += 1) {
    const field = FIELD_LINE.exec(lines[index]);
    const key = field && FIELD_NAMES.get(field[1].trim().toLowerCase());
    if (!key) {
      const item = listKey && LIST_ITEM.exec(lines[index]);
      if (item) fields[listKey].push(fieldValue(item[1]));
      else if (lines[index].trim()) listKey = null;
      continue;
    }
    if (key in fields) continue;
    const value = fieldValue(field[2]);
    listKey = null;
    if (key === 'proposed_changes') {
      fields[key] = value.startsWith('{') ? extractJsonObject(lines.slice(index).join('\n').slice(lines[index].indexOf('{'))) : undefined;
    } else if (['flags', 'contradictions', 'unresolved'].includes(key)) {
      const parsed = value.startsWith('[') ? lenientParse(value) : undefined;
      fields[key] = Array.isArray(parsed) ? parsed : value && value !== '[]' ? [value] : [];
      listKey = Array.isArray(parsed) ? null : key;
    } else {
      fields[key] = value;
    }
  }
  if (!('confidence' in fields)) return undefined;
  return {
    ...fields,
    confidence: lineConfidence(fields.confidence),
    complete: /^(true|yes)\b/i.test(fields.complete ?? '') ? true : /^(false|no)\b/i.test(fields.complete ?? '') ? false : undefined,
  };
}

export function parseAssessment(assessmentText) {
  const empty = {
    ok: false,
    confidence: null,
    rationale: '',
    flags: [],
    contradictions: [],
    complete: null,
    summary: '',
    changeSummary: '',
    unresolved: [],
    proposedChanges: undefined,
  };
  if (assessmentText === null || assessmentText === undefined || !String(assessmentText).trim()) {
    return { ...empty, error: 'missing' };
  }
  const source = String(assessmentText);
  const json = extractJsonObject(source);
  const object = json && 'confidence' in json ? json : parseFieldLines(source) ?? json;
  if (!object) return { ...empty, error: 'invalid' };
  return {
    ok: true,
    error: null,
    confidence: toConfidence(object.confidence),
    rationale: text(object.rationale),
    flags: textList(object.flags),
    contradictions: textList(object.contradictions),
    complete: typeof object.complete === 'boolean' ? object.complete : null,
    summary: text(object.summary, 1200),
    changeSummary: text(object.change_summary ?? object.changeSummary, 2000),
    unresolved: textList(object.unresolved ?? object.unresolved_issues),
    proposedChanges: object.proposed_changes ?? object.proposedChanges,
  };
}

export function countWords(value) {
  return (String(value ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
