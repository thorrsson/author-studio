// Settings: AI model connections, reviewers, writing style, appearance, and
// privacy. API keys are sent to the main process and never come back.
import { addressOrigin } from '../../core/address.js';
import { call } from '../api.js';
import { h, preserveFocus } from '../dom.js';
import { actions, state } from '../store.js';
import { confirmDialog, openModal, showError, toast, withBusy } from '../ui.js';

const TYPE_ORDER = ['anthropic', 'openai', 'compatible', 'apple'];

const TYPE_INFO = {
  anthropic: {
    blurb: 'Claude models from Anthropic. Strong at long-form fiction. You need an API key, and Anthropic bills you for what you use.',
    badge: 'Cloud',
  },
  openai: {
    blurb: 'GPT models from OpenAI. You need an API key, and OpenAI bills you for what you use.',
    badge: 'Cloud',
  },
  compatible: {
    blurb: 'A model you run yourself with Ollama, LM Studio, llama.cpp, or another OpenAI-compatible server, on this computer or one on your network. Private and free to use; quality depends on the model.',
    badge: 'Private',
  },
  apple: {
    blurb: 'The model built into this Mac. Private and free, but small: good for brainstorming, planning, and short scenes rather than full chapters.',
    badge: 'Private',
  },
};

const SERVER_HINTS = {
  ollama: 'Ollama uses the size Author Studio sends, so you can raise this if your computer has enough memory.',
  lmstudio: 'Match the context length you chose when loading the model in LM Studio.',
  llamacpp: 'Match the --ctx-size setting the server was started with.',
  generic: 'Check your server\'s settings for its context length.',
};

const TEMPERATURES = [
  { value: '', label: 'Model default' },
  { value: '0.3', label: 'Focused and consistent' },
  { value: '0.7', label: 'Balanced' },
  { value: '1', label: 'Adventurous' },
];

export function availableTypes() {
  return TYPE_ORDER.filter((type) => !(state.settings.connectionTypes[type]?.macOnly && state.info.platform !== 'darwin'));
}

export function typeCards(onPick) {
  return h('div', { class: 'type-grid' }, availableTypes().map((type) => {
    const info = state.settings.connectionTypes[type];
    const extra = TYPE_INFO[type];
    return h(
      'button',
      { class: 'type-card', type: 'button', dataset: { type }, onclick: () => onPick(type) },
      h('span', { class: 'type-card-head' }, h('span', { class: 'type-card-title' }, info.name), h('span', { class: ['badge', extra.badge === 'Private' ? 'badge-success' : 'badge-info'] }, extra.badge)),
      h('span', { class: 'type-card-text' }, extra.blurb),
    );
  }));
}

export function chooseConnectionType() {
  const modal = openModal({
    title: 'Add an AI model',
    size: 'large',
    content: [
      h('p', { class: 'muted' }, 'Choose where your writing partner runs. You can add several and switch between them at any time.'),
      typeCards((type) => {
        modal.close();
        openConnectionEditor({ type });
      }),
    ],
  });
}

function field(label, control, hint, { id } = {}) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

function externalLink(label, url) {
  return h('button', { class: 'link-button', type: 'button', onclick: () => call('app:openExternal', { url }).catch(showError) }, label);
}

