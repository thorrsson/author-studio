// Modals, confirmations, toasts, and error messages.
import { h } from './dom.js';
import { actions } from './store.js';

const stack = [];
let counter = 0;

function syncInert() {
  const app = document.getElementById('app');
  if (app) app.inert = stack.length > 0;
  stack.forEach((modal, index) => {
    modal.overlay.inert = index !== stack.length - 1;
  });
}

document.addEventListener('keydown', (event) => {
  const top = stack.at(-1);
  if (event.key === 'Escape' && top) {
    event.preventDefault();
    if (top.dismissable) top.close();
  }
});

export function openModal({ title, content = [], actions: buttons = [], size = 'medium', onClose, dismissable = true, className } = {}) {
  const previous = document.activeElement;
  const titleId = `modal-title-${++counter}`;
  const body = h('div', { class: 'modal-body' }, content);
  const footer = h('div', { class: 'modal-footer' });
  const closeButton = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => modal.dismissable && modal.close() }, '×');
  const titleElement = h('h2', { id: titleId }, title);
  const dialog = h(
    'div',
    { class: ['modal', `modal-${size}`, className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'modal-header' }, titleElement, dismissable ? closeButton : null),
    body,
    footer,
  );
  const overlay = h('div', { class: 'modal-overlay' }, dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && modal.dismissable) modal.close();
  });
  let closed = false;
  const modal = {
    overlay,
    element: dialog,
    body,
    footer,
    dismissable,
    get closed() {
      return closed;
    },
    setTitle(text) {
      titleElement.textContent = text;
    },
    setContent(...children) {
      body.replaceChildren(...children.flat().filter(Boolean));
    },
    setActions(list) {
      footer.replaceChildren(...list.filter(Boolean));
      footer.hidden = !list.filter(Boolean).length;
    },
    setBusy(busy) {
      dialog.classList.toggle('is-busy', busy);
      modal.dismissable = !busy && dismissable;
      closeButton.disabled = busy;
    },
    close(result) {
      if (closed) return;
      closed = true;
      overlay.remove();
      stack.splice(stack.indexOf(modal), 1);
      syncInert();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      onClose?.(result);
    },
  };
  modal.setActions(buttons);
  document.getElementById('modal-root').append(overlay);
  stack.push(modal);
  syncInert();
  requestAnimationFrame(() => {
    const target = dialog.querySelector('[autofocus]') ?? dialog.querySelector('input:not([type=hidden]), textarea, select') ?? dialog.querySelector('.modal-footer .primary') ?? dialog;
    if (target === dialog) dialog.tabIndex = -1;
    target.focus();
  });
  return modal;
}

export function closeAllModals() {
  for (const modal of [...stack].reverse()) modal.close();
}

export function confirmDialog({ title, message, details = [], confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const modal = openModal({
      title,
      size: 'small',
      content: [
        message ? h('p', null, message) : null,
        details.length ? h('ul', { class: 'plain-list' }, details.map((item) => h('li', null, item))) : null,
      ],
      onClose: () => resolve(confirmed),
    });
    modal.setActions([
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, cancelLabel),
      h('button', {
        class: ['btn', danger ? 'danger' : 'primary'],
        type: 'button',
        autofocus: !danger,
        onclick: () => {
          confirmed = true;
          modal.close();
        },
      }, confirmLabel),
    ]);
  });
}

export function toast(message, { kind = 'info', action, timeout } = {}) {
  const root = document.getElementById('toasts');
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    item.remove();
  };
  const item = h(
    'div',
    { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-message' }, message),
    action ? h('button', { class: 'btn small', type: 'button', onclick: () => { dismiss(); action.run(); } }, action.label) : null,
    h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, '×'),
  );
  root.append(item);
  while (root.children.length > 3) root.firstElementChild.remove();
  const ms = timeout ?? (kind === 'error' ? 14000 : 6000);
  const start = () => {
    if (ms) timer = setTimeout(dismiss, ms);
  };
  item.addEventListener('mouseenter', () => clearTimeout(timer));
  item.addEventListener('mouseleave', start);
  start();
  return dismiss;
}

const SETTINGS_CODES = new Set(['no-connection', 'no-key', 'auth', 'forbidden', 'model-not-found', 'unsupported-model', 'quota', 'not-found', 'too-long', 'too-large']);

export function showError(error) {
  const message = error?.message || String(error ?? 'Something went wrong.');
  if (error?.code === 'cancelled') {
    toast(message, { kind: 'info' });
    return;
  }
  const action = SETTINGS_CODES.has(error?.code) ? { label: 'Open Settings', run: () => actions.navigate({ name: 'settings' }) } : undefined;
  toast(message, { kind: 'error', action });
}

// Runs an async action with a button showing progress, reporting errors.
export async function withBusy(button, task) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.classList.add('is-busy');
  }
  try {
    return await task();
  } catch (error) {
    showError(error);
    return undefined;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.textContent = label;
    }
  }
}
