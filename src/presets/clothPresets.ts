/**
 * Cloth scenes: a dress form wearing a t-shirt, the same form in a dress, and
 * a shade sail on four posts. All built from the generic cloth parts
 * (utils/cloth): the garments are drafted from the form's measurements, and
 * the sail is one piece tied to the posts.
 */

import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothEdge, UV } from '../types/cloth';
import { bodyFormNode, garmentNode } from '../utils/cloth/clothNodes';

function formWearing(garment: 'tshirt' | 'dress'): SceneGraph {
  // A man's t-shirt on a male form, a dress on a female one.
  const form = bodyFormNode('form', 'form', { figure: garment === 'dress' ? 'female' : 'male' });
  const worn = garmentNode(garment, garment, { garment }, form);
  return {
    nodes: [form, worn],
  } as SceneGraph;
}

export const tshirtOnFormPreset = formWearing('tshirt');
export const dressOnFormPreset = formWearing('dress');

/** A sail edge from `a` to `b`, cut in toward the middle by `sag` of its length, as sails are. */
function catenaryEdge(id: string, a: UV, b: UV, sag: number): ClothEdge {
  const pts: UV[] = [];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  // Inward normal of a counter-clockwise outline: the edge direction turned left.
  const nx = -dy / len, ny = dx / len;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, k = 4 * t * (1 - t) * sag * len;
    pts.push([a[0] + dx * t + nx * k, a[1] + dy * t + ny * k]);
  }
  return { id, pts };
}

const SPAN = 4, LOW = 2.4, HIGH = 3.2;
const posts: [number, number, number][] = [[-SPAN / 2, -SPAN / 2, LOW], [SPAN / 2, -SPAN / 2, HIGH], [SPAN / 2, SPAN / 2, LOW], [-SPAN / 2, SPAN / 2, HIGH]];

function shadeSail(): SceneGraph {
  // Cut 4% small, so the sail is stretched taut when its corners reach the posts.
  const c = (SPAN * 0.96) / 2;
  const corners: UV[] = [[-c, -c], [c, -c], [c, c], [-c, c]];
  const ids = ['south', 'east', 'north', 'west'];
  const edges = ids.map((id, i) => catenaryEdge(id, corners[i], corners[(i + 1) % 4], 0.06));
  const postNodes: SceneNode[] = posts.map(([x, y, h], i) => ({
    id: `post${i + 1}`, name: `post${i + 1}`, pos: [x, y, h / 2],
    geoms: [{ name: `post${i + 1}_pipe`, type: 'cylinder', size: [0.045, h / 2], rgba: [0.55, 0.57, 0.6, 1] }],
    joints: [],
  } as unknown as SceneNode));
  const sail = {
    id: 'sail', name: 'sail', pos: [0, 0, (LOW + HIGH) / 2],
    cloth: {
      pieces: [{ name: 'sheet', edges, rgba: [0.93, 0.62, 0.2, 1] }],
      material: 'shadeCloth',
      spacing: 0.16,
      // Each corner shackled to the top of its post, wound in to tension it.
      ties: posts.map(([, , h], i) => ({ name: `corner${i + 1}`, piece: 'sheet', edge: ids[i], at: 0, to: `post${i + 1}`, anchor: [0, 0, h / 2 + 0.03] })),
    },
    joints: [],
  } as unknown as SceneNode;
  return {
    nodes: [...postNodes, sail],
  } as SceneGraph;
}

export const shadeSailPreset = shadeSail();
