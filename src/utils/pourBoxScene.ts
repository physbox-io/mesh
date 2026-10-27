// The pour box (utils/siliconeMold.ts) as bodies in the scene: a base and a
// sleeve beside the master, where they would stand round it on the bench, and
// a hole's pin fixed to the master as a rigid child. One undo step.

import * as THREE from 'three';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';
import { partSoups } from './partSoups';
import { buildPourBox, topZAt, type HolePurpose, type PourBox, type PourBoxMesh, type PourBoxOptions } from './siliconeMold';
import { loadManifold } from './sculptCut';

/** The selected bodies, rigid children included, as one soup in world mm. */
export function masterSoupMm(scene: SceneGraph, ids: string[]): Float64Array {
  const parts: Float64Array[] = [];
  const wanted = new Set(ids);
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      if (wanted.has(n.id)) {
        parts.push(...partSoups(n, world).soups);
        continue;
      }
      walk(n.children || [], world);
    }
  };
  walk(scene.nodes);
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Float64Array(length);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[at + i] = p[i] * 1000;
    at += p.length;
  }
  return out;
}

/** Plans the pour box round the given bodies without touching the scene. */
export async function planPourBox(scene: SceneGraph, ids: string[], options: Partial<PourBoxOptions>): Promise<PourBox> {
  const soup = masterSoupMm(scene, ids);
  if (soup.length < 9) throw new Error('Select the master: the body to make a silicone mold of.');
  return buildPourBox(await loadManifold(), soup, options);
}

/** A static mesh body from a mesh in world mm, its origin on the middle of its footprint. */
function meshBody(id: string, name: string, m: PourBoxMesh, rgba: number[]): SceneNode {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
  }
  const origin = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
  const renderVertices: number[] = new Array(m.positions.length);
  const vertices: number[] = new Array(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = (m.positions[i] - origin[0]) / 1000;
    const y = (m.positions[i + 1] - origin[1]) / 1000;
    const z = (m.positions[i + 2] - origin[2]) / 1000;
    renderVertices[i] = x; renderVertices[i + 1] = y; renderVertices[i + 2] = z;
    // Three.js Y-up, the inverse of mjcf.ts's (x, y, z) -> (x, -z, y).
    vertices[i] = x; vertices[i + 1] = z; vertices[i + 2] = -y;
  }
  const geom: SceneGeom = {
    name: `${name}_mesh`,
    type: 'mesh',
    size: [1],
    rgba,
    dynamic: true,
    vertices,
    renderVertices,
    faces: m.faces,
  };
  return { id, name, type: 'body', pos: origin.map((v) => v / 1000) as [number, number, number], geoms: [geom], joints: [], children: [] } as SceneNode;
}

/** Where a body is in the world, found by walking down to it. */
function worldOf(nodes: SceneNode[], id: string, parent?: THREE.Matrix4): THREE.Matrix4 | null {
  for (const n of nodes) {
    const world = getNodeWorldTransform(n, parent);
    if (n.id === id) return world;
    const found = worldOf(n.children || [], id, world);
    if (found) return found;
  }
  return null;
}

/**
 * The scene with the pour box added. The base and sleeve go in at the top
 * level; a hole's pin goes under the first master, in its frame, with no joint, so
 * it moves with it and prints as part of it.
 */
