// Making tooling again for the same part replaces what was made for it before:
// the earlier bodies come out of the scene and their note card section is
// rewritten, rather than a second set stacking up beside the first. Pure, so
// the worker-side planners can use it; the note card end is noteSection.ts.

import type { SceneGraph, SceneNode } from '../types/scene';

/** Whether two id lists name the same bodies, in any order. */
export function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** The scene without every node, at any depth, that `drop` picks, and what went. */
export function withoutNodes(scene: SceneGraph, drop: (n: SceneNode) => boolean): { scene: SceneGraph; removed: { id: string; name: string }[] } {
  const removed: { id: string; name: string }[] = [];
  const keep = (nodes: SceneNode[]): SceneNode[] => {
    const out: SceneNode[] = [];
    for (const n of nodes) {
      if (drop(n)) { removed.push({ id: n.id, name: n.name }); continue; }
      out.push(n.children?.length ? { ...n, children: keep(n.children) } : n);
    }
    return out;
  };
  const nodes = keep(scene.nodes);
  return { scene: removed.length ? { ...scene, nodes } : scene, removed };
}

/** The heading line a section starts with. */
const headingOf = (section: string) => section.split('\n', 1)[0].trim();

/** Each '## ' section of a card, with whatever comes before the first. */
function split(markdown: string): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ') && cur.length) { parts.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) parts.push(cur.join('\n'));
  return parts;
}

/**
 * A card's markdown with the section that has `section`'s heading put back in
 * its place, or `section` added at the end when the card has none.
 */
export function upsertSection(markdown: string, section: string): string {
  const head = headingOf(section);
  const parts = split(markdown);
  const at = parts.findIndex((p) => headingOf(p) === head);
  if (at < 0) return `${markdown.trimEnd()}\n\n${section}`;
  parts[at] = `${section.trimEnd()}\n`;
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** A card's markdown without the sections headed `## <title>` for each title. */
export function dropSections(markdown: string, titles: readonly string[]): string {
  if (!titles.length) return markdown;
  const heads = new Set(titles.map((t) => `## ${t}`));
  return split(markdown).filter((p) => !heads.has(headingOf(p))).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