export function openConnectionEditor({ type, connection } = {}) {
  const existing = connection ?? null;
  const kind = existing?.type ?? type;
  const info = state.settings.connectionTypes[kind];
  const form = {
    id: existing?.id,
    name: existing?.name ?? '',
    model: existing?.model ?? '',
    baseUrl: existing?.baseUrl ?? '',
    server: existing?.server ?? (kind === 'compatible' ? 'ollama' : undefined),
    contextWindow: existing?.contextWindow ?? '',
    matureThemes: existing?.matureThemes ?? true,
    maxOutputTokens: existing?.maxOutputTokens ?? '',
    apiKey: '',
    removeKey: false,
    showKey: false,
  };
  if (kind === 'compatible' && !existing) {
    const preset = info.presets.find((item) => item.id === form.server);
    form.baseUrl = preset?.baseUrl ?? '';
    form.contextWindow = preset?.contextWindow ?? '';
  }
  let models = existing?.model && kind !== 'apple' ? [{ id: existing.model, name: existing.model }] : [];
  let modelsLoaded = false;
  let modelsError = '';
  let customModel = false;
  let loading = false;
  let testing = false;
  let testResult = null;
  let appleStatus = null;
  let formError = '';

  const modal = openModal({ title: existing ? `Edit ${existing.name}` : kind === 'compatible' ? 'Connect a local or network server' : `Connect ${info.short}`, size: 'medium' });

  const hasSavedKey = () => Boolean(existing?.hasKey) && !form.removeKey;

  function draftConnection() {
    const draft = { type: kind, name: form.name, model: kind === 'apple' ? 'apple-on-device' : form.model };
    if (form.id) draft.id = form.id;
    if (kind === 'compatible') Object.assign(draft, { baseUrl: form.baseUrl, server: form.server, contextWindow: form.contextWindow || undefined });
    if (kind === 'apple') draft.matureThemes = form.matureThemes;
    if (form.maxOutputTokens) draft.maxOutputTokens = form.maxOutputTokens;
    return draft;
  }

  function keyArg() {
    if (form.apiKey.trim()) return form.apiKey.trim();
    if (form.removeKey) return '';
    return undefined;
  }

  async function loadModels({ quiet = false } = {}) {
    if (info.needsKey && !form.apiKey.trim() && !hasSavedKey()) {
      if (!quiet) {
        modelsError = 'Enter your API key first.';
        render();
      }
      return;
    }
    if (kind === 'compatible' && !form.baseUrl.trim()) {
      modelsError = 'Enter the server address first.';
      render();
      return;
    }
    loading = true;
    modelsError = '';
    render();
    try {
      const result = await call('providers:listModels', { connection: draftConnection(), apiKey: form.apiKey.trim() || undefined });
      models = result.models;
      modelsLoaded = true;
      if (kind === 'compatible') {
        form.baseUrl = result.baseUrl;
        form.server = result.server;
      }
      if (!models.some((item) => item.id === form.model)) form.model = result.defaultModel || models[0]?.id || '';
      const chosen = models.find((item) => item.id === form.model);
      if (kind === 'compatible' && chosen?.contextWindow) form.contextWindow = chosen.contextWindow;
      customModel = false;
      if (!models.length) modelsError = kind === 'compatible' ? 'The server is running but has no models. Download one with your server software first.' : 'No models were found for this account.';
    } catch (error) {
      modelsError = error.message;
      if (!models.length) customModel = true;
    } finally {
      loading = false;
      if (!modal.closed) render();
    }
  }

  async function runTest() {
    formError = '';
    if (kind !== 'apple' && !form.model) {
      testResult = { ok: false, text: 'Choose a model first.' };
      render();
      return;
    }
    testing = true;
    testResult = null;
    render();
    try {
      const result = await call('providers:test', { connection: draftConnection(), apiKey: form.apiKey.trim() || undefined });
      const seconds = (result.ms / 1000).toFixed(1);
      testResult = { ok: true, text: result.reply ? `Connected. The model replied "${result.reply.slice(0, 80)}" in ${seconds} s.` : `Connected in ${seconds} s.` };
    } catch (error) {
      testResult = { ok: false, text: error.message };
    } finally {
      testing = false;
      if (!modal.closed) render();
    }
  }

  async function save(button) {
    formError = '';
    if (info.needsKey && !form.apiKey.trim() && !hasSavedKey()) formError = 'Enter your API key.';
    else if (kind === 'compatible' && !form.baseUrl.trim()) formError = 'Enter the server address.';
    else if (kind !== 'apple' && !form.model.trim()) formError = 'Choose a model.';
    if (formError) {
      render();
      return;
    }
    await withBusy(button, async () => {
      const result = await call('settings:saveConnection', { connection: draftConnection(), apiKey: keyArg() });
      actions.setSettings(result.settings);
      modal.close();
      toast(`${result.saved.name} is ready to use.`, { kind: 'success' });
    });
  }

  function modelControl() {
    if (kind === 'apple') return null;
    const showSelect = models.length > 0 && !customModel;
    const control = showSelect
      ? h('select', {
        id: 'connection-model',
        dataset: { key: 'connection-model' },
        value: form.model,
        onchange: (event) => {
          if (event.target.value === '__custom') {
            customModel = true;
            render();
            return;
          }
          form.model = event.target.value;
          const chosen = models.find((item) => item.id === form.model);
          if (kind === 'compatible' && chosen?.contextWindow) {
            form.contextWindow = chosen.contextWindow;
            render();
          }
        },
      }, models.map((item) => h('option', { value: item.id }, item.name && item.name !== item.id ? `${item.name} (${item.id})` : item.id)), h('option', { value: '__custom' }, 'Type a model name…'))
      : h('input', {
        id: 'connection-model',
        dataset: { key: 'connection-model' },
        type: 'text',
        value: form.model,
        placeholder: kind === 'anthropic' ? 'claude-sonnet-4-5' : kind === 'openai' ? 'gpt-5' : 'llama3.1',
        spellcheck: 'false',
        oninput: (event) => {
          form.model = event.target.value.trim();
        },
      });
    const refresh = h('button', { class: 'btn', type: 'button', disabled: loading, onclick: () => loadModels() }, loading ? 'Looking…' : modelsLoaded ? 'Refresh list' : 'Find models');
    const hint = modelsError
      ? h('p', { class: 'hint error-text' }, modelsError)
      : h('p', { class: 'hint' }, loading ? 'Asking for the list of models…' : kind === 'compatible' ? 'Models your server has downloaded.' : 'Newer, larger models write better but cost more per use.');
    return h('div', { class: 'field' }, h('label', { for: 'connection-model' }, 'Model'), h('div', { class: 'input-row' }, control, refresh), hint);
  }

  function keyControl() {
    if (!info.needsKey && kind !== 'compatible') return null;
    const savedKey = hasSavedKey();
    const keyStaysBehind = savedKey && kind === 'compatible' && addressOrigin(form.baseUrl) !== addressOrigin(existing.baseUrl);
    const placeholder = keyStaysBehind
      ? 'Enter the key again for this address'
      : savedKey ? `Saved key ${existing.keyHint || ''} (leave blank to keep it)` : info.keyHint ?? (kind === 'compatible' ? 'Only if your server requires one' : '');
    const input = h('input', {
      id: 'connection-key',
      dataset: { key: 'connection-key' },
      type: form.showKey ? 'text' : 'password',
      value: form.apiKey,
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
      oninput: (event) => {
        form.apiKey = event.target.value;
      },
      onchange: () => {
        if (form.apiKey.trim() && info.needsKey && !modelsLoaded) loadModels({ quiet: true });
      },
    });
    const toggle = h('button', { class: 'btn', type: 'button', onclick: () => { form.showKey = !form.showKey; render(); } }, form.showKey ? 'Hide' : 'Show');
    const hints = [];
    if (info.keyUrl) hints.push(h('span', null, 'Create a key at '), externalLink(new URL(info.keyUrl).hostname, info.keyUrl), h('span', null, '. '));
    hints.push(h('span', null, state.settings.keyStorage.mode === 'encrypted' ? 'Keys are stored encrypted on this computer.' : state.settings.keyStorage.message));
    if (keyStaysBehind) {
      hints.push(' ', h('span', null, `The saved key is only sent to ${addressOrigin(existing.baseUrl)}, so enter it again if this server needs one.`));
    } else if (savedKey) {
      hints.push(' ', h('button', { class: 'link-button danger-text', type: 'button', onclick: () => { form.removeKey = true; form.apiKey = ''; render(); } }, 'Remove saved key'));
    }
    return h('div', { class: 'field' }, h('label', { for: 'connection-key' }, kind === 'compatible' ? 'API key (optional)' : 'API key'), h('div', { class: 'input-row' }, input, toggle), h('p', { class: 'hint' }, hints));
  }

  function serverControls() {
    if (kind !== 'compatible') return [];
    const presets = [...info.presets, { id: 'generic', name: 'Other', baseUrl: '', contextWindow: 8192 }];
    const presetUrls = new Set(info.presets.map((item) => item.baseUrl));
    return [
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'server-kind-label' }, 'Server software'),
        h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'server-kind-label' }, presets.map((preset) => h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(form.server === preset.id),
          class: ['segment', form.server === preset.id && 'is-selected'],
          onclick: () => {
            form.server = preset.id;
            if (preset.baseUrl && (!form.baseUrl || presetUrls.has(form.baseUrl))) form.baseUrl = preset.baseUrl;
            if (!modelsLoaded) form.contextWindow = preset.contextWindow;
            render();
          },
        }, preset.name)))),
      field('Server address', h('div', { class: 'input-row' },
        h('input', {
          id: 'connection-url',
          dataset: { key: 'connection-url' },
          type: 'text',
          value: form.baseUrl,
          placeholder: 'http://localhost:11434',
          spellcheck: 'false',
          oninput: (event) => {
            form.baseUrl = event.target.value;
          },
          onchange: () => {
            if (form.baseUrl.trim()) loadModels({ quiet: true });
          },
        })), 'For a server on another computer, use that computer\'s network address, such as http://192.168.1.20:11434. The server must accept connections from your network.', { id: 'connection-url' }),
    ];
  }

  function contextControl() {
    if (kind !== 'compatible') return null;
    return field('Context window (tokens)', h('input', {
      id: 'connection-context',
      dataset: { key: 'connection-context' },
      type: 'number',
      min: '2048',
      step: '1024',
      value: form.contextWindow,
      oninput: (event) => {
        form.contextWindow = event.target.value ? Number(event.target.value) : '';
      },
    }), `How much text the model can read at once. Author Studio fits each request into this space. ${SERVER_HINTS[form.server] ?? SERVER_HINTS.generic}`, { id: 'connection-context' });
  }

  function appleControls() {
    if (kind !== 'apple') return [];
    const status = appleStatus
      ? h('div', { class: ['callout', appleStatus.available ? 'callout-success' : 'callout-warning'] }, appleStatus.message)
      : h('div', { class: 'callout' }, 'Checking Apple Intelligence…');
    return [
      status,
      h('p', { class: 'muted' }, 'Apple Intelligence runs privately on this Mac at no cost. It is a small model that reads about 3,000 words at a time, so Author Studio gives it shorter instructions and less of your story at once. Expect simpler writing and more steps that need your review. For full chapters, use Claude, GPT, or a larger local model.'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: form.matureThemes, onchange: (event) => { form.matureThemes = event.target.checked; } }),
        h('span', null, h('strong', null, 'Allow mature themes. '), 'Uses Apple\'s less restrictive content filter so the model can write crime, conflict, and other dark material that much fiction needs. Apple Intelligence may still decline some requests.')),
    ];
  }

  function advanced() {
    return h('details', { class: 'advanced' },
      h('summary', null, 'Advanced'),
      field('Display name', h('input', {
        id: 'connection-name',
        dataset: { key: 'connection-name' },
        type: 'text',
        value: form.name,
        placeholder: info.short,
        maxlength: '60',
        oninput: (event) => {
          form.name = event.target.value;
        },
      }), 'The name shown in menus. Useful when you connect more than one model of the same kind.', { id: 'connection-name' }),
      kind === 'apple' ? null : field('Longest response (tokens)', h('input', {
        id: 'connection-max',
        dataset: { key: 'connection-max' },
        type: 'number',
        min: '256',
        step: '256',
        value: form.maxOutputTokens,
        placeholder: 'Automatic',
        oninput: (event) => {
          form.maxOutputTokens = event.target.value ? Number(event.target.value) : '';
        },
      }), 'Leave blank unless a model cuts off chapters early or rejects long responses. About 1,300 tokens make 1,000 words.', { id: 'connection-max' }));
  }

  function render() {
    preserveFocus(() => {
      modal.setContent(
        h('p', { class: 'muted' }, TYPE_INFO[kind].blurb),
        ...serverControls(),
        keyControl(),
        modelControl(),
        contextControl(),
        ...appleControls(),
        advanced(),
        testResult ? h('div', { class: ['callout', testResult.ok ? 'callout-success' : 'callout-error'], role: 'status' }, testResult.text) : null,
        formError ? h('div', { class: 'callout callout-error', role: 'alert' }, formError) : null,
      );
      const saveButton = h('button', { class: 'btn primary', type: 'button', onclick: (event) => save(event.currentTarget) }, existing ? 'Save changes' : 'Save');
      modal.setActions([
        h('button', { class: 'btn', type: 'button', disabled: testing, onclick: runTest }, testing ? 'Testing…' : 'Test connection'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        saveButton,
      ]);
    });
  }

  render();
  if (kind === 'apple') {
    call('providers:appleStatus', { refresh: true }).then((status) => {
      appleStatus = status;
      if (!modal.closed) render();
    }).catch((error) => {
      appleStatus = { available: false, message: error.message };
      if (!modal.closed) render();
    });
  } else if (existing && (existing.hasKey || !info.needsKey)) {
    loadModels({ quiet: true });
  }
}

