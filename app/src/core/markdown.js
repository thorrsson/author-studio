// A small Markdown parser for model output. It returns a tree of plain data,
// so the renderer can build DOM nodes with textContent (never innerHTML) and
// exporters can write other formats from the same structure.
//
// Blocks: heading {level, inline}, paragraph {lines: inline[]}, list
// {ordered, start, items: [{lines: inline[], children: block[]}]}, quote
// {blocks}, rule, code {text}, table {header: inline[], align, rows}.
// Inline: text {text}, strong/em/strike {children}, code {text},
// link {children, href}, break.

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|]/;
const MAX_DEPTH = 8;

function isSpace(char) {
  return char === undefined || /\s/.test(char);
}

function isWordChar(char) {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

// Finds the closing marker for emphasis that opens just before `from`.
function findClose(text, marker, from) {
  if (from >= text.length || isSpace(text[from])) return -1;
  for (let index = from + 1; index <= text.length - marker.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end !== -1) {
        index = end;
        continue;
      }
    }
    if (!text.startsWith(marker, index)) continue;
    if (marker.length === 1 && text[index + 1] === marker) {
      index += 1;
      continue;
    }
    if (isSpace(text[index - 1])) continue;
    if (marker[0] === '_' && isWordChar(text[index + marker.length])) continue;
    return index;
  }
  return -1;
}

export function parseInline(text, depth = 0) {
  const source = String(text ?? '');
  if (depth > MAX_DEPTH) return source ? [{ type: 'text', text: source }] : [];
  const nodes = [];
  let buffer = '';
  const flush = () => {
    if (buffer) nodes.push({ type: 'text', text: buffer });
    buffer = '';
  };
  const wrap = (type, inner) => ({ type, children: parseInline(inner, depth + 1) });
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\' && ESCAPABLE.test(source[index + 1] ?? '')) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === '`') {
      const run = /^`+/.exec(source.slice(index))[0];
      const end = source.indexOf(run, index + run.length);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'code', text: source.slice(index + run.length, end).trim() });
        index = end + run.length;
        continue;
      }
      buffer += run;
      index += run.length;
      continue;
    }
    if (source.startsWith('***', index)) {
      const end = findClose(source, '***', index + 3);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'strong', children: [wrap('em', source.slice(index + 3, end))] });
        index = end + 3;
        continue;
      }
    }
    if (source.startsWith('**', index) || (source.startsWith('__', index) && !isWordChar(source[index - 1]))) {
      const marker = source.slice(index, index + 2);
      const end = findClose(source, marker, index + 2);
      if (end !== -1) {
        flush();
        nodes.push(wrap('strong', source.slice(index + 2, end)));
        index = end + 2;
        continue;
      }
    }
    if (source.startsWith('~~', index)) {
      const end = findClose(source, '~~', index + 2);
      if (end !== -1) {
        flush();
        nodes.push(wrap('strike', source.slice(index + 2, end)));
        index = end + 2;
        continue;
      }
    }
    if ((char === '*' || (char === '_' && !isWordChar(source[index - 1]))) && source[index + 1] !== char) {
      const end = findClose(source, char, index + 1);
      if (end !== -1) {
        flush();
        nodes.push(wrap('em', source.slice(index + 1, end)));
        index = end + 1;
        continue;
      }
    }
    if (char === '[') {
      const close = source.indexOf('](', index + 1);
      const end = close === -1 ? -1 : source.indexOf(')', close + 2);
      if (close !== -1 && end !== -1 && !source.slice(index + 1, close).includes('[')) {
        flush();
        nodes.push({ type: 'link', children: parseInline(source.slice(index + 1, close), depth + 1), href: source.slice(close + 2, end).trim() });
        index = end + 1;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
}

function splitRow(row) {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableStart(line, next) {
  return line.includes('|') && next !== undefined && next.includes('-') && TABLE_SEPARATOR.test(next) && splitRow(line).length > 1;
}

function startsBlock(line, next) {
  return HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || FENCE.test(line) || LIST_ITEM.test(line) || isTableStart(line, next);
}

function parseList(lines, start, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const indent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) break;
    const level = indentOf(match[1]);
    if (level < indent) break;
    if (level > indent && items.length) {
      const nested = parseList(lines, index, depth + 1);
      items.at(-1).children.push(nested.block);
      index = nested.next;
      continue;
    }
    if (/\d/.test(match[2]) !== ordered) break;
    const item = { lines: [parseInline(match[3], depth)], children: [] };
    index += 1;
    while (index < lines.length && lines[index].trim() && !LIST_ITEM.test(lines[index]) && indentOf(lines[index]) > indent && !startsBlock(lines[index].trim(), lines[index + 1])) {
      item.lines.push(parseInline(lines[index].trim(), depth));
      index += 1;
    }
    items.push(item);
    if (index + 1 < lines.length && !lines[index].trim()) {
      const next = LIST_ITEM.exec(lines[index + 1]);
      if (next && indentOf(next[1]) >= indent) index += 1;
    }
  }
  const block = { type: 'list', ordered, items };
  if (ordered) block.start = Number.parseInt(first[2], 10);
  return { block, next: index };
}

