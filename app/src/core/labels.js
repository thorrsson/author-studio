// Display labels shared by the engine (log entries) and the renderer.

const TYPE_LABELS = {
  brief: 'Creative brief',
  research: 'Research brief',
  world: 'Setting',
  plot: 'Story plan',
  chapter: 'Chapter',
};

export function parseArtifactId(id) {
  const value = String(id ?? '');
  const chapter = /^chapter-(\d+)-v(\d+)$/.exec(value);
  if (chapter) return { base: `chapter-${chapter[1]}`, version: Number(chapter[2]), chapter: Number(chapter[1]) };
  const versioned = /^(.+)-v(\d+)$/.exec(value);
  if (versioned) return { base: versioned[1], version: Number(versioned[2]) };
  return { base: value, version: 1 };
}

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Artifact');
}

export function artifactLabel(artifact) {
  if (!artifact) return '';
  const { version } = parseArtifactId(artifact.id);
  if (artifact.type === 'brief') return TYPE_LABELS.brief;
  if (artifact.type === 'chapter' && artifact.chapter) {
    return version > 1 ? `Chapter ${artifact.chapter}, version ${version}` : `Chapter ${artifact.chapter}`;
  }
  const index = /-(\d+)(?:-v\d+)?$/.exec(artifact.id)?.[1];
  const name = typeLabel(artifact.type);
  const numbered = index && index !== '1' ? `${name} ${index}` : name;
  return version > 1 ? `${numbered}, version ${version}` : numbered;
}

export const STATUS_LABELS = {
  idle: 'Not started',
  planning: 'Planning',
  drafting: 'Drafting',
  editing: 'Editing',
  review: 'Waiting for your review',
};

export const ARTIFACT_STATUS_LABELS = {
  accepted: 'Accepted',
  pending: 'Waiting for review',
  superseded: 'Replaced by a newer version',
  revised: 'Revised',
  rejected: 'Rejected',
};

export function formatConfidence(confidence) {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence.toFixed(2) : 'unassessed';
}
