// Where the app finds its bundled files in development and once packaged.
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// app/src
export const SRC_ROOT = path.resolve(here, '..');
// app/
export const APP_ROOT = path.resolve(SRC_ROOT, '..');

export const HELPER_NAME = 'author-studio-apple-intelligence';

// The shared Author Studio skill files (skills/, agents/). In development they
// come from the repository root; packaged builds copy them into resources.
export function resourcesRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'author-studio') : path.resolve(APP_ROOT, '..');
}

export function appleHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', HELPER_NAME)
    : path.join(APP_ROOT, 'resources', 'bin', HELPER_NAME);
}
