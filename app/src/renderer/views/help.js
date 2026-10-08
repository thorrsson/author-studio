// A short guide for people new to Author Studio and to AI models.
import { call } from '../api.js';
import { h } from '../dom.js';
import { state } from '../store.js';
import { showError } from '../ui.js';

function link(label, url) {
  return h('button', { class: 'link-button', type: 'button', onclick: () => call('app:openExternal', { url }).catch(showError) }, label);
}

function section(title, ...content) {
  return h('section', { class: 'help-section' }, h('h2', null, title), content);
}

export function renderHelp() {
  const mod = state.info.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const isMac = state.info.platform === 'darwin';
  return h('div', { class: 'page help-page' },
    h('header', { class: 'page-header' }, h('h1', null, 'How Author Studio works')),
    section('You direct, the helpers write',
      h('p', null, 'Start a project with your idea. Then choose one step at a time: research, setting, story plan, writing a chapter, or revising. Each step is done by a specialist helper: the Researcher, World Designer, Story Builder, Scene Writer, or Editor.'),
      h('p', null, 'Every helper rates its own work. Work it is confident about, with no problems, is accepted automatically. Anything else waits for your review, where you can approve it, request changes, continue unfinished text, get a second opinion, or set it aside.'),
      h('p', null, 'To write several chapters in a row, turn on YOLO mode when you choose Write and pick the last chapter. Author Studio keeps writing until it reaches that chapter, or stops early when a chapter needs your review.'),
      h('p', null, 'Accepted work builds the story bible: characters, places, timeline, and plot threads. Helpers read it before each step so the story stays consistent, and any change to something already established needs your approval.')),
    section('Choosing an AI model',
      h('ul', { class: 'help-list' },
        h('li', null, h('strong', null, 'Claude or GPT. '), 'The best writing quality. Create an account, add a payment method, and create an API key at ', link('console.anthropic.com', 'https://console.anthropic.com/settings/keys'), ' or ', link('platform.openai.com', 'https://platform.openai.com/api-keys'), '. Paste the key into Settings. The provider bills you for what you use.'),
        h('li', null, h('strong', null, 'A model on your computer or network. '), 'Free and private, but you need a reasonably powerful computer. Install ', link('Ollama', 'https://ollama.com'), ' or ', link('LM Studio', 'https://lmstudio.ai'), ', download a model, then add a local server in Settings and choose the matching server software. Larger models write better. To use a server on another computer, set it to accept network connections and use that computer\'s address.'),
        isMac ? h('li', null, h('strong', null, 'Apple Intelligence. '), 'Built into Macs with Apple silicon running macOS 26 or later, once Apple Intelligence is turned on in System Settings. Private and free, but a small model that reads about 3,000 words at a time: good for ideas, planning, and short pieces. ', link('About Apple Intelligence', 'https://support.apple.com/en-us/121115')) : null),
      h('p', null, 'You can connect several models, switch the default from the bottom of the sidebar, and choose two reviewers for second opinions.')),
    section('Privacy',
      h('p', null, 'Your projects are saved only on this computer. Author Studio sends story material to the AI model you choose, and only when you run a step. API keys are stored encrypted with your system\'s keychain where available.')),
    section('Files and backups',
      h('ul', { class: 'help-list' },
        h('li', null, 'Every save keeps the previous version as a backup copy, which Author Studio uses automatically if a file is damaged.'),
        h('li', null, 'Export the manuscript as a Word document (standard manuscript format), Markdown, or plain text from the Manuscript tab.'),
        h('li', null, 'Use Export in any project, or File > Export Project Content, to export the story bible, research, setting, story plan, idea and brief, or a complete planning packet as Word, Markdown, or plain text. No chapters are needed. Exports include saved, accepted content only; the story bible includes full planning documents, while the planning packet also includes the idea and brief.'),
        h('li', null, 'Back up a whole project, or export a state file for the Author Studio plugin for GitHub Copilot and Claude Code, from the History tab. Open either kind of file with File > Open Backup or State File.'))),
    section('If something goes wrong',
      h('ul', { class: 'help-list' },
        h('li', null, h('strong', null, 'The text stops partway. '), 'Models have a length limit. Use Continue writing to extend it.'),
        h('li', null, h('strong', null, 'A step is too long for the model. '), 'Choose a model that can read more at once, or shorten your notes and brief.'),
        h('li', null, h('strong', null, 'A local server cannot be reached. '), 'Make sure the server software is running and has a model loaded, then use Find models in Settings to check the address.'),
        h('li', null, h('strong', null, 'A model refuses a request. '), 'Rephrase your notes, or use a different model for that step.'))),
    section('Keyboard shortcuts',
      h('table', { class: 'shortcuts' }, h('tbody', null, [
        ['New project', `${mod}N`],
        ['Open a backup or state file', `${mod}O`],
        ['Export project content', `${mod}E`],
        ['Settings', `${mod},`],
        ['Run the step or revision you are writing notes for', `${mod}Enter`],
      ].map(([label, keys]) => h('tr', null, h('td', null, label), h('td', null, h('kbd', null, keys))))))),
    h('p', { class: 'muted small' }, 'Author Studio is open source. ', link('Visit the project on GitHub', 'https://github.com/thorrsson/author-studio'), '.'),
  );
}
