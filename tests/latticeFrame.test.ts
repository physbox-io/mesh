// A lattice body's cage coordinates mean the same place everywhere.
//
// The rule (utils/latticeFrame.ts): the body sits on its shape's centre of
// mass, a cage point c is at body-frame c - latticeOrigin, and a caller's `pos`
// on creation names the cage origin. Creating a body with `ops` used to leave
// `pos` on the requested point while the mesh moved to its centre of mass, so
// an arm extruded 140 mm out of a 20 mm cube was drawn, simulated and weighed
// 70 mm inboard of its own cage.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  boxLattice, deserializeCage, serializeCage, toSceneGeom, DEFAULT_UNIT,
} from '../src/utils/latticeMesh';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { latticeBodyPos, cageOriginInBodyMm } from '../src/utils/latticeFrame';
import { computeNodeBoundingBox } from '../src/utils/noteCards';
import { useStore } from '../src/store/useStore';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const ARM_OPS = [{
  op: 'extrude',
  face: [[10, -10, -10], [10, 10, -10], [10, 10, 10], [10, -10, 10]],
  distanceMm: 140,
}];

function arm() {
  const lat = boxLattice(DEFAULT_UNIT, 100);
  runLatticeOps(lat, ARM_OPS);
  return toSceneGeom(deserializeCage(serializeCage(lat)), 0, 0);
}

/** World X range of a body's mesh, for a body with no rotation. */
function worldXRange(pos: number[], renderVertices: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < renderVertices.length; i += 3) {
    lo = Math.min(lo, renderVertices[i] + pos[0]);
    hi = Math.max(hi, renderVertices[i] + pos[0]);
  }
  return [lo, hi];
}

describe('creating a lattice body with ops', () => {
  it('puts the cage origin at the requested pos', () => {
    const { renderVertices, origin } = arm();
    expect(origin[0]).toBeCloseTo(0.07, 6);
    const pos = latticeBodyPos([0.03, 0, 0], origin);
    const [lo, hi] = worldXRange(pos, renderVertices);
    // The cage runs x -10..150 mm, so the body spans 0.02..0.18 m in the world.
    expect(lo).toBeCloseTo(0.02, 6);
    expect(hi).toBeCloseTo(0.18, 6);
  });

  it('turns the offset by the body orientation', () => {
    const pos = latticeBodyPos([0, 0, 0], [0.07, 0, 0], { euler: [0, 0, 90] });
    expect(pos[0]).toBeCloseTo(0, 6);
    expect(pos[1]).toBeCloseTo(0.07, 6);
  });

  it('does the same for a declarative lattice in build_scene', () => {
    const node = fillBodyDefaults({
      name: 'arm', pos: [0.03, 0, 0], joints: [],
      lattice: { sizeMm: 20, ops: ARM_OPS },
    } as unknown as Parameters<typeof fillBodyDefaults>[0]);
    expect(node.pos[0]).toBeCloseTo(0.1, 6);
    expect(cageOriginInBodyMm(node)).toEqual([-70, 0, 0]);
  });

  it('reports two arms either side of a hub at their real span', () => {
    const { vertices, renderVertices, faces, origin } = arm();
    const mk = (id: string, euler: number[]): SceneNode => ({
      id, name: id, type: 'body', euler, joints: [], children: [],
      pos: latticeBodyPos(euler[2] ? [-0.03, 0, 0] : [0.03, 0, 0], origin, { euler }),
      geoms: [{ name: `${id}_mesh`, type: 'mesh', size: [1], vertices, renderVertices, faces }],
    } as SceneNode);
    const hub = {
      id: 'hub', name: 'hub', type: 'body', pos: [0, 0, 0.3], joints: [],
      geoms: [{ name: 'hub_box', type: 'box', size: [0.02, 0.02, 0.02] }],
      children: [mk('a', [0, 0, 0]), mk('b', [0, 0, 180])],
    } as unknown as SceneNode;
    // 20 mm outboard + 160 mm of arm on each side.
    expect(computeNodeBoundingBox(hub).x).toBeCloseTo(0.36, 6);
  });
});

describe('editing a lattice body', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });

  it('keeps hinges and hung bodies where they were on the shape', () => {
    const lat = boxLattice(DEFAULT_UNIT, 100);
    const { vertices, renderVertices, faces, origin } = toSceneGeom(lat, 0, 0);
    const graph = {
      nodes: [{
        id: 'arm', name: 'arm', type: 'body', pos: [0, 0, 0.5],
        joints: [{ name: 'arm_hinge', type: 'hinge', axis: [0, 1, 0], pos: [-0.01, 0, 0] }],
        isLattice: true, latticeCage: serializeCage(lat), latticeSubdiv: 0, latticeOrigin: origin, latticeVersion: 1,
        geoms: [{ name: 'arm_mesh', type: 'mesh', size: [1], dynamic: true, latticeGeom: true, vertices, renderVertices, faces }],
        children: [{ id: 'tip', name: 'tip', type: 'body', pos: [0.01, 0, 0], joints: [], children: [],
          geoms: [{ name: 'tip_box', type: 'box', size: [0.005, 0.005, 0.005] }] }],
      }],
    } as unknown as SceneGraph;
    useStore.setState({ sceneGraph: graph, model: null, data: null, undoStack: [] });

    const longer = boxLattice(DEFAULT_UNIT, 100);
    runLatticeOps(longer, ARM_OPS);
    useStore.getState().applyLattice('arm', serializeCage(longer), 0, true);

    const node = useStore.getState().sceneGraph.nodes[0];
    // The body moved 70 mm out to the new centre of mass...
    expect(node.pos[0]).toBeCloseTo(0.07, 6);
    // ...and the hinge and the tip stayed at cage x = -10 and +10 mm.
    expect(node.pos[0] + node.joints[0].pos![0]).toBeCloseTo(-0.01, 6);
    expect(node.pos[0] + node.children[0].pos[0]).toBeCloseTo(0.01, 6);
  });
});
