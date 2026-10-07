import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import updateProvider from 'electron-updater/out/providers/Provider.js';
import { createUpdates } from '../src/main/updates.js';
import { writeMacUpdateInfo } from '../scripts/macos/write-update-info.mjs';

function harness(options = {}) {
  const updater = new EventEmitter();
  const messages = [];
  const errors = [];
  const timers = [];
  const cleared = [];
  const responses = [];
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  let busy = 0;
  updater.checkForUpdates = async () => {
    checks++;
    return { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } };
  };
  updater.downloadUpdate = async () => { downloads++; };
  updater.quitAndInstall = () => { installs++; };
  const schedule = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  const updates = createUpdates({
    updater,
    dialog: { showMessageBox: async (...args) => {
      messages.push(args.at(-1));
      return { response: responses.shift() ?? 1 };
    } },
    getWindow: () => null,
    busyCount: () => busy,
    isPackaged: true,
    platform: 'darwin',
    env: {},
    logger: { error: (...args) => errors.push(args) },
    setTimer: schedule,
    setRepeating: schedule,
    clearTimer: (timer) => cleared.push(timer),
    clearRepeating: (timer) => cleared.push(timer),
    ...options,
  });
  updates.start();
  return {
    updates, updater, messages, errors, timers, cleared, responses,
    setBusy: (value) => { busy = value; },
    counts: () => ({ checks, downloads, installs }),
  };
}

test('updates start once, check periodically, and never install on normal quit', () => {
  const h = harness();
  h.updates.start();
  assert.deepEqual(h.timers.map((timer) => timer.delay), [30_000, 14_400_000]);
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.updater.allowPrerelease, false);
  assert.equal(h.updater.allowDowngrade, false);
  assert.equal(h.updater.disableDifferentialDownload, true);
  h.updates.dispose();
  assert.deepEqual(h.cleared, h.timers);
  assert.equal(h.updater.listenerCount('error'), 0);
});

test('only packaged Mac, Windows and AppImage builds check the feed', async () => {
  for (const options of [
    { isPackaged: false }, { platform: 'linux' }, { platform: 'freebsd' },
  ]) {
    const h = harness(options);
    await h.updates.check(true);
    assert.equal(h.timers.length, 0);
    assert.equal(h.counts().checks, 0);
    assert.match(h.messages[0].message, /not available/);
  }
  for (const options of [{ platform: 'win32' }, { platform: 'linux', env: { APPIMAGE: '/app.AppImage' } }]) {
    const h = harness(options);
    await h.updates.check();
    assert.equal(h.timers.length, 2);
    assert.equal(h.counts().checks, 1);
    assert.equal(h.updater.disableDifferentialDownload, undefined);
  }
});

test('packaged smoke tests suppress automatic network checks', async () => {
  const h = harness({ env: { AUTHOR_STUDIO_DISABLE_UPDATE_CHECKS: '1' } });
  h.updates.start();
  assert.equal(h.timers.length, 0);
  assert.equal(h.updater.listenerCount('error'), 1);
  await h.updates.check(true);
  assert.equal(h.counts().checks, 1);
});

test('declining an update does not download or install it', async () => {
  const h = harness();
  await h.updates.check();
  assert.deepEqual(h.counts(), { checks: 1, downloads: 0, installs: 0 });
});

test('downloading requires approval and restarting requires a second approval', async () => {
  const h = harness();
  h.responses.push(0, 1);
  await h.updates.check();
  assert.deepEqual(h.counts(), { checks: 1, downloads: 1, installs: 0 });
  await h.updates.check();
  assert.equal(h.messages.length, 2, 'background checks do not nag about a downloaded update');
  h.responses.push(0);
  await h.updates.check(true);
  assert.deepEqual(h.counts(), { checks: 1, downloads: 1, installs: 1 });
});

