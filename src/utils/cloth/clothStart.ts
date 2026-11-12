/**
 * Starting cloth work from nothing: a new dress form, and a new garment on a
 * form or on none. Nodes only; the store adds them. A new form's geoms are left for the
 * editor to build from its measurements in a worker (useCsgCompile), so
 * adding one does not stall the page.
 */

import type { BodyFigure, GarmentKind } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { clampBodyForm } from './bodyForm';
import { garmentNode, looseGarmentNode } from './clothNodes';

const allNodes = (nodes: SceneNode[]): SceneNode[] => nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);

/** `base`, or `base_2`, `base_3` ...: the first no node in the scene is called. */
function freeName(nodes: SceneNode[], base: string): string {
  const taken = new Set(allNodes(nodes).map((n) => n.name || n.id));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`;
}

const rid = () => Math.random().toString(36).slice(2, 10);

/** The scene's dress forms. */
export function formsIn(nodes: SceneNode[]): SceneNode[] {
  return allNodes(nodes).filter((n) => !!n.bodyForm);
}

/** Where a new figure stands: at the origin, or 0.8 m along x past the forms and the garments on none already there. */
function clearX(nodes: SceneNode[]): number {
  const others = allNodes(nodes).filter((n) => n.bodyForm || (n.cloth?.garment && !n.cloth.garment.fitTo));
  return others.length ? Math.max(...others.map((f) => f.pos?.[0] ?? 0)) + 0.8 : 0;
}

/** A dress form of the figure's usual measurements, standing clear of the forms already there. */
export function newFormNode(nodes: SceneNode[], figure: BodyFigure): SceneNode {
  const name = freeName(nodes, 'form');
  const x = clearX(nodes);
  return { id: `form_${rid()}`, name, pos: [x, 0, 0], bodyForm: clampBodyForm({ figure }), geoms: [], joints: [], children: [] } as unknown as SceneNode;
}

/**
 * A garment of `kind` on `form`, its kind's usual draft, worn one layer out
 * from the garments already fitted to that form (the first next to the body).
 */
export function newGarmentNode(nodes: SceneNode[], kind: GarmentKind, form: SceneNode): SceneNode {
  const formName = form.name || form.id;
  const on = allNodes(nodes).filter((n) => n.cloth?.garment?.fitTo === formName);
  const layer = on.length ? Math.max(...on.map((n) => n.cloth?.layer ?? 0)) + 1 : 0;
  const node = garmentNode(`${kind}_${rid()}`, freeName(nodes, kind), { garment: kind }, form);
  node.cloth!.layer = layer;
  return node;
}

/**
 * A garment of `kind` on no form, cut to the figure's usual measurements and
 * standing clear of the forms there as it would be worn: it falls when the
 * scene plays.
 */
export function newLooseGarmentNode(nodes: SceneNode[], kind: GarmentKind, figure: BodyFigure): SceneNode {
  return looseGarmentNode(`${kind}_${rid()}`, freeName(nodes, kind), { garment: kind }, { figure }, [clearX(nodes), 0, 0]);
}