function connectionRow(connection) {
  const settings = state.settings;
  const info = settings.connectionTypes[connection.type];
  const isDefault = settings.activeConnectionId === connection.id;
  const details = [info.name];
  if (connection.type !== 'apple') details.push(connection.model);
  if (connection.type === 'compatible') details.push(connection.baseUrl);
  if (info.needsKey) details.push(connection.hasKey ? `key ${connection.keyHint || 'saved'}` : 'no key saved');
  return h('li', { class: 'connection-row', dataset: { id: connection.id } },
    h('div', { class: 'connection-main' },
      h('div', { class: 'connection-name' }, connection.name, isDefault ? h('span', { class: 'badge badge-accent' }, 'Default') : null),
      h('div', { class: 'connection-details muted' }, details.filter(Boolean).join(' · ')),
      info.needsKey && !connection.hasKey ? h('div', { class: 'error-text small' }, 'Add an API key to use this model.') : null),
    h('div', { class: 'connection-actions' },
      isDefault ? null : h('button', { class: 'btn small', type: 'button', onclick: (event) => withBusy(event.currentTarget, async () => {
        actions.setSettings(await call('settings:update', { activeConnectionId: connection.id }));
      }) }, 'Make default'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openConnectionEditor({ connection }) }, 'Edit'),
      h('button', { class: 'btn small ghost danger-text', type: 'button', onclick: async (event) => {
        const button = event.currentTarget;
        if (!await confirmDialog({ title: `Remove ${connection.name}?`, message: 'Its saved API key is deleted too. Your projects are not affected.', confirmLabel: 'Remove', danger: true })) return;
        await withBusy(button, async () => actions.setSettings(await call('settings:deleteConnection', { id: connection.id })));
      } }, 'Remove')));
}

