// Proposed canon changes ("patches") are additive by default so that a model
// cannot silently drop accepted canon. Overwrites of established canon are
// detected here and treated as contradictions that need the author's decision.
import { isPlainObject, isPositiveInteger } from './state.js';

const LORE_TEXT = ['magic_system', 'tech_level'];
const LORE_LISTS = ['key_factions', 'timeline_log'];
const PLOT_LISTS = ['act_beats', 'loose_threads', 'twist_map'];
const CHARACTER_FIELDS = ['role', 'arc_stage', 'voice_notes'];
const MAX_ITEMS = 100;
const MAX_TEXT = 4000;

const FIELD_LABELS = {
  magic_system: 'magic system',
  tech_level: 'technology and period',
  key_factions: 'group',
  timeline_log: 'timeline event',
  act_beats: 'story beat',
  loose_threads: 'open thread',
  twist_map: 'twist',
};

export function normKey(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.toLowerCase().replace(/[\s\u00a0]+/g, ' ').replace(/[.;,:!?]+$/, '').trim();
}

function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clip(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return clip(value.map(toText).filter(Boolean).join('; '));
  if (isPlainObject(value)) {
    const name = toText(value.name ?? value.title ?? value.when ?? value.date ?? '');
    const detail = toText(value.description ?? value.summary ?? value.event ?? value.notes ?? value.detail ?? '');
    if (name && detail) return clip(`${name}: ${detail}`);
    if (name || detail) return name || detail;
    return clip(Object.entries(value).map(([key, item]) => `${key}: ${toText(item)}`).join('; '));
  }
  return '';
}

function toList(value) {
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const text = toText(item);
    const key = normKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= MAX_ITEMS) break;
  }
  return output;
}

// Sanitizes untrusted proposed changes into the app's patch format.
export function normalizePatch(raw, { allowDraftProgress = false } = {}) {
  const patch = {};
  const notes = [];
  if (raw === undefined || raw === null) return { patch, notes };
  if (!isPlainObject(raw)) return { patch, notes: ['Ignored proposed changes that were not in the expected format.'] };

  if (isPlainObject(raw.lore)) {
    const lore = {};
    for (const field of LORE_TEXT) {
      const text = toText(raw.lore[field]);
      if (text) lore[field] = text;
    }
    for (const field of LORE_LISTS) {
      const list = toList(raw.lore[field]);
      if (list.length) lore[field] = list;
    }
    if (Object.keys(lore).length) patch.lore = lore;
  }

  if (isPlainObject(raw.plot)) {
    const plot = {};
    for (const field of [...PLOT_LISTS, 'resolved_threads']) {
      const list = toList(raw.plot[field]);
      if (list.length) plot[field] = list;
    }
    if (raw.plot.replace_act_beats === true && plot.act_beats) plot.replace_act_beats = true;
    if (Object.keys(plot).length) patch.plot = plot;
  }

  const rawCharacters = Array.isArray(raw.characters) ? raw.characters : isPlainObject(raw.characters) ? [raw.characters] : [];
  const characters = [];
  const names = new Set();
  for (const item of rawCharacters) {
    if (!isPlainObject(item)) continue;
    const name = toText(item.name);
    if (!name || names.has(normKey(name))) continue;
    names.add(normKey(name));
    const character = { name };
    for (const field of CHARACTER_FIELDS) {
      const text = toText(item[field]);
      if (text) character[field] = text;
    }
    characters.push(character);
    if (characters.length >= MAX_ITEMS) break;
  }
  if (rawCharacters.length && characters.length < rawCharacters.length) {
    notes.push('Some proposed character entries were missing a name and were ignored.');
  }
  if (characters.length) patch.characters = characters;

  if (allowDraftProgress && isPlainObject(raw.draft_progress)) {
    const progress = {};
    const completed = (Array.isArray(raw.draft_progress.completed_chapters) ? raw.draft_progress.completed_chapters : [])
      .filter(isPositiveInteger);
    if (completed.length) progress.completed_chapters = [...new Set(completed)].sort((a, b) => a - b);
    if (isPositiveInteger(raw.draft_progress.current_chapter)) progress.current_chapter = raw.draft_progress.current_chapter;
    if (Object.keys(progress).length) patch.draft_progress = progress;
  }

  return { patch, notes };
}

