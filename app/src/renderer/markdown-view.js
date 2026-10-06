// Renders Markdown from models and authors as DOM nodes.
import { parseMarkdown } from '../core/markdown.js';
import { h } from './dom.js';

function inline(nodes) {
  return nodes.map((node) => {
    switch (node.type) {
      case 'strong':
        return h('strong', null, inline(node.children));
      case 'em':
        return h('em', null, inline(node.children));
      case 'strike':
        return h('s', null, inline(node.children));
      case 'code':
        return h('code', null, node.text);
      case 'link':
        // Links from model output are shown, not followed.
        return h('span', { class: 'md-link', title: node.href }, inline(node.children));
      case 'break':
        return h('br');
      default:
        return document.createTextNode(node.text ?? '');
    }
  });
}

function lines(list) {
  const output = [];
  list.forEach((line, index) => {
    if (index) output.push(h('br'));
    output.push(...inline(line));
  });
  return output;
}

function alignClass(align) {
  return align ? `align-${align}` : null;
}

function blocks(list) {
  return list.map((block) => {
    switch (block.type) {
      case 'heading':
        return h(`h${Math.min(6, Math.max(1, block.level))}`, null, inline(block.inline));
      case 'paragraph':
        return h('p', null, lines(block.lines));
      case 'list':
        return h(
          block.ordered ? 'ol' : 'ul',
          block.ordered && block.start !== 1 ? { start: block.start } : null,
          block.items.map((item) => h('li', null, lines(item.lines), blocks(item.children))),
        );
      case 'quote':
        return h('blockquote', null, blocks(block.blocks));
      case 'rule':
        return h('hr');
      case 'code':
        return h('pre', null, h('code', null, block.text));
      case 'table':
        return h('div', { class: 'md-table' }, h(
          'table',
          null,
          h('thead', null, h('tr', null, block.header.map((cell, index) => h('th', { class: alignClass(block.align[index]) }, inline(cell))))),
          h('tbody', null, block.rows.map((row) => h('tr', null, row.map((cell, index) => h('td', { class: alignClass(block.align[index]) }, inline(cell)))))),
        ));
      default:
        return null;
    }
  });
}

export function renderMarkdown(text, className = 'prose') {
  return h('div', { class: className }, blocks(parseMarkdown(text)));
}
