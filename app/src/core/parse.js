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

const PLANNING_HEADING = /^#{2,4}[ \t]+(?:chapter[ \t]+)?(?:thread(?:s)?[ \t]+(?:tracking|updates|notes|log)|scene[ \t]+(?:timeline|notes|tracking|updates)|continuity[ \t]+(?:notes|tracking|updates)|timeline[ \t]+(?:notes|updates|events)|planned[ \t]+beats|actual[ \t]+events|open[ \t]+questions|confirmed[ \t]+resolutions|chapter[ \t]+updates)[ \t]*$/i;
const PLANNING_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+.+$/;

export function separatePlanningAppendix(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length - 1;
  while (end >= 0 && (!lines[end].trim() || /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(lines[end]))) end -= 1;
  if (end < 0 || !PLANNING_ITEM.test(lines[end])) return { artifact: cleanArtifact(lines.join('\n')) };
  let firstItem = end;
  while (firstItem >= 0 && (PLANNING_ITEM.test(lines[firstItem]) || !lines[firstItem].trim())) firstItem -= 1;
  const headingIndex = firstItem;
  if (headingIndex < 0 || !PLANNING_HEADING.test(lines[headingIndex])) return { artifact: cleanArtifact(lines.join('\n')) };
  const appendixLines = lines.slice(headingIndex, end + 1);
  const bodyLines = appendixLines.slice(1).filter((line) => line.trim());
  if (!bodyLines.length || !bodyLines.every((line) => PLANNING_ITEM.test(line))) {
    return { artifact: cleanArtifact(lines.join('\n')) };
  }
  return {
    artifact: cleanArtifact(lines.slice(0, headingIndex).join('\n')),
    separatedNotes: appendixLines.join('\n').trim(),
  };
}