export function isEmptyPatch(patch) {
  return !patch || Object.keys(patch).length === 0;
}

// Combines two patches, e.g. when a continuation extends a pending draft.
export function mergePatches(first = {}, second = {}) {
  const merged = structuredClone(first);
  for (const section of ['lore', 'plot']) {
    if (!second[section]) continue;
    merged[section] ??= {};
    for (const [field, value] of Object.entries(second[section])) {
      if (Array.isArray(value)) merged[section][field] = toList([...(merged[section][field] ?? []), ...value]);
      else merged[section][field] = value;
    }
  }
  if (second.characters) {
    const byName = new Map((merged.characters ?? []).map((character) => [normKey(character.name), character]));
    for (const character of second.characters) {
      byName.set(normKey(character.name), { ...(byName.get(normKey(character.name)) ?? {}), ...character });
    }
    merged.characters = [...byName.values()];
  }
  if (second.draft_progress) merged.draft_progress = { ...(merged.draft_progress ?? {}), ...second.draft_progress };
  return merged;
}

const isRefinement = (current, next) => {
  const a = normKey(current);
  const b = normKey(next);
  // Only appended detail counts; text placed before it (e.g. "Not ...") could reverse it.
  return a === b || (b.startsWith(a) && !/[\p{L}\p{N}]/u.test(b[a.length]));
};

const preview = (text) => {
  const value = toText(text);
  return value.length > 120 ? `${value.slice(0, 117)}…` : value;
};

// Lists every change that would overwrite (not just extend) accepted canon.
export function detectCanonChanges(state, patch) {
  const changes = [];
  for (const field of LORE_TEXT) {
    const current = state.lore?.[field];
    const next = patch.lore?.[field];
    if (typeof current === 'string' && current.trim() && next && !isRefinement(current, next)) {
      changes.push({
        path: `lore.${field}`,
        text: `Replaces the accepted ${FIELD_LABELS[field]} ("${preview(current)}") with "${preview(next)}".`,
      });
    }
  }
  const beats = state.plot?.act_beats ?? [];
  if (patch.plot?.replace_act_beats && beats.length) {
    const same = beats.length === patch.plot.act_beats.length
      && beats.every((beat, index) => normKey(toText(beat)) === normKey(patch.plot.act_beats[index]));
    if (!same) {
      changes.push({
        path: 'plot.act_beats',
        text: `Replaces the accepted story structure (${beats.length} beats) with ${patch.plot.act_beats.length} new beats.`,
      });
    }
  }
  for (const proposed of patch.characters ?? []) {
    const existing = (state.characters ?? []).find((character) => normKey(character.name ?? '') === normKey(proposed.name));
    if (!existing) continue;
    for (const field of ['role', 'voice_notes']) {
      const current = existing[field];
      const next = proposed[field];
      if (typeof current === 'string' && current.trim() && next && !isRefinement(current, next)) {
        changes.push({
          path: `characters.${existing.name}.${field}`,
          text: `Changes ${existing.name}'s accepted ${field === 'role' ? 'role' : 'voice notes'} ("${preview(current)}") to "${preview(next)}".`,
        });
      }
    }
  }
  return changes;
}

