/**
 * Which scenes were opened lately, for the scene browser's Recent tab. This
 * browser's own history, so it is kept here rather than in any preset. (A
 * saved scene's picture is in the preset: see UserPreset.thumbnail.)
 */

const RECENT_KEY = 'physbox_recent_scenes';
const RECENT_MAX = 12;

/** Fired when the recents change, so open lists can redraw. */
export const SCENE_META_CHANGED_EVENT = 'physbox:scene-meta-changed';

function announce(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SCENE_META_CHANGED_EVENT));
}

/**
 * One opened thing: `user:<name>` for a saved scene, a preset id for an
 * example, `pattern:<id>` for a pattern board. `at` is ms since the epoch.
 */
export interface RecentScene { id: string; at: number }

export function listRecent(): RecentScene[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((r): r is RecentScene => typeof r?.id === 'string' && typeof r?.at === 'number')
      : [];
  } catch {
    return [];
  }
}

function writeRecent(list: RecentScene[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // A full store loses the history, which is only a convenience.
  }
  announce();
}

/** Puts `id` at the top of the recents. Blank is not worth remembering. */
export function recordRecent(id: string, at = Date.now()): void {
  if (id === 'empty') return;
  writeRecent([{ id, at }, ...listRecent().filter((r) => r.id !== id)]);
}

export function renameRecent(from: string, to: string): void {
  const list = listRecent();
  if (!list.some((r) => r.id === from)) return;
  writeRecent(list.filter((r) => r.id !== to).map((r) => (r.id === from ? { ...r, id: to } : r)));
}

export function forgetRecent(id: string): void {
  const list = listRecent();
  if (list.some((r) => r.id === id)) writeRecent(list.filter((r) => r.id !== id));
}
