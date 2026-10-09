import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSESSMENT_HEADING,
  countWords,
  extractJsonObject,
  parseAssessment,
  splitResponse,
  splitChapterNotes,
  stripThinking,
  toConfidence,
  visibleArtifact,
} from '../src/core/parse.js';
import { respond } from './helpers.mjs';

const CHAPTER_NOTES = `### Threads

**Resolved Threads (based on this chapter):**

- *TechCorp's connection to the warehouse* - Confirmed as a front.

**New Threads Introduced (by this chapter):**

- *Hiro's knowledge* - Can he be trusted?

### Changes to the scene timeline

- **Beats for Unit 7:**
    - Infiltrate the mainframe room
    - Discover the containment field`;

test('separates a structured chapter appendix without losing its notes', () => {
  const prose = '# Chapter 7\n\nHiro closed the door.';
  const result = splitChapterNotes(`${prose}\n\n---\n\n${CHAPTER_NOTES}`);
  assert.equal(result.content, prose);
  assert.equal(result.continuityNotes, CHAPTER_NOTES);
  const timeline = CHAPTER_NOTES.slice(CHAPTER_NOTES.indexOf('### Changes'));
  assert.deepEqual(splitChapterNotes(`${prose}\n\n${timeline}`), { content: prose, continuityNotes: timeline });
});

test('keeps ordinary story headings, lists, and ambiguous text in the chapter', () => {
  for (const content of [
    '# Chapter 1\n\n### Threads\n\nShe pulled a thread from her sleeve.',
    '# Chapter 1\n\n### Threads\n\n- Red\n- Blue',
    `# Chapter 1\n\n${CHAPTER_NOTES}\n\nHiro walked away.`,
    '# Chapter 1\n\n```markdown\n### Threads\n**Resolved Threads:**\n- A thread\n```',
  ]) {
    assert.deepEqual(splitChapterNotes(content), { content, continuityNotes: '' });
  }
});

test('splits an artifact from its fenced assessment', () => {
  const raw = respond('# Chapter 1\n\nThe rain kept on.', { confidence: 0.82, flags: ['pacing'], contradictions: [], complete: true });
  const { artifact, assessmentText, markerFound } = splitResponse(raw);
  assert.equal(artifact, '# Chapter 1\n\nThe rain kept on.');
  assert.equal(markerFound, true);
  const assessment = parseAssessment(assessmentText);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.confidence, 0.82);
  assert.deepEqual(assessment.flags, ['pacing']);
  assert.equal(assessment.complete, true);
});

