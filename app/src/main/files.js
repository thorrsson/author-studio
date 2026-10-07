// Small file helpers shared by the settings and project stores.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Windows can briefly lock a file that antivirus or indexing is reading.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

// Writes through a temporary file so a crash never leaves a half-written file.
export async function writeFileAtomic(file, data, { backup = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (backup) {
      await copyFile(file, `${file}.bak`).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Returns undefined when the file does not exist; throws when it is unreadable.
export async function readJsonFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