export function sceneWithPourBox(scene: SceneGraph, ids: string[], box: PourBox): { scene: SceneGraph; baseId: string; sleeveId: string; holePinId?: string } {
  const tag = Math.random().toString(36).slice(2, 7);
  const masterName = (() => {
    const find = (nodes: SceneNode[]): SceneNode | null => {
      for (const n of nodes) {
        if (n.id === ids[0]) return n;
        const c = find(n.children || []);
        if (c) return c;
      }
      return null;
    };
    return find(scene.nodes)?.name ?? 'master';
  })();
  const pourBox = { pourDepthMm: box.report.pourDepthMm, silicone: box.report.silicone };
  const base: SceneNode = { ...meshBody(`pourbase_${tag}`, `${masterName}_pour_base`, box.base, [0.62, 0.64, 0.68, 1]), pourBox };
  // Translucent so the master shows through it; it still collides.
  const sleeve: SceneNode = {
    ...meshBody(`poursleeve_${tag}`, `${masterName}_pour_sleeve`, box.sleeve, [0.55, 0.75, 0.95, 0.35]),
    pourBox,
  };
  const nodes = [...scene.nodes, base, sleeve];
  let holePinId: string | undefined;
  if (box.hole) {
    // On the master the hole is over (the highest there, of several), so it
    // moves with that one.
    const [hx, hy] = box.hole.footMm;
    let pinOn = ids[0];
    let best = -Infinity;
    for (const id of ids) {
      const z = topZAt(masterSoupMm(scene, [id]), hx, hy);
      if (z !== null && z > best) { best = z; pinOn = id; }
    }
    const world = worldOf(scene.nodes, pinOn);
    if (world) {
      const toLocal = world.clone().invert();
      const { footMm, lengthMm, diaMm, purpose } = box.hole;
      const centre = new THREE.Vector3(footMm[0], footMm[1], footMm[2] + lengthMm / 2).multiplyScalar(1 / 1000).applyMatrix4(toLocal);
      const q = new THREE.Quaternion();
      toLocal.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      holePinId = `holepin_${tag}`;
      const pin = {
        id: holePinId,
        name: `${masterName}_${purpose}_hole_pin`,
        type: 'body',
        pos: [centre.x, centre.y, centre.z],
        quat: [q.w, q.x, q.y, q.z],
        joints: [],
        geoms: [{ name: `${masterName}_${purpose}_hole_pin_geom`, type: 'cylinder', size: [diaMm / 2000, lengthMm / 2000], rgba: [0.85, 0.55, 0.2, 1] }],
        children: [],
        // Tooling, like the base and sleeve: never part of what is molded.
        pourBox,
      } as unknown as SceneNode;
      const attach = (list: SceneNode[]): SceneNode[] => list.map((n) =>
        n.id === pinOn ? { ...n, children: [...(n.children || []), pin] } : { ...n, children: attach(n.children || []) });
      nodes.splice(0, scene.nodes.length, ...attach(scene.nodes));
    }
  }
  return { scene: { ...scene, nodes }, baseId: base.id, sleeveId: sleeve.id, ...(holePinId ? { holePinId } : {}) };
}

/** What each hole is for, in the note card's words. */
const HOLE_USE: Record<HolePurpose, string> = {
  wick: 'hole through the silicone for a wick; plug it with the wick when you pour.',
  pour: 'hole through the silicone to pour through, the mold standing as it was made, on the base.',
  fixing: 'hole through the silicone for a fixing; plug it when you pour.',
};

/** Lines for the scene's note card; the hole only when its pin went in. */
export function pourBoxNotes(name: string, box: PourBox, pinAdded = Boolean(box.hole)): string[] {
  const r = box.report;
  return [
    `## Silicone pour box for ${name}`,
    '',
    `- Print the base (${r.baseFootprintMm[0]} × ${r.baseFootprintMm[1]} mm) and the sleeve (${r.sleeveFootprintMm[0]} × ${r.sleeveFootprintMm[1]} × ${r.sleeveHeightMm} mm). Stand the master on the base, inside the groove, and drop the sleeve into the groove.`,
    `- Fill to ${r.fillHeightMm} mm above the base: ${r.siliconeMm3.toLocaleString()} mm³, ${r.siliconeG} g of ${r.siliconeName.toLowerCase()} (${r.partAG} g A + ${r.partBG} g B). Mix 10% extra for what stays in the cup.`,
    ...(box.hole && pinAdded ? [`- Print the ${box.hole.purpose} pin (${box.hole.diaMm} mm across, ${box.hole.lengthMm.toFixed(1)} mm long) and stand it on the master: it rises ${(r.fillZMm + 1 - (box.hole.footMm[2] + 0.5)).toFixed(1)} mm above the master, 1 mm past the fill line, and leaves a ${box.hole.diaMm} mm ${HOLE_USE[box.hole.purpose]}`] : []),
    ...r.warnings.map((w) => `- ${w}`),
  ];
}