test('a writing step blocks installation, including one started during the prompt', async () => {
  const h = harness();
  h.setBusy(1);
  h.responses.push(0);
  await h.updates.check();
  assert.match(h.messages.at(-1).detail, /Finish the current writing step/);
  assert.equal(h.counts().installs, 0);
  h.setBusy(0);
  h.responses.push(0);
  await h.updates.check(true);
  assert.equal(h.counts().installs, 1);

  let busy = 0;
  const race = harness({
    busyCount: () => busy,
    dialog: { showMessageBox: async (options) => {
      if (options.message === 'An update is ready.') busy = 1;
      return { response: 0 };
    } },
  });
  await race.updates.check();
  assert.equal(race.counts().installs, 0);
});

test('up-to-date background checks stay quiet, but manual checks give feedback', async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  await h.updates.check();
  assert.equal(h.messages.length, 0);
  await h.updates.check(true);
  assert.equal(h.messages[0].message, 'Author Studio is up to date.');
});

test('concurrent checks do not duplicate a download', async () => {
  const h = harness();
  let finish;
  h.updater.checkForUpdates = () => new Promise((resolve) => { finish = resolve; });
  const first = h.updates.check();
  await h.updates.check(true);
  assert.equal(h.messages[0].message, 'Checking for updates.');
  h.responses.push(0, 1);
  finish({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
  await first;
  assert.equal(h.counts().downloads, 1);
});

test('check failures are logged and manual errors are shown once, then can retry', async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => {
    const error = new Error('Network unavailable');
    h.updater.emit('error', error);
    throw error;
  };
  await h.updates.check();
  assert.ok(h.errors.length);
  assert.equal(h.messages.length, 0);
  await h.updates.check(true);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].detail, /Network unavailable/);
  h.updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
  await h.updates.check(true);
  assert.equal(h.messages.at(-1).message, 'Author Studio is up to date.');
});

test('download failures notify the author even on an automatic check', async () => {
  const h = harness();
  h.responses.push(0);
  h.updater.downloadUpdate = async () => { throw new Error('Checksum mismatch'); };
  await h.updates.check();
  assert.match(h.messages.at(-1).detail, /Checksum mismatch/);
  assert.equal(h.counts().installs, 0);
});

test('install errors outside a check are reported', async () => {
  const h = harness();
  h.updater.emit('error', new Error('Installer failed'));
  await Promise.resolve();
  assert.match(h.messages[0].detail, /Installer failed/);
});

test('a synchronous installer error is shown even during the first check', async () => {
  const h = harness();
  h.responses.push(0, 0);
  h.updater.quitAndInstall = () => h.updater.emit('error', new Error('Installer could not start'));
  await h.updates.check();
  assert.equal(h.messages.at(-1).message, 'Author Studio could not install the update.');
  assert.match(h.messages.at(-1).detail, /Installer could not start/);
});

test('disposing during a download does not prompt or install afterward', async () => {
  const h = harness();
  let finish;
  h.responses.push(0);
  h.updater.downloadUpdate = () => new Promise((resolve) => { finish = resolve; });
  const check = h.updates.check();
  // Advance through the asynchronous version check and approval dialog.
  while (!finish) await Promise.resolve();
  h.updates.dispose();
  finish([]);
  await check;
  assert.equal(h.messages.length, 1);
  assert.equal(h.counts().installs, 0);
});

test('Mac feed hashes the final stapled archive and excludes the modified DMG', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'author-studio-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const name = 'Author-Studio-1.2.0-universal.zip';
  const contents = Buffer.from('final archive bytes after stapling');
  await writeFile(path.join(dir, name), contents);
  await writeMacUpdateInfo(dir, '1.2.0');
  const feed = await readFile(path.join(dir, 'latest-mac.yml'), 'utf8');
  const info = updateProvider.parseUpdateInfo(feed, 'latest-mac.yml', 'https://example.com/latest-mac.yml');
  assert.equal(info.version, '1.2.0');
  const sha512 = createHash('sha512').update(contents).digest('base64');
  assert.deepEqual(info.files, [{ url: name, sha512, size: contents.length }]);
  assert.equal(info.path, name);
  assert.equal(info.sha512, sha512);
  assert.ok(Number.isFinite(Date.parse(info.releaseDate)));
  await writeFile(path.join(dir, name), 'different bytes');
  const rewritten = await writeMacUpdateInfo(dir, '1.2.0');
  assert.notEqual(rewritten.sha512, sha512);
});
