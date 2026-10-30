import { describe, it, expect } from 'vitest';
import { objectReply, stripMeshArrays } from '../src/utils/objectReply';
import { bodyWorldPositions } from '../src/utils/bodyWorld';
import { geomBboxOf, meshIntegrity } from '../src/utils/sceneSummary';
import { collisionHashOf } from '../src/utils/convexDecomposition';
import type { SceneGeom, SceneNode } from '../src/types/scene';

/** A closed box mesh, Z-up, centred on `c` with half-size `h`. */
function boxMesh(name: string, c: number[], h: number, extra: Partial<SceneGeom> = {}): SceneGeom {
  const v: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push(c[0] + x * h, c[1] + y * h, c[2] + z * h);
  const faces = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { name, type: 'mesh', size: [1], renderVertices: v, faces, dynamic: true, ...extra } as SceneGeom;
}

/** One link of an arm: a hollow bracket drawn as one mesh, colliding as `pieces` convex pieces. */
function link(id: string, z: number, pieces: number, children: SceneNode[] = []): SceneNode {
  const node: SceneNode = {
    id, name: id, type: 'body', pos: [0, 0, z],
    joints: [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0] }],
    collisionDecomposed: true, collisionSolidity: 0.45, 
    geoms: [
      boxMesh(`${id}_geom_0`, [0, 0, 0.05], 0.015),
      ...Array.from({ length: pieces }, (_, i) => boxMesh(`${id}_csg_col${i}`, [0, 0, i * 0.002], 0.003, {
        role: 'collision', csgDerived: 'collider', colliderOf: `${id}_geom_0`, mass: 0.001, condim: 3,
      })),
    ],
    children,
  };
  return { ...node, collisionHash: collisionHashOf(node) };
}

const arm = () => link('base', 0.02, 40, [link('upper', 0.03, 40, [link('fore', 0.12, 40, [link('grip', 0.1, 40)])])]);

/** The reply as it used to be built: every geom, pieces and all, with its checks. */
function oldReply(n: SceneNode): SceneNode {
  const checked = (x: SceneNode): SceneNode => ({
    ...x,
    geoms: x.geoms.map((g) => ({ ...g, vertCount: (g.renderVertices || []).length / 3, faceCount: (g.faces || []).length / 3, bbox: geomBboxOf(g), ...meshIntegrity(g) })),
    children: x.children.map(checked),
  });
  return stripMeshArrays(checked(n));
}

describe('physics_get_object reply', () => {
  it('counts an arm\'s convex pieces instead of listing them', () => {
    const before = JSON.stringify(oldReply(arm())).length;
    const after = JSON.stringify(objectReply(arm())).length;
    // 160 pieces made it ~60 KB; the reply should not grow with them.
    expect(before).toBeGreaterThan(40_000);
    expect(after).toBeLessThan(6_000);
    const r = objectReply(arm()) as { geoms: SceneGeom[]; colliderGeoms: number; collidesAs: string; children: Array<{ colliderGeoms: number }> };
    expect(r.geoms.map((g) => g.name)).toEqual(['base_geom_0']);
    expect(r.colliderGeoms).toBe(40);
    expect(r.collidesAs).toBe('40 convex pieces');
    expect(r.children[0].colliderGeoms).toBe(40);
  });

  it('lists every piece with full', () => {
    const r = objectReply(arm(), { full: true }) as { geoms: SceneGeom[] };
    expect(r.geoms).toHaveLength(41);
    expect(r.geoms.every((g) => !g.renderVertices && !g.faces)).toBe(true);
  });

  it('gives a nested body its world position, authored or live', () => {
    const authored = bodyWorldPositions([arm()]);
    expect(authored.get('grip')!.pos.map((v) => +v.toFixed(6))).toEqual([0, 0, 0.27]);
    expect(authored.get('grip')!.source).toBe('authored');
    const xpos = new Float64Array(5 * 3);
    xpos.set([0.1, 0.2, 0.3], 4 * 3);
    const live = bodyWorldPositions([arm()], { model: { _idMaps: { body: { base: 1, upper: 2, fore: 3, grip: 4 } } }, data: { xpos } });
    expect(live.get('grip')).toEqual({ pos: [0.1, 0.2, 0.3], source: 'simulation' });
    const stale = bodyWorldPositions([arm()], { model: { _idMaps: { body: { grip: 4 } } }, data: { xpos }, stale: new Set(['grip']) });
    expect(stale.get('grip')!.source).toBe('authored');
    const r = objectReply(arm(), { world: authored }) as { children: Array<{ children: Array<{ worldPos: number[] }> }> };
    expect(r.children[0].children[0].worldPos).toEqual([0, 0, 0.17]);
  });
});
