import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { inlineText, markdownToText, parseInline, parseMarkdown } from '../src/core/markdown.js';
import { createDocx, paperForCountry, zip } from '../src/main/docx.js';
import { exportMarkdown } from '../src/core/exports.js';
import { template } from './helpers.mjs';

test('parses headings, verse line breaks, lists, quotes, rules, tables, and code', () => {
  const blocks = parseMarkdown('# Title\n\nRoses are red,\nviolets are blue.\n\n- one\n  - two\n3. three\n\n> quoted\n\n* * *\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```\nx < y\n```');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'table', 'code']);
  assert.equal(blocks[1].lines.length, 2, 'single newlines stay as line breaks');
  assert.equal(blocks[2].items[0].children[0].type, 'list');
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[6].align, ['left', 'right']);
  assert.equal(blocks[7].text, 'x < y');
});

test('parses emphasis without breaking words or escapes', () => {
  assert.deepEqual(parseInline('snake_case_name').map((node) => node.type), ['text']);
  const nodes = parseInline('***both*** **bold** *it* _also_ ~~gone~~ `code` [link](https://x.y) \\*not\\*');
  assert.deepEqual(nodes.filter((node) => node.type !== 'text').map((node) => node.type), ['strong', 'strong', 'em', 'em', 'strike', 'code', 'link']);
  assert.match(inlineText(nodes), /\*not\*$/);
  assert.equal(inlineText(parseInline('**unclosed')), '**unclosed');
});

test('deeply nested markup is bounded', () => {
  const deep = `${'> '.repeat(50)}deep`;
  assert.doesNotThrow(() => parseMarkdown(deep));
  const inline = `${'*'.repeat(200)}x${'*'.repeat(200)}`;
  assert.doesNotThrow(() => parseInline(inline));
});

test('converts Markdown to plain text for export', () => {
  const text = markdownToText('# Title\n\nA *b* **c**\n\n- x\n\n***\n\nend');
  assert.equal(text, 'Title\n\nA b c\n\n• x\n\n* * *\n\nend\n');
});

function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + size);
    entries.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory follows the entries');
  return entries;
}

test('zip writes entries that inflate back to the input', () => {
  const entries = readZip(zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: '<x/>'.repeat(100) }], new Date(2026, 0, 2)));
  assert.equal(entries.get('a.txt'), 'hello');
  assert.equal(entries.get('dir/b.xml'), '<x/>'.repeat(100));
});

test('creates a Word manuscript with chapters, scene breaks, and escaped text', () => {
  const docx = createDocx('# Bread & Bones\n\n## Chapter 1\n\nShe said "<hello>".\n\n* * *\n\nAfter.\n', { title: 'Bread & Bones', paper: 'a4' });
  const entries = readZip(docx);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'docProps/core.xml']) assert.ok(entries.has(name), name);
  const document = entries.get('word/document.xml');
  assert.match(document, /Bread &amp; Bones/);
  assert.match(document, /She said &quot;&lt;hello&gt;&quot;\./);
  assert.match(document, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(document, /<w:t[^>]*>#<\/w:t>/);
  assert.match(entries.get('docProps/core.xml'), /<dc:title>Bread &amp; Bones<\/dc:title>/);
  assert.match(createDocx('Hi').subarray(0, 4).toString('latin1'), /^PK/);
});

test('picks Letter paper for North America and A4 elsewhere', () => {
  assert.equal(paperForCountry('US'), 'letter');
  assert.equal(paperForCountry('ca'), 'letter');
  assert.equal(paperForCountry('GB'), 'a4');
  assert.equal(paperForCountry(''), 'a4');
});

test('planning packet Word export contains canon, full research, references, and no unapproved text', () => {
  const state = structuredClone(template);
  state.project.title = 'Research & plans';
  state.project.concept = 'A lost letter';
  state.characters = [{ name: 'Ada', role: 'Detective', arc_stage: 'Searching', voice_notes: 'Precise' }];
  const project = {
    state,
    artifacts: {
      'research-1': { id: 'research-1', type: 'research', status: 'accepted', content: '## Postal history\n\nA **sealed letter**.\n\nSource: [Archive](https://example.com/archive)\n\nUncertainty: check the date.' },
      'research-2': { id: 'research-2', type: 'research', status: 'pending', content: 'Unapproved secret' },
    },
  };
  const entries = readZip(createDocx(exportMarkdown(project, 'planning')));
  const document = entries.get('word/document.xml');
  for (const text of ['Research &amp; plans', 'A lost letter', 'Ada', 'Detective', 'Postal history', 'sealed letter', 'Archive', 'Uncertainty: check the date.']) assert.ok(document.includes(text), text);
  assert.ok(document.includes('https://example.com/archive'));
  assert.doesNotMatch(document, /Unapproved secret|No accepted chapters/);
});

test('planning plain text keeps reference URLs in paragraphs, lists, quotes, and tables', () => {
  const markdown = '# [Heading](https://example.com/heading)\n\nSource: **[Archive](https://example.com/archive)**\n\n- [List](https://example.com/list)\n\n> [Quote](https://example.com/quote)\n\n| Source |\n| --- |\n| [Table](https://example.com/table) |';
  const text = markdownToText(markdown, { includeLinks: true });
  for (const key of ['heading', 'archive', 'list', 'quote', 'table']) assert.ok(text.includes(`https://example.com/${key}`), key);
  assert.doesNotMatch(markdownToText(markdown), /https:/, 'default manuscript conversion remains unchanged');
});