function appendUnique(list, additions) {
  const output = [...list];
  const seen = new Set(output.map((item) => normKey(toText(item))));
  for (const item of additions) {
    const key = normKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

// Returns a new state with the patch applied. The input is never mutated.
export function applyPatch(state, patch) {
  const next = structuredClone(state);
  if (patch.lore) {
    for (const field of LORE_TEXT) if (patch.lore[field]) next.lore[field] = patch.lore[field];
    for (const field of LORE_LISTS) if (patch.lore[field]) next.lore[field] = appendUnique(next.lore[field], patch.lore[field]);
  }
  if (patch.plot) {
    if (patch.plot.act_beats) {
      next.plot.act_beats = patch.plot.replace_act_beats
        ? [...patch.plot.act_beats]
        : appendUnique(next.plot.act_beats, patch.plot.act_beats);
    }
    for (const field of ['loose_threads', 'twist_map']) {
      if (patch.plot[field]) next.plot[field] = appendUnique(next.plot[field], patch.plot[field]);
    }
    if (patch.plot.resolved_threads) {
      const resolved = new Set(patch.plot.resolved_threads.map(normKey));
      next.plot.loose_threads = next.plot.loose_threads.filter((thread) => !resolved.has(normKey(toText(thread))));
    }
  }
  for (const proposed of patch.characters ?? []) {
    const existing = next.characters.find((character) => normKey(character.name ?? '') === normKey(proposed.name));
    if (existing) {
      for (const field of CHARACTER_FIELDS) if (proposed[field]) existing[field] = proposed[field];
    } else {
      next.characters.push({
        name: proposed.name,
        role: proposed.role ?? '',
        arc_stage: proposed.arc_stage ?? '',
        voice_notes: proposed.voice_notes ?? '',
      });
    }
  }
  if (patch.draft_progress) {
    const progress = next.draft_progress;
    if (patch.draft_progress.completed_chapters) {
      progress.completed_chapters = [...new Set([...progress.completed_chapters, ...patch.draft_progress.completed_chapters])]
        .sort((a, b) => a - b);
    }
    if (patch.draft_progress.current_chapter) progress.current_chapter = patch.draft_progress.current_chapter;
  }
  return next;
}

// Human-readable lines for the review screen and the orchestrator log.
export function describePatch(patch, state) {
  const lines = [];
  if (!patch) return lines;
  for (const field of LORE_TEXT) {
    if (patch.lore?.[field]) lines.push(`Set ${FIELD_LABELS[field]}: ${patch.lore[field]}`);
  }
  for (const field of LORE_LISTS) {
    for (const item of patch.lore?.[field] ?? []) lines.push(`Add ${FIELD_LABELS[field]}: ${item}`);
  }
  if (patch.plot?.replace_act_beats) {
    lines.push(`Replace the story structure with ${patch.plot.act_beats.length} beats:`);
    patch.plot.act_beats.forEach((beat, index) => lines.push(`  ${index + 1}. ${beat}`));
  } else {
    for (const beat of patch.plot?.act_beats ?? []) lines.push(`Add ${FIELD_LABELS.act_beats}: ${beat}`);
  }
  for (const thread of patch.plot?.loose_threads ?? []) lines.push(`Add ${FIELD_LABELS.loose_threads}: ${thread}`);
  const openThreads = new Set((state?.plot?.loose_threads ?? []).map((thread) => normKey(toText(thread))));
  for (const thread of patch.plot?.resolved_threads ?? []) {
    lines.push(state && !openThreads.has(normKey(thread))
      ? `Resolve thread (not found among open threads, no change): ${thread}`
      : `Resolve thread: ${thread}`);
  }
  for (const twist of patch.plot?.twist_map ?? []) lines.push(`Add ${FIELD_LABELS.twist_map}: ${twist}`);
  for (const character of patch.characters ?? []) {
    const existing = state?.characters?.some((item) => normKey(item.name ?? '') === normKey(character.name));
    const details = CHARACTER_FIELDS.filter((field) => character[field])
      .map((field) => `${field.replace('_', ' ')}: ${character[field]}`)
      .join('; ');
    lines.push(`${existing ? 'Update' : 'Add'} character ${character.name}${details ? ` (${details})` : ''}`);
  }
  if (patch.draft_progress?.completed_chapters?.length) {
    lines.push(`Mark unit ${patch.draft_progress.completed_chapters.join(', ')} complete`);
  }
  if (patch.draft_progress?.current_chapter) lines.push(`Set current unit to ${patch.draft_progress.current_chapter}`);
  return lines;
}
