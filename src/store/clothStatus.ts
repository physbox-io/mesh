/**
 * What the cloth's specs named that is not in them, and the cloths that could
 * not be built, as of the last build (the worker's CLOTH_STATUS). Each is
 * prefixed with its cloth's name. Read by physics_get_state, by the reply of
 * the command that caused it, and by the Garment card, which shows its own.
 * A store of its own: none of it is part of a scene.
 */

import { create } from 'zustand';

export const useClothStatus = create<{ warnings: string[] }>(() => ({ warnings: [] }));

export function noteClothWarnings(warnings: string[]): void {
  const now = useClothStatus.getState().warnings;
  if (now.length === warnings.length && now.every((w, i) => w === warnings[i])) return;
  useClothStatus.setState({ warnings });
}

export function lastClothWarnings(): string[] {
  return useClothStatus.getState().warnings;
}

/** The warnings about the cloth named `name`, its prefix taken off. */
export function clothWarningsOf(warnings: string[], name: string): string[] {
  const p = `${name}: `;
  return warnings.filter((w) => w.startsWith(p)).map((w) => w.slice(p.length));
}

/** The warnings about any of the cloths named, as they are reported (each with its cloth's name). */
export function clothWarningsFor(names: Iterable<string>): string[] {
  const want = [...names].map((n) => `${n}: `);
  return lastClothWarnings().filter((w) => want.some((p) => w.startsWith(p)));
}

/** The names of the cloths in a scene tree, at any depth. */
export function clothNamesIn(nodes: { name?: string; id: string; cloth?: unknown; children?: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (list: typeof nodes) => { for (const n of list) { if (n.cloth) out.push(n.name || n.id); walk((n.children ?? []) as typeof nodes); } };
  walk(nodes);
  return out;
}
