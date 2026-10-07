// End-to-end smoke test: launches the real app against a scripted
// OpenAI-compatible server and walks through the main writing flow.
// Set SMOKE_SCREENSHOTS=<folder> to save screenshots of each screen, and
// AUTHOR_STUDIO_EXECUTABLE=<path> to test a packaged build instead of the source.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';
import { ASSESSMENT_HEADING } from '../../src/core/parse.js';
import { json, openaiEvents, pause, startServer } from '../mock-server.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotsDir = process.env.SMOKE_SCREENSHOTS ? path.resolve(process.env.SMOKE_SCREENSHOTS) : null;
const packaged = process.env.AUTHOR_STUDIO_EXECUTABLE ? path.resolve(process.env.AUTHOR_STUDIO_EXECUTABLE) : null;

function reply(artifact, assessment) {
  return `${artifact}\n\n${ASSESSMENT_HEADING}\n\`\`\`json\n${JSON.stringify(assessment, null, 2)}\n\`\`\``;
}

const BRIEF = JSON.stringify({
  title: 'The Lantern Keeper',
  genre: 'Literary mystery',
  brief: '- Form: a novella in short chapters\n- Point of view: close third person, Morag\n- Setting: a Hebridean island, present day\n- Tone: quiet, wry, melancholy\n- Boundaries: no supernatural explanation',
});

const WORLD = reply(
  '## Setting: Inniscaul\n\nA small island of **forty-one people**, a ferry twice a week, and a lighthouse automated in 1998. The pub doubles as the post office.\n\n- The harbour faces east, away from the weather.\n- Peat smoke and diesel are the island\'s two smells.',
  {
    confidence: 0.9,
    rationale: 'Grounded in the brief: small, isolated, realistic.',
    flags: [],
    contradictions: [],
    complete: true,
    summary: 'Island setting and its people',
    proposed_changes: {
      characters: [
        { name: 'Morag Sinclair', role: 'Protagonist, retired lighthouse keeper', arc_stage: 'Grieving, withdrawn', voice_notes: 'Dry, exact, notices weather' },
        { name: 'Iain Mackay', role: 'Ferryman and gossip', arc_stage: 'Introduced', voice_notes: 'Talks in questions' },
      ],
      lore: { tech_level: 'Present day; patchy mobile signal', key_factions: ['The community council', 'The ferry company'], timeline_log: ['1998: lighthouse automated', 'Last spring: Morag\'s husband Duncan dies'] },
    },
  },
);

const CHAPTER = reply(
  '## Chapter 1: Message\n\nThe bottle came in on the Tuesday tide, which Morag would later think was typical of Duncan: punctual even now.\n\nShe turned it over twice before she let herself read the address.',
  {
    confidence: 0.55,
    rationale: 'The opening works, but the pacing of the discovery may be too quick.',
    flags: ['Pacing of the discovery scene'],
    contradictions: [],
    complete: true,
    summary: 'Morag finds the bottle',
    proposed_changes: { plot: { loose_threads: ['Who wrote the message, and when?'] } },
  },
);

// Replies in the order the walkthrough asks for them.
const SCRIPT = [
  { text: BRIEF, size: 8, delay: 25 },
  { text: WORLD },
  { text: CHAPTER },
  { text: 'A plan that takes a long time. '.repeat(400), size: 12, delay: 120 },
];