function section(title, description, ...content) {
  return h('section', { class: 'settings-section' }, h('h2', null, title), description ? h('p', { class: 'muted' }, description) : null, content);
}

function connectionOptions(selected, { none = 'None' } = {}) {
  return [
    h('option', { value: '' }, none),
    ...state.settings.connections.map((item) => h('option', { value: item.id, selected: item.id === selected }, item.label)),
  ];
}

async function updateSettings(patch) {
  try {
    actions.setSettings(await call('settings:update', patch));
  } catch (error) {
    showError(error);
    actions.render();
  }
}

export function renderSettings() {
  const settings = state.settings;
  const { reviewers } = settings;
  const sameReviewers = reviewers.a && reviewers.a === reviewers.b;
  const temperature = settings.temperature === null ? '' : String(settings.temperature);
  const keyMode = settings.keyStorage.mode;
  return h('div', { class: 'page settings-page' },
    h('header', { class: 'page-header' }, h('h1', null, 'Settings')),
    section(
      'AI models',
      'Your story material is sent only to the model you are using. The default model runs each step; you can switch it here or at the bottom of the sidebar.',
      settings.connections.length
        ? h('ul', { class: 'connection-list' }, settings.connections.map(connectionRow))
        : h('div', { class: 'callout' }, 'No AI model is connected yet.'),
      h('div', { class: 'button-row' }, h('button', { class: 'btn primary', type: 'button', onclick: chooseConnectionType }, 'Add a model')),
    ),
    section(
      'Second opinions',
      'A second opinion asks two models to review a piece independently, then your default model combines their reports. Reviews never change your story; you decide what to do with them.',
      h('div', { class: 'two-col' },
        field('Reviewer A', h('select', { id: 'reviewer-a', onchange: (event) => updateSettings({ reviewers: { a: event.target.value || null, b: reviewers.b } }) }, connectionOptions(reviewers.a)), null, { id: 'reviewer-a' }),
        field('Reviewer B', h('select', { id: 'reviewer-b', onchange: (event) => updateSettings({ reviewers: { a: reviewers.a, b: event.target.value || null } }) }, connectionOptions(reviewers.b)), null, { id: 'reviewer-b' })),
      sameReviewers ? h('p', { class: 'hint error-text' }, 'Choose two different models to get two independent opinions.') : null,
    ),
    section(
      'Writing style',
      'How much the model varies its word choices. Some models ignore this setting.',
      field('Creativity', h('select', { id: 'temperature', onchange: (event) => updateSettings({ temperature: event.target.value === '' ? null : Number(event.target.value) }) },
        TEMPERATURES.map((item) => h('option', { value: item.value, selected: item.value === temperature }, item.label)),
        TEMPERATURES.some((item) => item.value === temperature) ? null : h('option', { value: temperature, selected: true }, `Custom (${temperature})`)), null, { id: 'temperature' }),
    ),
    section(
      'Appearance',
      null,
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(settings.theme === value),
        class: ['segment', settings.theme === value && 'is-selected'],
        onclick: () => updateSettings({ theme: value }),
      }, label))),
    ),
    section(
      'Privacy and files',
      null,
      h('div', { class: ['callout', keyMode === 'encrypted' ? 'callout-success' : 'callout-warning'] }, settings.keyStorage.message),
      h('p', null, 'Projects are saved on this computer and backed up automatically before each change. Author Studio sends text only to the AI model you choose, and only when you run a step.'),
      h('p', { class: 'muted small selectable' }, `Data folder: ${state.info.dataPath}`),
      h('div', { class: 'button-row' }, h('button', { class: 'btn', type: 'button', onclick: (event) => withBusy(event.currentTarget, () => call('app:openDataFolder')) }, 'Show projects folder')),
      h('p', { class: 'muted small' }, `Author Studio ${state.info.version}`),
    ),
  );
}