test('ignores assessment-like headings inside the artifact and uses the last real marker', () => {
  const raw = [
    '# Notes',
    '',
    '## Assessment',
    'The detective weighs the evidence.',
    '',
    ASSESSMENT_HEADING,
    'This line in the story mentions the marker but no JSON follows.',
    '',
    respond('More story.', { confidence: 0.9 }),
  ].join('\n');
  const { artifact, assessmentText } = splitResponse(raw);
  assert.match(artifact, /## Assessment\nThe detective weighs the evidence\./);
  assert.match(artifact, /More story\.$/);
  assert.equal(parseAssessment(assessmentText).confidence, 0.9);
});

test('keeps a generic Assessment section in the story unless an assessment follows it', () => {
  const story = '# Chapter\n\n## Assessment\nThe inspector weighs the evidence.\n\nShe decides.';
  const trailing = splitResponse(`${story}\n\n\`\`\`json\n{"confidence": 0.6}\n\`\`\``);
  assert.equal(trailing.artifact, story);
  assert.equal(parseAssessment(trailing.assessmentText).confidence, 0.6);

  const generic = splitResponse('Story.\n\n## Assessment\n```json\n{"confidence": 0.7}\n```');
  assert.equal(generic.artifact, 'Story.');
  assert.equal(generic.markerFound, true);
});

test('falls back to a trailing JSON block or object without the marker', () => {
  const fenced = 'Story text.\n\n```json\n{"confidence": 0.7, "flags": []}\n```';
  assert.equal(splitResponse(fenced).artifact, 'Story text.');
  assert.equal(parseAssessment(splitResponse(fenced).assessmentText).confidence, 0.7);

  const bare = 'Story text.\n{"confidence": "0.8", "complete": false}';
  const split = splitResponse(bare);
  assert.equal(split.artifact, 'Story text.');
  const assessment = parseAssessment(split.assessmentText);
  assert.equal(assessment.confidence, 0.8);
  assert.equal(assessment.complete, false);
});

test('separates recognizable list-only planning appendices without treating prose as metadata', () => {
  const story = '# Chapter 1\n\nShe reached the harbor before dawn.';
  const split = splitResponse(respond(`${story}\n\n## Thread tracking\n- The missing key remains unexplained.\n- Mara promises to return.`, { confidence: 0.9 }));
  assert.equal(split.artifact, story);
  assert.equal(split.separatedNotes, '## Thread tracking\n- The missing key remains unexplained.\n- Mara promises to return.');
  const unseparated = splitResponse(respond(`${story}\n\n## Thread tracking\n- The missing key remains unexplained.`, { confidence: 0.9 }), { separatePlanning: false });
  assert.match(unseparated.artifact, /## Thread tracking/);
  assert.equal(unseparated.separatedNotes, undefined);

  const ordinary = splitResponse(respond(`${story}\n\n## The Timeline\nThe rain began as she reached the harbor.`, { confidence: 0.9 }));
  assert.equal(ordinary.artifact, `${story}\n\n## The Timeline\nThe rain began as she reached the harbor.`);
  assert.equal(ordinary.separatedNotes, undefined);

  const threadSection = splitResponse(respond(`${story}\n\n### Threads\n- Red\n- Blue`, { confidence: 0.9 }));
  assert.equal(threadSection.artifact, `${story}\n\n### Threads\n- Red\n- Blue`);
  assert.equal(threadSection.separatedNotes, undefined);

  const mixed = splitResponse(respond(`${story}\n\n## Scene timeline\n- She reaches the harbor.\n\nThe fog lifts.`, { confidence: 0.9 }));
  assert.match(mixed.artifact, /## Scene timeline/);
  assert.equal(mixed.separatedNotes, undefined);
});

test('treats a missing or unreadable assessment as unassessed', () => {
  const missing = splitResponse('Only a story, no assessment.');
  assert.equal(missing.assessmentText, null);
  assert.equal(parseAssessment(missing.assessmentText).error, 'missing');
  assert.equal(parseAssessment(missing.assessmentText).confidence, null);

  const invalid = parseAssessment('```json\n{confidence: high}\n```');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid');
  assert.equal(invalid.confidence, null);
});

test('repairs common JSON mistakes and rejects out-of-range confidence', () => {
  const repaired = parseAssessment('{\u201cconfidence\u201d: 0.9, \u201cflags\u201d: [\u201cone\u201d,],}');
  assert.equal(repaired.confidence, 0.9);
  assert.deepEqual(repaired.flags, ['one']);
  assert.equal(toConfidence(1.5), null);
  assert.equal(toConfidence(-0.1), null);
  assert.equal(toConfidence('abc'), null);
  assert.equal(toConfidence(Number.NaN), null);
  assert.equal(toConfidence(0), 0);
  assert.equal(toConfidence(1), 1);
});

test('drops "none" placeholders from lists and keeps strings', () => {
  const assessment = parseAssessment('{"confidence": 0.8, "flags": ["None"], "contradictions": "n/a", "unresolved": [{"issue": "x"}]}');
  assert.deepEqual(assessment.flags, []);
  assert.deepEqual(assessment.contradictions, []);
  assert.deepEqual(assessment.unresolved, ['{"issue":"x"}']);
});

test('reads key-value assessment lines when a small model skips the JSON', () => {
  const raw = [
    '# Plot',
    '',
    'Beats here.',
    '',
    '## Author Studio Assessment',
    '- **confidence:** 0.9',
    '- **rationale:** Fits the brief.',
    '- **flags:**',
    '  - Pacing in act two',
    '  - Motive: still thin',
    '- **contradictions:** None',
    '- **complete:** true',
    '- **summary:** A baker decodes recipes.',
    '- **proposed_changes:** {"plot": {"loose_threads": ["Who wrote the codes?"]}}',
  ].join('\n');
  const split = splitResponse(raw);
  assert.equal(split.artifact, '# Plot\n\nBeats here.');
  const assessment = parseAssessment(split.assessmentText);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.confidence, 0.9);
  assert.equal(assessment.rationale, 'Fits the brief.');
  assert.deepEqual(assessment.flags, ['Pacing in act two', 'Motive: still thin']);
  assert.deepEqual(assessment.contradictions, []);
  assert.equal(assessment.complete, true);
  assert.equal(assessment.summary, 'A baker decodes recipes.');
  assert.deepEqual(assessment.proposedChanges, { plot: { loose_threads: ['Who wrote the codes?'] } });

  const percent = parseAssessment('**Confidence**: 85%\n**Complete**: no');
  assert.equal(percent.confidence, 0.85);
  assert.equal(percent.complete, false);
  assert.equal(parseAssessment('Confidence: 8/10').confidence, 0.8);
  assert.equal(parseAssessment('Confidence: high').ok, true);
  assert.equal(parseAssessment('Confidence: high').confidence, null);
  assert.equal(parseAssessment('- rationale: no rating given').error, 'invalid');
});

test('a copied placeholder fails safe instead of passing the gate', () => {
  const copied = parseAssessment('{"confidence": <your honest rating from 0 to 1>, "complete": <true, or false if you could not finish>}');
  assert.equal(copied.ok, false);
  assert.equal(copied.confidence, null);
  const partly = parseAssessment('{\n  "confidence": 0.85,\n  "rationale": "<one sentence>",\n  "complete": <true, or false if you could not finish>\n}');
  assert.equal(partly.confidence, 0.85);
  assert.equal(partly.complete, null);
});

test('removes reasoning blocks from local models', () => {
  assert.equal(stripThinking('<think>plan</think>\nStory'), 'Story');
  assert.equal(stripThinking('Story<think>unfinished'), 'Story');
  assert.equal(stripThinking('reasoning without an opening tag</think>\n\nStory'), 'Story');
  const { artifact } = splitResponse(`<think>{"confidence": 1}</think>${respond('Real text.', { confidence: 0.6 })}`);
  assert.equal(artifact, 'Real text.');
});

test('hides the assessment while a response is streaming', () => {
  assert.equal(visibleArtifact('Story so far.\n\n### AUTHOR STUDIO ASS'), 'Story so far.');
  assert.equal(visibleArtifact(`Story.\n\n${ASSESSMENT_HEADING}\n\`\`\`json\n{"conf`), 'Story.');
  assert.equal(visibleArtifact('A line\nA'), 'A line\nA');
  assert.equal(visibleArtifact('<think>hmm</think>Visible'), 'Visible');
});

test('extracts the first balanced JSON object, honoring strings', () => {
  assert.deepEqual(extractJsonObject('text {"a": "}", "b": {"c": 1}} trailing'), { a: '}', b: { c: 1 } });
  assert.equal(extractJsonObject('no json'), undefined);
  assert.equal(extractJsonObject('[1, 2]'), undefined);
});

test('counts words across languages and punctuation', () => {
  assert.equal(countWords("It's a well-known café, isn't it?"), 6);
  assert.equal(countWords(''), 0);
  assert.equal(countWords('Ünïcödé wörds 123'), 3);
});

test('reads ratings written as percentages, out-of-100 numbers, or "x/10"', () => {
  assert.equal(toConfidence('85%'), 0.85);
  assert.equal(toConfidence(85), 0.85);
  assert.equal(toConfidence('8/10'), 0.8);
  assert.equal(toConfidence('0.7'), 0.7);
  assert.equal(toConfidence(1.5), null);
});

test('finds ratings under other key casings, nesting, and "Confidence Score" lines', () => {
  const heading = '## Author Studio Assessment';
  for (const body of [
    '```json\n{"Confidence": "85%", "complete": true}\n```',
    '```json\n{"assessment": {"confidence": 0.85, "complete": true}}\n```',
    '**Confidence Score:** 85%\n**Complete:** yes',
  ]) {
    const split = splitResponse(`Story.\n\n${heading}\n${body}`);
    assert.equal(split.artifact, 'Story.');
    assert.equal(parseAssessment(split.assessmentText).confidence, 0.85, body);
  }
});

test('a trailing JSON block with assessment keys but no rating is kept out of the artifact', () => {
  const split = splitResponse('Story.\n\n```json\n{"rationale": "ok", "proposed_changes": {"plot": {}}}\n```');
  assert.equal(split.artifact, 'Story.');
  assert.equal(parseAssessment(split.assessmentText).confidence, null);
});