// Streams a reply in small pieces so the app shows it arriving.
async function stream(_req, res, { text, size = 24, delay = 12 }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
  for (const event of openaiEvents(pieces)) {
    if (!res.socket || res.socket.destroyed) return;
    res.write(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n\n`);
    await pause(delay);
  }
  res.end();
}

function systemText(entry) {
  return String(entry.body?.messages?.find((message) => message.role === 'system')?.content ?? '');
}

async function main() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'author-studio-e2e-'));
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const script = [...SCRIPT];
  let chats = 0;
  const server = await startServer({
    'GET /v1/models': (_req, res) => json(res, 200, { object: 'list', data: [{ id: 'mock-writer', object: 'model' }, { id: 'mock-editor', object: 'model' }] }),
    'POST /v1/chat/completions': async (req, res, entry) => {
      if (/can reach you/.test(systemText(entry))) return stream(req, res, { text: 'Ready' });
      chats += 1;
      return stream(req, res, script.shift() ?? { text: 'Unexpected request' });
    },
  });

  const problems = [];
  let app;
  let page;
  const shot = async (name) => {
    if (!shotsDir) return;
    // Let opening animations finish so a screenshot is not caught mid-fade.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  };
  const step = (name) => console.log(`- ${name}`);
  const dialog = () => page.getByRole('dialog');
  const sidebar = () => page.locator('#sidebar');

  try {
    app = await electron.launch({
      executablePath: packaged ?? electronPath,
      args: packaged ? [] : [appDir],
      // Let the app's own theme setting drive prefers-color-scheme.
      colorScheme: null,
      env: {
        ...process.env,
        AUTHOR_STUDIO_USER_DATA: userData,
        AUTHOR_STUDIO_KEY_STORAGE: 'memory',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => problems.push(`Page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`Console error: ${message.text()}`);
    });
    page.setDefaultTimeout(15000);

    step('welcome screen');
    await page.getByRole('heading', { name: 'Welcome to Author Studio' }).waitFor();
    await shot('01-welcome');

    step('connect a local server');
    await page.click('.type-card[data-type="compatible"]');
    await dialog().getByRole('heading', { name: /Connect/ }).waitFor();
    await page.fill('#connection-url', server.url);
    await page.press('#connection-url', 'Tab');
    await page.waitForSelector('select#connection-model option[value="mock-writer"]', { state: 'attached' });
    await dialog().getByRole('button', { name: 'Test connection' }).click();
    await page.waitForSelector('.modal .callout-success');
    await shot('02-connect');
    await dialog().getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForSelector('.toast:has-text("is ready to use")');
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();

    step('create a project with a brief');
    await page.getByRole('main').getByRole('button', { name: 'New project' }).click();
    await page.fill('#new-concept', 'A retired lighthouse keeper on a Scottish island finds a message in a bottle written in her late husband\'s hand.');
    await dialog().getByRole('button', { name: 'Create project' }).click();
    await page.waitForSelector('.modal .stream:has-text("Working title: The Lantern Keeper")');
    await shot('03-new-project-streaming');
    await page.getByRole('heading', { name: 'The Lantern Keeper', level: 1 }).waitFor();

    step('accept a setting automatically');
    await page.click('.step-option:has-text("Setting")');
    await page.click('.composer .btn.primary');
    await page.waitForSelector('.result-card:has-text("Accepted")');
    await shot('04-accepted');

    step('gate a low-confidence chapter for review');
    await page.click('.step-option:has-text("Write")');
    await page.click('.composer .btn.primary');
    await page.waitForSelector('.review-card');
    const reviewText = await page.textContent('.review-card');
    assert.match(reviewText, /Pacing of the discovery scene/);
    assert.match(reviewText, /55%/);
    await shot('05-review');
    await page.click('.review-actions .btn.primary');
    await page.waitForSelector('.toast:has-text("You approved")');
    await page.waitForSelector('.composer');

    step('stop a slow step');
    await page.click('.step-option:has-text("Story plan")');
    await page.click('.composer .btn.primary');
    await page.waitForSelector('.run-card .stream:has-text("A plan that takes")');
    await shot('06-running');
    await page.click('.run-card .btn.danger');
    await page.waitForSelector('.composer');
    assert.equal(await page.locator('.run-card').count(), 0);

    step('manuscript, story bible, brief, and history');
    await page.click('.tab:has-text("Manuscript")');
    await page.waitForSelector('.manuscript:has-text("The bottle came in on the Tuesday tide")');
    await shot('07-manuscript');
    await page.click('.tab:has-text("Story bible")');
    await page.waitForSelector('.character-card:has-text("Morag Sinclair")');
    await page.waitForSelector('.bible-section:has-text("Who wrote the message")');
    await shot('08-bible');
    await page.click('.tab:has-text("Idea and brief")');
    assert.match(await page.inputValue('#brief-brief'), /no supernatural explanation/);
    await page.click('.tab:has-text("History")');
    await page.waitForSelector('.data-table');
    await shot('09-history');

    step('export for Word');
    const exportPath = path.join(userData, 'export.docx');
    await app.evaluate(({ dialog: electronDialog }, filePath) => {
      electronDialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportPath);
    await page.click('.tab:has-text("Manuscript")');
    await page.getByRole('button', { name: 'Export for Word' }).click();
    await page.waitForSelector('.toast:has-text("Saved export.docx")');
    assert.equal((await readFile(exportPath)).subarray(0, 2).toString(), 'PK');

    step('settings, saved keys, dark theme, and help');
    await sidebar().getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    await shot('10-settings');
    await page.click('.connection-row .btn:has-text("Edit")');
    await page.fill('#connection-key', 'local-token-abc');
    await dialog().getByRole('button', { name: 'Save changes' }).click();
    await page.waitForSelector('.modal-overlay', { state: 'detached' });
    await page.click('.connection-row .btn:has-text("Edit")');
    assert.match(await page.getAttribute('#connection-key', 'placeholder'), /Saved key/);
    await page.fill('#connection-url', `http://localhost:${server.port}/v1`);
    await page.press('#connection-url', 'Tab');
    await page.waitForSelector(`.modal .hint:has-text("only sent to ${server.url}")`);
    await shot('11-moved-server');
    assert.match(await page.getAttribute('#connection-key', 'placeholder'), /Enter the key again/);
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('.modal-overlay', { state: 'detached' });
    await page.click('.segment:has-text("Dark")');
    await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
    await sidebar().getByRole('button', { name: 'The Lantern Keeper' }).click();
    await page.getByRole('heading', { name: 'The Lantern Keeper', level: 1 }).waitFor();
    await shot('12-dark-workspace');
    await sidebar().getByRole('button', { name: 'Help' }).click();
    await page.getByRole('heading', { name: 'How Author Studio works' }).waitFor();
    await shot('13-help-dark');
    await sidebar().getByRole('button', { name: 'Settings' }).click();
    await page.click('.segment:has-text("Match system")');

    assert.deepEqual(problems, []);
    assert.equal(chats, SCRIPT.length);
    console.log('Smoke test passed.');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(shotsDir ?? os.tmpdir(), 'author-studio-smoke-failure.png') }).catch(() => {});
    if (problems.length) console.error(problems.join('\n'));
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await server.close();
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
