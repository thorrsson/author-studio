import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b/i);
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
