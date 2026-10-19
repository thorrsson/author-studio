import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getDownloads, setupPicker } from '../site/assets/downloads.mjs';

const site = fileURLToPath(new URL('../site/', import.meta.url));

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  }));
  return files.flat();
}

const files = await filesIn(site);
const pages = files.filter((file) => file.endsWith('.html'));

test('site includes the landing page and three documentation guides', async () => {
  assert.deepEqual(pages.map((file) => path.relative(site, file)).sort(), [
    'docs/index.html', 'docs/models-and-privacy.html', 'docs/workflow.html', 'index.html',
  ]);
  await stat(path.join(site, '.nojekyll'));
});

for (const file of pages) {
  const relative = path.relative(site, file);
  test(`${relative}: document metadata and accessible landmarks`, async () => {
    const html = await readFile(file, 'utf8');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1);
    assert.equal([...html.matchAll(/<main(?:\s|>)/g)].length, 1);
    assert.match(html, /<a class="skip" href="#main">/);
    assert.match(html, /<main id="main"/);
    assert.doesNotMatch(html, /<iframe\b|<form\b/i);
    const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map(([script]) => script);
    assert.deepEqual(scripts, relative === 'index.html'
      ? ['<script type="module" src="assets/download-picker.mjs"></script>']
      : []);
    for (const image of html.matchAll(/<img\b[^>]*>/g)) {
      assert.match(image[0], /\balt="[^"]*"/);
    }
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
  });

  test(`${relative}: links and assets work at a GitHub project subpath`, async () => {
    const html = await readFile(file, 'utf8');
    for (const [, attribute, reference] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
      const url = new URL(reference, `https://example.test/author-studio/${relative}`);
      if (url.origin !== 'https://example.test') {
        assert.equal(url.protocol, 'https:', `Unexpected external URL: ${reference}`);
        continue;
      }
      assert.ok(url.pathname.startsWith('/author-studio/'), `Escapes project path: ${reference}`);
      let target = path.join(site, decodeURIComponent(url.pathname.slice('/author-studio/'.length)));
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      assert.ok((await stat(target)).isFile(), `Missing ${attribute}: ${reference}`);
      if (url.hash) {
        const targetHtml = await readFile(target, 'utf8');
        assert.ok(targetHtml.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing anchor: ${reference}`);
      }
    }
  });
}

test('site favicon stays in sync with the desktop brand', async () => {
  assert.equal(
    await readFile(path.join(site, 'assets/icon.svg'), 'utf8'),
    await readFile(new URL('../app/src/renderer/icon.svg', import.meta.url), 'utf8'),
  );
});

const asset = (name) => ({
  name,
  browser_download_url: `https://github.com/thorrsson/author-studio/releases/download/desktop-v1.2.3/${name}`,
});
const release = {
  draft: false,
  prerelease: false,
  assets: [
    asset('Author-Studio-1.2.3-universal.dmg'),
    asset('Author-Studio-Setup-1.2.3.exe'),
    asset('Author-Studio-1.2.3-x86_64.AppImage'),
    asset('Author-Studio-1.2.3-amd64.deb'),
    asset('Author-Studio-Setup-1.2.3.exe.blockmap'),
    asset('Author-Studio-1.2.3-universal.dmg.sha256'),
    asset('Author-Studio-1.2.3-universal.zip'),
  ],
};
const respond = (data) => async () => ({ ok: true, json: async () => data });

test('download lookup selects direct installers, not updater files or checksums', async () => {
  const downloads = await getDownloads(async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/thorrsson/author-studio/releases/latest');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => release };
  });
  assert.deepEqual(downloads, {
    mac: release.assets[0].browser_download_url,
    windows: release.assets[1].browser_download_url,
    linux: release.assets[2].browser_download_url,
  });
});

test('download lookup rejects API failures and incomplete or unsafe releases', async () => {
  await assert.rejects(getDownloads(async () => ({ ok: false, status: 403 })), /403/);
  await assert.rejects(getDownloads(async () => { throw new Error('Network failure'); }), /Network failure/);
  for (const invalid of [
    { ...release, prerelease: true },
    { ...release, draft: true },
    {},
    { ...release, assets: release.assets.slice(1) },
    { ...release, assets: [...release.assets, release.assets[0]] },
    { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/installer' }, ...release.assets.slice(1)] },
  ]) {
    await assert.rejects(getDownloads(respond(invalid)));
  }
});

function pickerFixture() {
  const status = { textContent: '' };
  const list = { hidden: true };
  const links = ['mac', 'windows', 'linux'].map((platform) => ({ dataset: { platform } }));
  const picker = {
    open: false,
    querySelector: (selector) => selector === 'ul' ? list : status,
    querySelectorAll: () => links,
    addEventListener: (event, handler) => { picker.toggle = handler; },
  };
  return { picker, status, list, links };
}

test('picker loads only on open, exposes real links, and reuses successful results', async () => {
  const { picker, status, list, links } = pickerFixture();
  let calls = 0;
  setupPicker(picker, async () => {
    calls++;
    assert.equal(list.hidden, true);
    assert.match(status.textContent, /Finding/);
    return getDownloads(respond(release));
  });
  await picker.toggle();
  assert.equal(calls, 0);
  picker.open = true;
  await picker.toggle();
  assert.equal(list.hidden, false);
  assert.match(status.textContent, /Choose your platform/);
  assert.deepEqual(links.map((link) => link.href), release.assets.slice(0, 3).map((item) => item.browser_download_url));
  await picker.toggle();
  assert.equal(calls, 1);
});

test('picker displays failure without exposing broken links and can retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { picker, status, list } = pickerFixture();
  let calls = 0;
  setupPicker(picker, async () => {
    if (++calls === 1) throw new Error('Rate limited');
    return getDownloads(respond(release));
  });
  picker.open = true;
  await picker.toggle();
  assert.equal(list.hidden, true);
  assert.match(status.textContent, /Could not load downloads/);
  assert.equal(console.error.mock.callCount(), 1);
  picker.open = false;
  await picker.toggle();
  picker.open = true;
  await picker.toggle();
  assert.equal(list.hidden, false);
});

test('both download controls provide every platform and a no-JavaScript fallback', async () => {
  const html = await readFile(path.join(site, 'index.html'), 'utf8');
  const pickers = [...html.matchAll(/<details class="download-picker">([\s\S]*?)<\/details>/g)];
  assert.equal(pickers.length, 2);
  for (const [, picker] of pickers) {
    for (const platform of ['mac', 'windows', 'linux']) {
      assert.ok(picker.includes(`data-platform="${platform}"`));
    }
    assert.match(picker, /role="status"/);
    assert.match(picker, /href="https:\/\/github.com\/thorrsson\/author-studio\/releases"/);
  }
});
