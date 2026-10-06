// Token budgeting keeps prompts inside each model's context window. Estimates
// are deliberately conservative because exact tokenizers differ by provider.
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

function safety(profile) {
  return Math.max(64, Math.floor(profile.contextWindow * 0.02));
}

export function outputReserve(profile) {
  return profile.compact
    ? Math.min(profile.maxOutputTokens, Math.floor(profile.contextWindow * 0.45))
    : profile.maxOutputTokens;
}

export function inputBudget(profile) {
  return Math.max(0, profile.contextWindow - outputReserve(profile) - safety(profile));
}

export function requestMaxTokens(profile, inputTokens) {
  const room = profile.contextWindow - inputTokens - safety(profile);
  return Math.max(256, Math.min(profile.maxOutputTokens, room));
}

const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s)/g;

// Cuts at a paragraph, sentence, or word boundary near the limit when one is close.
function cutAtBoundary(text, maxChars, keep) {
  if (keep === 'tail') {
    const slice = text.slice(text.length - maxChars);
    const limit = Math.floor(slice.length * 0.3);
    const paragraph = slice.indexOf('\n\n');
    if (paragraph !== -1 && paragraph < limit) return slice.slice(paragraph + 2).trimStart();
    SENTENCE_END.lastIndex = 0;
    const sentence = SENTENCE_END.exec(slice);
    if (sentence && sentence.index < limit) return slice.slice(sentence.index + sentence[0].length).trimStart();
    const space = slice.search(/\s/);
    if (space !== -1 && space < limit) return slice.slice(space).trimStart();
    return slice;
  }
  const slice = text.slice(0, maxChars);
  const floor = Math.floor(slice.length * 0.7);
  const paragraph = slice.lastIndexOf('\n\n');
  if (paragraph > floor) return slice.slice(0, paragraph).trimEnd();
  let sentenceEnd = -1;
  for (const match of slice.matchAll(SENTENCE_END)) sentenceEnd = match.index + match[0].length;
  if (sentenceEnd > floor) return slice.slice(0, sentenceEnd);
  const space = slice.search(/\s\S*$/);
  if (space > floor) return slice.slice(0, space);
  return slice.trimEnd();
}

const OMITTED_LATER = '\n\n[… later text omitted to fit the model\'s memory …]';
const OMITTED_EARLIER = '[… earlier text omitted to fit the model\'s memory …]\n\n';

// Shortens text to at most maxTokens, keeping its beginning or its end.
export function fitText(text, maxTokens, keep = 'head') {
  const value = String(text ?? '');
  if (estimateTokens(value) <= maxTokens) return { text: value, truncated: false };
  const marker = keep === 'tail' ? OMITTED_EARLIER : OMITTED_LATER;
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN) - marker.length;
  if (maxChars <= 20) return { text: '', truncated: true };
  const kept = cutAtBoundary(value, maxChars, keep);
  return { text: keep === 'tail' ? `${marker}${kept}` : `${kept}${marker}`, truncated: true };
}
