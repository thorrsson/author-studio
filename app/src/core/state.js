// The project snapshot keeps the exact shape of the plugin's state template so
// snapshots move freely between the desktop app and Copilot/Claude sessions.

export const STATUSES = Object.freeze(['idle', 'planning', 'drafting', 'editing', 'review']);

export const ACTIONS = Object.freeze({
  research: Object.freeze({ worker: 'Researcher', type: 'research', label: 'Research' }),
  world: Object.freeze({ worker: 'World Designer', type: 'world', label: 'World' }),
  plot: Object.freeze({ worker: 'Story Builder', type: 'plot', label: 'Plot' }),
  draft: Object.freeze({ worker: 'Scene Writer', type: 'chapter', label: 'Draft' }),
  edit: Object.freeze({ worker: 'Editor', type: null, label: 'Edit' }),
});

const WORKER_PHASE = Object.freeze({
  Researcher: 'planning',
  'World Designer': 'planning',
  'Story Builder': 'planning',
  'Scene Writer': 'drafting',
  Editor: 'editing',
});

export const ACCEPT_THRESHOLD = 0.75;

export function phaseForWorker(worker) {
  return WORKER_PHASE[worker] ?? 'planning';
}

export function workerForType(type) {
  return {
    research: 'Researcher',
    world: 'World Designer',
    plot: 'Story Builder',
    chapter: 'Scene Writer',
  }[type];
}

export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isString = (value) => typeof value === 'string';
const isConfidence = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);