// Only detach a recognizable, list-only planning appendix, never a story
// section merely titled "Threads" or prose that follows such a section.
export function splitChapterNotes(content) {
  const heading = /^#{1,6}[ \t]+(?:Threads|Changes to the scene timeline)[ \t]*\r?$/gim;
  for (const match of content.matchAll(heading)) {
    const notes = content.slice(match.index).trim();
    const recognizable = /^\*\*(?:Resolved Threads|New Threads Introduced)(?:[ \t]+\([^*\n]*\))?:\*\*[ \t]*\r?$/im.test(notes)
      || (/^#{1,6}[ \t]+Changes to the scene timeline[ \t]*\r?$/im.test(notes) && /^[ \t]*[-*+][ \t]+\*\*Beats for Unit \d+:\*\*[ \t]*\r?$/im.test(notes));
    const listOnly = notes.split(/\r?\n/).every((line) => !line.trim()
      || /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|\*\*[^*]+\*\*[ \t]*$|(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/.test(line));
    if (recognizable && listOnly && /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/m.test(notes)) {
      return { content: cleanArtifact(content.slice(0, match.index)), continuityNotes: notes };
    }
  }
  return { content, continuityNotes: '' };
}

function separateChapterPlanningNotes(content) {
  const separated = separatePlanningAppendix(content);
  if (separated.separatedNotes) return separated;
  const legacy = splitChapterNotes(separated.artifact);
  return legacy.continuityNotes
    ? { artifact: legacy.content, separatedNotes: legacy.continuityNotes }
    : separated;
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

// A trailing JSON block that carries assessment keys is the assessment even when the rating was left out.
const ASSESSMENT_KEYS = ['rationale', 'flags', 'contradictions', 'complete', 'summary', 'proposed_changes', 'lore', 'plot', 'characters'];
function looksLikeAssessment(text) {
  const object = extractJsonObject(text);
  return Boolean(object) && ASSESSMENT_KEYS.filter((key) => key in object).length >= 2;
}

function findTrailingJson(text) {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith('```')) {
    const close = trimmed.length - 3;
    const open = trimmed.lastIndexOf('```', close - 1);
    if (open !== -1) {
      const inner = trimmed.slice(open + 3, close).replace(/^(?:json)?[ \t]*\n/i, '');
      if ((hasConfidenceJson(inner) || looksLikeAssessment(inner)) && extractJsonObject(inner)) return { index: open, text: inner };
    }
  }
  if (!trimmed.endsWith('}')) return undefined;
  for (let start = trimmed.lastIndexOf('{'); start !== -1; start = trimmed.lastIndexOf('{', start - 1)) {
    const end = matchingBrace(trimmed, start);
    if (end === trimmed.length - 1) {
      const body = trimmed.slice(start);
      if ((hasConfidenceJson(body) || looksLikeAssessment(body)) && extractJsonObject(body)) return { index: start, text: body };
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

export function splitResponse(raw, { separatePlanning = true } = {}) {
  const text = stripThinking(raw);
  let marker = null;
  for (const match of text.matchAll(MARKER_LINE)) {
    const rest = text.slice(match.index + match[0].length);
    if (!hasConfidenceJson(rest)) continue;
    if (/author[ \t-]*studio/i.test(match[0]) || startsAssessment(rest)) marker = match;
  }
  if (marker) {
    return splitArtifact(text.slice(0, marker.index), text.slice(marker.index + marker[0].length), true, separatePlanning);
  }
  const trailing = findTrailingJson(text);
  if (trailing) {
    const before = text.slice(0, trailing.index).replace(/\n[ \t>#*=_~-]*(?:author[ \t-]*studio[ \t-]*)?assessment[ \t*=_~:-]*\s*$/i, '');
    return splitArtifact(before, trailing.text, false, separatePlanning);
  }
  const bareMarker = [...text.matchAll(MARKER_LINE)].at(-1);
  if (bareMarker && /author[ \t-]*studio/i.test(bareMarker[0])) {
    return splitArtifact(text.slice(0, bareMarker.index), text.slice(bareMarker.index + bareMarker[0].length), true, separatePlanning);
  }
  return splitArtifact(text, null, false, separatePlanning);
}

function splitArtifact(value, assessmentText, markerFound, separatePlanning) {
  return {
    ...(separatePlanning ? separateChapterPlanningNotes(value) : { artifact: cleanArtifact(value) }),
    assessmentText,
    markerFound,
  };
}

// The text to show while a response is still streaming.
export function visibleArtifact(raw, { separatePlanning = false, chapter = false } = {}) {
  const text = stripThinking(raw);
  const marker = LIVE_MARKER.exec(text);
  let visible = marker ? text.slice(0, marker.index) : text;
  const lastLine = visible.slice(visible.lastIndexOf('\n') + 1);
  const partial = lastLine.trim().toUpperCase();
  if ((partial.startsWith('#') && ASSESSMENT_HEADING.startsWith(partial))
    || (partial.length >= 6 && 'AUTHOR STUDIO ASSESSMENT'.startsWith(partial))) {
    visible = visible.slice(0, visible.length - lastLine.length);
  }
  const content = cleanArtifact(visible);
  return separatePlanning || chapter ? separateChapterPlanningNotes(content).artifact : content;
}

// Models often write 85, "85%", or "8/10" for a 0-1 rating; read the scale they clearly meant.
export function toConfidence(value) {
  let number = value;
  if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(%|\/\s*(?:1|10|100)(?![\d.]))?\s*$/.exec(value);
    if (!match) return null;
    number = Number(match[1]);
    if (match[2] === '%') number /= 100;
    else if (match[2]) number /= Number(match[2].replace(/\D/g, ''));
  }
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
  if (number > 10 && number <= 100 && !(typeof value === 'string' && /[%/]/.test(value))) number /= 100;
  return number <= 1 ? number : null;
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
  const match = /(\d+(?:\.\d+)?|\.\d+)[ \t]*(%|\/[ \t]*(?:10|100|1)\b)?/.exec(value);
  return match ? toConfidence(`${match[1]}${(match[2] ?? '').replace(/\s/g, '')}`) : null;
}

function parseFieldLines(source) {
  const lines = source.split(/\r?\n/);
  const fields = {};
  let listKey = null;
  for (let index = 0; index < lines.length; index += 1) {
    const field = FIELD_LINE.exec(lines[index]);
    const name = field?.[1].trim().toLowerCase();
    const key = field && (/^confidence(?: (?:level|score|rating))?$/.test(name) ? 'confidence' : FIELD_NAMES.get(name));
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

// Lowercases keys and unwraps one level such as {"assessment": {...}}.
function normalizeKeys(object) {
  if (!object) return object;
  const lower = Object.fromEntries(Object.entries(object).map(([key, value]) => [key.trim().toLowerCase().replace(/[ -]+/g, '_'), value]));
  if ('confidence' in lower) return lower;
  const inner = Object.values(lower).find((value) => isPlainObject(value) && Object.keys(value).some((key) => key.toLowerCase() === 'confidence'));
  return inner ? normalizeKeys(inner) : lower;
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
  const json = normalizeKeys(extractJsonObject(source));
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
