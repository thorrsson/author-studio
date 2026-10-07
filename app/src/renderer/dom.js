// DOM helpers. All text goes in through text nodes, never innerHTML, so model
// output and file contents cannot inject markup.

const BOOLEAN_PROPS = new Set(['checked', 'disabled', 'selected', 'open', 'hidden', 'required', 'readOnly', 'multiple', 'autofocus']);

function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    element.append(child instanceof Node ? child : String(child));
  }
}

export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  let value;
  for (const [key, item] of Object.entries(props ?? {})) {
    if (item === undefined || item === null || item === false) continue;
    if (key === 'class') element.className = Array.isArray(item) ? item.filter(Boolean).join(' ') : item;
    else if (key === 'value') value = item;
    else if (key === 'dataset') Object.assign(element.dataset, item);
    else if (key.startsWith('on') && typeof item === 'function') element.addEventListener(key.slice(2), item);
    else if (BOOLEAN_PROPS.has(key)) element[key] = Boolean(item);
    else element.setAttribute(key, item === true ? '' : String(item));
  }
  append(element, children);
  if (value !== undefined) element.value = value;
  return element;
}

export function plural(count, one, many = `${one}s`) {
  return `${Number(count).toLocaleString()} ${count === 1 ? one : many}`;
}

export function timeAgo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes <= 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 22) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function formatDateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function countWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

// Remembers focus and caret position across a re-render by data-key.
export function preserveFocus(render) {
  const active = document.activeElement;
  const key = active?.dataset?.key;
  const selection = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = key && typeof active.scrollTop === 'number' ? active.scrollTop : 0;
  render();
  if (!key) return;
  const next = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (selection && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(...selection);
    } catch {
      // Some input types do not support selection.
    }
  }
  next.scrollTop = scroll;
}
