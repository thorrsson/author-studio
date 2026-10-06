// Loads the shared Author Studio skill files so the desktop app and the
// Copilot/Claude plugin use the same worker guide, state template, and reviewer.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const RESOURCE_FILES = Object.freeze({
  template: 'skills/author-studio/templates/state.json',
  workers: 'skills/author-studio/references/workers.md',
  reviewer: 'agents/author-studio-reviewer.agent.md',
  review: 'skills/author-studio-review/SKILL.md',
});

export const ROLE_NAMES = Object.freeze([
  'Researcher',
  'World Designer',
  'Story Builder',
  'Scene Writer',
  'Editor',
]);

export async function loadResources(baseDir) {
  const read = (relative) => readFile(path.join(baseDir, relative), 'utf8');
  const [template, workers, reviewer, review] = await Promise.all([
    read(RESOURCE_FILES.template),
    read(RESOURCE_FILES.workers),
    read(RESOURCE_FILES.reviewer),
    read(RESOURCE_FILES.review),
  ]);
  const consolidationGuide = extractSection(review, 'Consolidate the report');
  if (!consolidationGuide) throw new Error('The review skill is missing its "Consolidate the report" section.');
  return Object.freeze({
    template: JSON.parse(template),
    workers: parseWorkerGuide(workers),
    reviewerPrompt: stripFrontmatter(reviewer).trim(),
    consolidationGuide,
  });
}

export function stripFrontmatter(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
}

export function extractSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

export function parseWorkerGuide(markdown) {
  const body = markdown.replace(/^# [^\n]*\n/, '');
  const firstRole = body.search(/^## /m);
  const intro = (firstRole === -1 ? body : body.slice(0, firstRole)).trim();
  const roles = {};
  for (const name of ROLE_NAMES) {
    const full = extractSection(markdown, name);
    if (!full) throw new Error(`The worker guide is missing the ${name} section.`);
    roles[name] = { full, summary: full.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim() };
  }
  return { intro, roles };
}
