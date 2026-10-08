import { artifactLabel } from './labels.js';

export const EXPORT_TARGETS = Object.freeze({
  manuscript: { label: 'Manuscript', description: 'Every accepted chapter in order.' },
  bible: { label: 'Story bible', description: 'Established canon and full accepted research, setting, and story plans.' },
  research: { label: 'Research', description: 'Every accepted research brief, including references and uncertainties.' },
  world: { label: 'Setting', description: 'Every accepted setting document.' },
  plot: { label: 'Story plan', description: 'Every accepted story plan.' },
  brief: { label: 'Idea and brief', description: 'The saved story idea, genre, and accepted creative brief.' },
  planning: { label: 'Planning packet', description: 'Idea and brief, established canon, and all accepted planning documents. No manuscript.' },
});

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join('; ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replace(/_/g, ' ')}: ${valueText(item)}`).join('; ');
  return String(value);
}

function canonSections({ lore, plot, characters }) {
  const sections = [];
  if (characters.length) sections.push(`## Characters\n\n${characters.map((character) => {
    const details = Object.entries(character).filter(([key, value]) => key !== 'name' && valueText(value))
      .map(([key, value]) => `- ${key.replace(/_/g, ' ')}: ${valueText(value)}`).join('\n');
    return `### ${character.name}\n\n${details}`;
  }).join('\n\n')}`);
  for (const [label, value, ordered] of [
    ['Technology and period', lore.tech_level],
    ['Rules of the world', lore.magic_system],
    ['Groups and factions', lore.key_factions],
    ['Timeline', lore.timeline_log],
    ['Story beats', plot.act_beats, true],
    ['Open threads', plot.loose_threads],
    ['Twists and reveals', plot.twist_map],
  ]) {
    const text = Array.isArray(value)
      ? value.map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${valueText(item)}`).join('\n')
      : valueText(value);
    if (text) sections.push(`## ${label}\n\n${text}`);
  }
  return sections;
}

function documents(project, type) {
  return Object.values(project.artifacts ?? {})
    .filter((artifact) => artifact.status === 'accepted' && artifact.type === type)
    .sort((a, b) => String(a.acceptedAt ?? a.createdAt).localeCompare(String(b.acceptedAt ?? b.createdAt)));
}

function briefSections(project) {
  const { genre, concept } = project.state.project;
  const sections = [];
  if (genre) sections.push(`## Genre\n\n${genre}`);
  if (concept) sections.push(`## Story idea\n\n${concept}`);
  const brief = documents(project, 'brief').at(-1);
  if (brief?.content) sections.push(`## Creative brief\n\n${brief.content}`);
  return sections;
}

export function canExport(project, target) {
  if (!Object.hasOwn(EXPORT_TARGETS, target)) return false;
  if (target === 'brief') return briefSections(project).length > 0;
  if (target === 'planning') return canExport(project, 'brief') || canExport(project, 'bible');
  if (target === 'bible') return canonSections(project.state).length > 0
    || ['research', 'world', 'plot'].some((type) => documents(project, type).length > 0);
  return documents(project, target === 'manuscript' ? 'chapter' : target).length > 0;
}

export function exportMarkdown(project, target) {
  if (target === 'manuscript') return manuscriptMarkdown(project);
  const sections = [`# ${project.state.project.title || 'Untitled'} - ${EXPORT_TARGETS[target].label}`];
  if (['brief', 'planning'].includes(target)) sections.push(...briefSections(project));
  if (['bible', 'planning'].includes(target)) sections.push(...canonSections(project.state));
  const types = ['bible', 'planning'].includes(target) ? ['research', 'world', 'plot'] : target === 'brief' ? [] : [target];
  for (const type of types) {
    for (const artifact of documents(project, type)) {
      sections.push(`## ${artifactLabel(artifact)} (${artifact.id})\n\n${artifact.content}${artifact.complete === false ? '\n\n*[Unfinished]*' : ''}`);
    }
  }
  return `${sections.join('\n\n')}\n`;
}

export function manuscriptMarkdown(project) {
  const chapters = documents(project, 'chapter').sort((a, b) => a.chapter - b.chapter);
  const parts = [`# ${project.state.project.title || 'Untitled'}`];
  for (const chapter of chapters) {
    const body = /^#{1,6}\s/.test(chapter.content) ? chapter.content.replace(/^#\s/, '## ') : `## Chapter ${chapter.chapter}\n\n${chapter.content}`;
    parts.push(chapter.complete === false ? `${body}\n\n*[Unfinished]*` : body);
  }
  if (!chapters.length) parts.push('*No accepted chapters yet.*');
  return `${parts.join('\n\n')}\n`;
}