// Checks an imported snapshot against the Author Studio contract. Problems
// that cannot be repaired safely are errors; additions needed for older
// snapshots are reported as migrations that require the author's consent.
export function validateSnapshot(input) {
  const errors = [];
  const warnings = [];
  const migrations = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['The snapshot must be a JSON object.'], warnings, migrations };
  }

  const known = ['project', 'lore', 'plot', 'characters', 'draft_progress', 'orchestrator_log', 'pending_review'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) warnings.push(`Unknown field "${key}" will not be imported.`);
  }

  const project = input.project;
  if (!isPlainObject(project)) {
    errors.push('project must be an object.');
  } else {
    if (!isString(project.title)) errors.push('project.title must be a string.');
    if (!isString(project.genre)) errors.push('project.genre must be a string (it can be empty or a free-form blend).');
    if (!STATUSES.includes(project.status)) errors.push(`project.status must be one of ${STATUSES.join(', ')}.`);
    if (project.concept === undefined) migrations.push('Add an empty project.concept field.');
    else if (!isString(project.concept)) errors.push('project.concept must be a string.');
  }

  const lore = input.lore;
  if (!isPlainObject(lore)) {
    errors.push('lore must be an object.');
  } else {
    for (const field of ['magic_system', 'tech_level']) {
      if (!isString(lore[field])) errors.push(`lore.${field} must be a string.`);
    }
    for (const field of ['key_factions', 'timeline_log']) {
      if (!Array.isArray(lore[field])) errors.push(`lore.${field} must be a list.`);
    }
  }

  const plot = input.plot;
  if (!isPlainObject(plot)) {
    errors.push('plot must be an object.');
  } else {
    for (const field of ['act_beats', 'loose_threads', 'twist_map']) {
      if (!Array.isArray(plot[field])) errors.push(`plot.${field} must be a list.`);
    }
  }

  if (!Array.isArray(input.characters)) {
    errors.push('characters must be a list.');
  } else {
    input.characters.forEach((character, index) => {
      if (!isPlainObject(character) || !isString(character.name) || !character.name.trim()) {
        errors.push(`characters[${index}] must be an object with a name.`);
        return;
      }
      for (const field of ['role', 'arc_stage', 'voice_notes']) {
        if (character[field] === undefined) migrations.push(`Add an empty ${field} to character "${character.name}".`);
        else if (!isString(character[field])) errors.push(`characters[${index}].${field} must be a string.`);
      }
    });
  }

  const progress = input.draft_progress;
  if (!isPlainObject(progress)) {
    errors.push('draft_progress must be an object.');
  } else {
    const completed = progress.completed_chapters;
    if (!Array.isArray(completed) || !completed.every(isPositiveInteger)) {
      errors.push('draft_progress.completed_chapters must list positive whole numbers.');
    } else if (new Set(completed).size !== completed.length) {
      errors.push('draft_progress.completed_chapters must not repeat a chapter.');
    }
    if (!(progress.current_chapter === '' || isPositiveInteger(progress.current_chapter))) {
      errors.push('draft_progress.current_chapter must be a positive whole number or an empty string.');
    }
    if (typeof progress.tier2_pending !== 'boolean') errors.push('draft_progress.tier2_pending must be true or false.');
  }

  if (!Array.isArray(input.orchestrator_log)) {
    errors.push('orchestrator_log must be a list.');
  } else {
    input.orchestrator_log.forEach((entry, index) => {
      if (!isPlainObject(entry) || !isString(entry.step) || !isString(entry.worker) || !isString(entry.action)) {
        errors.push(`orchestrator_log[${index}] needs step, worker, and action text.`);
      } else if (!isConfidence(entry.confidence)) {
        errors.push(`orchestrator_log[${index}].confidence must be null or a number from 0 to 1.`);
      }
    });
  }

  const pending = input.pending_review;
  const tier2 = isPlainObject(progress) ? progress.tier2_pending : undefined;
  if (pending === undefined) {
    if (tier2 === true) {
      errors.push('The snapshot says a review is pending but has no pending_review candidate. A pending gate cannot be cleared silently; supply the pending artifact.');
    } else {
      migrations.push('Add pending_review: null (no review is pending).');
    }
  } else if (pending !== null) {
    const artifact = pending?.artifact;
    if (!isPlainObject(pending)) {
      errors.push('pending_review must be null or an object.');
    } else {
      if (!isPlainObject(artifact) || !isString(artifact.id) || !artifact.id.trim() || !isString(artifact.type) || !isString(artifact.content)) {
        errors.push('pending_review.artifact needs an id, type, and its full content.');
      } else if (artifact.chapter !== undefined && artifact.chapter !== '' && !isPositiveInteger(artifact.chapter)) {
        errors.push('pending_review.artifact.chapter must be a positive whole number.');
      }
      if (!isString(pending.worker)) errors.push('pending_review.worker must be text.');
      if (!isConfidence(pending.confidence)) errors.push('pending_review.confidence must be null or a number from 0 to 1.');
      if (!Array.isArray(pending.flags) || !pending.flags.every(isString)) errors.push('pending_review.flags must be a list of text.');
      if (!isPlainObject(pending.proposed_changes)) errors.push('pending_review.proposed_changes must be an object.');
      if (!STATUSES.includes(pending.previous_status) || pending.previous_status === 'review') {
        errors.push('pending_review.previous_status must be the status to restore (idle, planning, drafting, or editing).');
      }
    }
    if (tier2 === false) errors.push('pending_review is set but draft_progress.tier2_pending is false.');
    if (isPlainObject(project) && project.status !== 'review') errors.push('A pending review requires project.status "review".');
  } else if (tier2 === true) {
    errors.push('draft_progress.tier2_pending is true but pending_review is null.');
  }
  if (isPlainObject(project) && project.status === 'review' && (pending === null || pending === undefined)) {
    errors.push('project.status is "review" but no review is pending.');
  }

  return { ok: errors.length === 0, errors, warnings, migrations };
}

// Applies only the additive migrations reported by validateSnapshot.
export function migrateSnapshot(input) {
  const snapshot = {
    project: { ...input.project },
    lore: { ...input.lore },
    plot: { ...input.plot },
    characters: input.characters.map((character) => ({
      ...character,
      role: character.role ?? '',
      arc_stage: character.arc_stage ?? '',
      voice_notes: character.voice_notes ?? '',
    })),
    draft_progress: { ...input.draft_progress },
    orchestrator_log: input.orchestrator_log.map((entry) => ({ ...entry })),
    pending_review: input.pending_review === undefined ? null : structuredClone(input.pending_review),
  };
  snapshot.project = {
    title: snapshot.project.title,
    concept: snapshot.project.concept ?? '',
    genre: snapshot.project.genre,
    status: snapshot.project.status,
  };
  return structuredClone(snapshot);
}

export function isInitialized(state) {
  return Boolean(state?.project?.concept?.trim() || state?.project?.title?.trim()) && state.project.status !== 'idle';
}
