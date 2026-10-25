/**
 * What the scene browser lists: the built-in examples by shelf, and a search
 * across them, the saved scenes and the pattern boards at once.
 *
 * Pure, so it is tested without a browser. The shelves live here rather than
 * as a field on each PRESETS entry because presetScenes.ts is also read by the
 * native app's exporter, and a shelf is a menu decision, not part of a scene.
 */

import { PRESETS } from '../presets/presetScenes';

export type ExampleShelf = 'Start here' | 'Mechanisms' | 'Machines & robots' | 'Bridges' | 'Make it' | 'Sculpture';

/** The order the shelves are shown in. */
export const EXAMPLE_SHELVES: ExampleShelf[] = ['Start here', 'Make it', 'Mechanisms', 'Machines & robots', 'Bridges', 'Sculpture'];

/**
 * Which shelf each preset sits on. A preset missing from here still shows,
 * under the last shelf; tests/sceneCatalog.test.ts makes sure none is missing.
 */
export const PRESET_SHELF: Record<string, ExampleShelf> = {
  empty: 'Start here',
  cut_tutorial: 'Start here',

  casting_flask: 'Make it',
  birdhouse: 'Make it',
  birdhouse_scad: 'Make it',
  california_relief: 'Make it',
  lattice_bracket: 'Make it',
  soap_dish: 'Make it',
  chest_of_drawers: 'Make it',
  sealed_jar: 'Make it',
  flower_stand: 'Make it',
  boolean_shapes: 'Make it',
  openscad_demo: 'Make it',

  pendulum: 'Mechanisms',
  stepper_turntable: 'Mechanisms',
  spring_launcher: 'Mechanisms',
  cubes: 'Mechanisms',
  gears: 'Mechanisms',
  machine: 'Mechanisms',
  rack_pinion: 'Mechanisms',
  inclined_plane: 'Mechanisms',
  oval_track: 'Mechanisms',
  pulley_system: 'Mechanisms',
  newtons_cradle: 'Mechanisms',
  coin_flip: 'Mechanisms',
  bouncy_balls: 'Mechanisms',
  mesh_collision: 'Mechanisms',
  shatter: 'Mechanisms',

  cartpole: 'Machines & robots',
  xy_plotter: 'Machines & robots',
  extrusion_frame: 'Machines & robots',
  volt_gripper: 'Machines & robots',
  volt_stepper_dial: 'Machines & robots',
  drone: 'Machines & robots',
  windmill: 'Machines & robots',
  physics_only_windmill: 'Machines & robots',
  traditional_windmill: 'Machines & robots',
  paper_plane: 'Machines & robots',

  suspension_bridge: 'Bridges',
  golden_gate: 'Bridges',
  golden_gate_mesh: 'Bridges',
  rope_bridge: 'Bridges',

  monkey_head: 'Sculpture',
  oak_tree: 'Sculpture',
  mega_bust_studio: 'Sculpture',
};

export interface ExampleEntry {
  id: string;
  name: string;
  emoji: string;
  shelf: ExampleShelf;
}

/** Every built-in preset, shelved, in the shelves' order and then the map's. */
export function exampleEntries(): ExampleEntry[] {
  const entries = Object.entries(PRESETS as Record<string, { name: string; emoji?: string }>).map(([id, p]) => ({
    id,
    name: p.name,
    emoji: p.emoji ?? '🧩',
    shelf: PRESET_SHELF[id] ?? EXAMPLE_SHELVES[EXAMPLE_SHELVES.length - 1],
  }));
  return EXAMPLE_SHELVES.flatMap((shelf) => entries.filter((e) => e.shelf === shelf));
}

/**
 * Whether `query` finds `text`: every word of the query has to appear, in any
 * order, ignoring case and accents. "gate mesh" finds "Golden Gate (Mesh)".
 */
export function matchesQuery(query: string, ...text: (string | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(text.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * A free name for a copy of `name`: "Bracket copy", then "Bracket copy 2"…
 */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${name.replace(/ copy( \d+)?$/, '')} copy`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/**
 * A date the way a file list shows one: the time today, "Yesterday", the day
 * and month this year, and the year as well before that.
 */
export function formatSceneDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= startOfToday - 86_400_000) return 'Yesterday';
  return d.toLocaleDateString(undefined, d.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}
