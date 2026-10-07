// Kept in the main process: the renderer cannot select feeds or install files.
export function createUpdates({
  updater, dialog, getWindow, busyCount, isPackaged,
  platform = process.platform, env = process.env, logger = console,
  setTimer = setTimeout, clearTimer = clearTimeout,
  setRepeating = setInterval, clearRepeating = clearInterval,
}) {
  const supported = isPackaged && (platform === 'darwin' || platform === 'win32' || (platform === 'linux' && Boolean(env.APPIMAGE)));
  let checking = false;
  let downloading = false;
  let prompting = false;
  let downloaded = false;
  let installing = false;
  let startupTimer;
  let repeatTimer;
  let disposed = false;
  let started = false;

  async function message(options) {
    const window = getWindow();
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }

  async function offerRestart() {
    if (prompting || disposed) return;
    prompting = true;
    try {
      if (busyCount()) {
        await message({
          type: 'info', buttons: ['OK'],
          message: 'An update is ready.',
          detail: 'Finish the current writing step, then choose Check for Updates to restart and install it.',
        });
        return;
      }
      const { response } = await message({
        type: 'info', buttons: ['Restart and Install', 'Later'], defaultId: 1, cancelId: 1,
        message: 'An update is ready.',
        detail: 'Restart Author Studio to install it. Your saved projects and settings will be kept.',
      });
      if (response !== 0 || disposed) return;
      // A writing step may have started while the dialog was open.
      if (busyCount()) {
        await message({
          type: 'info', buttons: ['OK'], message: 'Author Studio is still working.',
          detail: 'Finish the current writing step, then choose Check for Updates again.',
        });
        return;
      }
      installing = true;
      updater.quitAndInstall();
    } finally {
      prompting = false;
    }
  }

  async function check(manual = false) {
    if (disposed) return;
    if (!supported) {
      if (manual) await message({
        type: 'info', buttons: ['OK'], message: 'Automatic updates are not available for this build.',
        detail: isPackaged
          ? 'On Linux, use the AppImage for automatic updates. For other packages, install the latest version from Help > Author Studio on GitHub.'
          : 'Updates are available in installed release builds, not when running from source.',
      });
      return;
    }
    if (prompting) return;
    if (downloaded) return manual ? offerRestart() : undefined;
    if (checking || downloading) {
      if (manual) await message({
        type: 'info', buttons: ['OK'], message: downloading ? 'An update is downloading.' : 'Checking for updates.',
        detail: downloading ? 'You can keep writing. Author Studio will ask before restarting.' : 'Please wait for the current check to finish.',
      });
      return;
    }
    checking = true;
    try {
      const result = await updater.checkForUpdates();
      if (!result || disposed) return;
      if (!result.isUpdateAvailable) {
        if (manual) await message({ type: 'info', buttons: ['OK'], message: 'Author Studio is up to date.' });
        return;
      }
      prompting = true;
      let response;
      try {
        ({ response } = await message({
          type: 'info', buttons: ['Download Update', 'Later'], defaultId: 0, cancelId: 1,
          message: `Author Studio ${result.updateInfo.version} is available.`,
          detail: 'Download the update now? You can keep writing, and Author Studio will ask before restarting.',
        }));
      } finally {
        prompting = false;
      }
      if (response !== 0 || disposed) return;
      downloading = true;
      await updater.downloadUpdate();
      downloading = false;
      downloaded = true;
      await offerRestart();
    } catch (error) {
      logger.error('Author Studio update failed:', error);
      if (manual || downloading) await message({
        type: 'error', buttons: ['OK'], message: 'Author Studio could not update.',
        detail: `${error.message}\n\nTry Check for Updates again later. Your projects are unchanged.`,
      });
    } finally {
      checking = false;
      downloading = false;
    }
  }

  function onError(error) {
    logger.error('Author Studio update failed:', error);
    if ((installing || !checking) && !disposed) {
      installing = false;
      void message({ type: 'error', buttons: ['OK'], message: 'Author Studio could not install the update.', detail: error.message })
        .catch((dialogError) => logger.error('Could not show update error:', dialogError));
    }
  }

  function start() {
    if (!supported || started || disposed) return;
    started = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // Mac archives are rebuilt after stapling, so builder blockmaps are stale.
    if (platform === 'darwin') updater.disableDifferentialDownload = true;
    updater.on('error', onError);
    // Packaged smoke tests must not contact the public release feed.
    if (env.AUTHOR_STUDIO_DISABLE_UPDATE_CHECKS === '1') return;
    const backgroundCheck = () => {
      void check().catch((error) => logger.error('Could not show update dialog:', error));
    };
    startupTimer = setTimer(backgroundCheck, 30_000);
    repeatTimer = setRepeating(backgroundCheck, 4 * 60 * 60 * 1000);
    startupTimer.unref?.();
    repeatTimer.unref?.();
  }

  function dispose() {
    disposed = true;
    clearTimer(startupTimer);
    clearRepeating(repeatTimer);
    updater.removeListener('error', onError);
  }

  return { start, check, dispose };
}
