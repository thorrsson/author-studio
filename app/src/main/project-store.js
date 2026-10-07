// Projects are saved as one JSON file each, written atomically, with the
// previous version kept as a .bak file for recovery.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkProject, projectSummary } from '../core/engine.js';
import { AppError, readJsonFile, writeFileAtomic } from './files.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectId(id) {
  return typeof id === 'string' && ID.test(id);
}

export function createProjectStore({ dir, trashItem } = {}) {
  const queues = new Map();
  const summaries = new Map();

  function fileFor(id) {
    if (!isProjectId(id)) throw new AppError('invalid-input', 'That project could not be found.');
    return path.join(dir, `${id}.json`);
  }

  async function readValid(file) {
    const project = await readJsonFile(file);
    if (project === undefined) return { missing: true };
    const errors = checkProject(project);
    return errors.length ? { errors } : { project };
  }

  // Serializes writes per project so a slow write never overtakes a newer one.
  function enqueue(id, task) {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(id, next);
    next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    }).catch(() => {});
    return next;
  }

  return {
    dir,

    async list() {
      let names = [];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const results = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).map(async (name) => {
        const id = name.slice(0, -5);
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          const cached = summaries.get(id);
          if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;
          const { project, errors } = await readValid(file).catch((error) => ({ errors: [error.message] }));
          if (project) {
            const summary = { ...projectSummary(project), id };
            summaries.set(id, { mtimeMs: info.mtimeMs, size: info.size, summary });
            return summary;
          }
          summaries.delete(id);
          const backup = await readValid(`${file}.bak`).catch(() => ({}));
          return backup.project
            ? { ...projectSummary(backup.project), id, recovered: true }
            : { id, title: 'Damaged project', damaged: true, errors: errors ?? ['The file is empty.'], updatedAt: info.mtime.toISOString() };
        } catch {
          return null;
        }
      }));
      return results.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    // Falls back to the .bak copy if the main file is damaged.
    async load(id) {
      const file = fileFor(id);
      await queues.get(id)?.catch(() => {});
      const main = await readValid(file).catch((error) => ({ errors: [error.message] }));
      if (main.project) return { project: { ...main.project, id }, recovered: false };
      const backup = await readValid(`${file}.bak`).catch((error) => ({ errors: [error.message] }));
      if (backup.project) return { project: { ...backup.project, id }, recovered: true };
      if (main.missing) throw new AppError('project-missing', 'That project could not be found. It may have been deleted.');
      throw new AppError('damaged', 'This project file is damaged and could not be opened.', { errors: main.errors ?? [] });
    },

    save(project) {
      const file = fileFor(project?.id);
      const text = `${JSON.stringify(project, null, 1)}\n`;
      return enqueue(project.id, async () => {
        await writeFileAtomic(file, text, { backup: true });
        summaries.delete(project.id);
      });
    },

    remove(id) {
      const file = fileFor(id);
      return enqueue(id, async () => {
        summaries.delete(id);
        if (trashItem) {
          // Never fall back to a permanent delete: the user was told it goes to the trash.
          try {
            await trashItem(file);
          } catch (error) {
            const exists = await stat(file).then(() => true, (statError) => statError.code !== 'ENOENT');
            if (exists) throw new AppError('trash-failed', 'The project could not be moved to the trash, so it was not deleted.', { cause: error.message });
          }
        } else {
          await rm(file, { force: true });
        }
        await rm(`${file}.bak`, { force: true });
      });
    },
  };
}