function parseBlocks(lines, depth = 0) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence[1])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2], depth) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(lines[index].replace(/^ {0,3}>[ \t]?/, ''));
        index += 1;
      }
      blocks.push(depth < MAX_DEPTH ? { type: 'quote', blocks: parseBlocks(body, depth + 1) } : { type: 'paragraph', lines: body.map((item) => parseInline(item, depth)) });
      continue;
    }
    if (isTableStart(line, lines[index + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''));
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitRow(lines[index]);
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '', depth)));
        index += 1;
      }
      blocks.push({ type: 'table', header: header.map((cell) => parseInline(cell, depth)), align: header.map((_, column) => align[column] ?? ''), rows });
      continue;
    }
    if (LIST_ITEM.test(line) && depth < MAX_DEPTH) {
      const { block, next } = parseList(lines, index, depth);
      blocks.push(block);
      index = next;
      continue;
    }
    const body = [parseInline(line.trim(), depth)];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) {
      body.push(parseInline(lines[index].trim(), depth));
      index += 1;
    }
    blocks.push({ type: 'paragraph', lines: body });
  }
  return blocks;
}

export function parseMarkdown(source) {
  return parseBlocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

export function inlineText(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text;
    if (node.type === 'break') return '\n';
    return inlineText(node.children ?? []);
  }).join('');
}

function listLines(block, prefix) {
  const lines = [];
  block.items.forEach((item, position) => {
    const marker = block.ordered ? `${(block.start ?? 1) + position}.` : '•';
    lines.push(`${prefix}${marker} ${item.lines.map(inlineText).join(' ')}`);
    for (const child of item.children) lines.push(...listLines(child, `${prefix}    `));
  });
  return lines;
}

function textBlocks(blocks, prefix = '') {
  const out = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`${prefix}${inlineText(block.inline)}`);
        break;
      case 'paragraph':
        out.push(block.lines.map((line) => `${prefix}${inlineText(line)}`).join('\n'));
        break;
      case 'rule':
        out.push(`${prefix}* * *`);
        break;
      case 'code':
        out.push(block.text.split('\n').map((line) => `${prefix}${line}`).join('\n'));
        break;
      case 'quote':
        out.push(...textBlocks(block.blocks, `${prefix}    `));
        break;
      case 'list':
        out.push(listLines(block, prefix).join('\n'));
        break;
      case 'table':
        out.push([block.header, ...block.rows].map((row) => `${prefix}${row.map(inlineText).join('\t')}`).join('\n'));
        break;
      default:
        break;
    }
  }
  return out;
}

// Plain text with paragraphs separated by blank lines, for .txt exports.
export function markdownToText(source) {
  return `${textBlocks(parseMarkdown(source)).join('\n\n')}\n`;
}
