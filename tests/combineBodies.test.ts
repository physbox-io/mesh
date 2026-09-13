// Merging one body's shapes into another's.
//
// A boolean is a program over ONE body's geoms, so two bodies dragged in from
// the sidebar can never cut each other however they overlap. This is what
// brings them together — and all of its difficulty is that a geom's numbers are
// relative to the body carrying it, so the same shape has different coordinates
// the moment it belongs to a different body.
//
// The failure this guards against is quiet: a shape that lands somewhere
// plausible and wrong. So every test here checks a WORLD position — where the
// shape actually ends up — rather than the numbers written on it.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  nodeMatrix, nodeWorldMatrix, rewriteGeom, geomsForCombine, cageInFrame,
} from '../src/utils/combineBodies';
import {
  addFace, createLattice, faceCount, isWatertight, latticeBounds, vertexAt, type Lattice,
} from '../src/utils/latticeMesh';
import { latticeBoolean } from '../src/utils/latticeBoolean';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const bodyAt = (id: string, pos: number[], geoms: SceneGeom[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos, geoms, joints: [], children: [], ...extra,
});

/** Where a geom's origin sits in world space, given the body carrying it. */
function worldOf(node: SceneNode, geom: SceneGeom, nodes: SceneNode[] = [node]): THREE.Vector3 {
  const world = nodeWorldMatrix(nodes, node.id)!;
  const at = geom.pos || [0, 0, 0];
  return new THREE.Vector3(at[0], at[1], at[2]).applyMatrix4(world);
}

/** destination⁻¹ · source: the transform geomsForCombine wants. */
function relative(nodes: SceneNode[], sourceId: string, targetId: string): THREE.Matrix4 {
  return nodeWorldMatrix(nodes, targetId)!.clone().invert()
    .multiply(nodeWorldMatrix(nodes, sourceId)!);
}

describe('body transforms', () => {
  it('accumulates through parents', () => {
    const child = bodyAt('child', [0, 0, 0.5], []);
    const parent = bodyAt('parent', [1, 0, 0], [], { children: [child] });
    const at = new THREE.Vector3().applyMatrix4(nodeWorldMatrix([parent], 'child')!);
    expect([at.x, at.y, at.z]).toEqual([1, 0, 0.5]);
  });

  it('reads a quat in MuJoCo order, not Three\'s', () => {
    // 90° about Z as [w, x, y, z]. Read as (x, y, z, w) it would be a quarter
    // turn about a different axis entirely, and every shape would land wrong.
    const half = Math.SQRT1_2;
    const node = bodyAt('b', [0, 0, 0], [], { quat: [half, 0, 0, half] });
    const at = new THREE.Vector3(1, 0, 0).applyMatrix4(nodeMatrix(node));
    expect(at.x).toBeCloseTo(0, 9);
    expect(at.y).toBeCloseTo(1, 9);
  });
});

describe('rewriting a geom into another body', () => {
  it('leaves the shape exactly where it was in the world', () => {
    const cube = bodyAt('cube', [0.1, 0, 0.2], [{ name: 'cube_geom', type: 'box', size: [0.05, 0.05, 0.05] }]);
    const ball = bodyAt('ball', [0.13, 0, 0.22], [{ name: 'ball_geom', type: 'sphere', size: [0.03] }]);
    const nodes = [cube, ball];

    const before = worldOf(ball, ball.geoms[0], nodes);
    const moved = rewriteGeom(ball.geoms[0], relative(nodes, 'ball', 'cube'));
    const after = worldOf(cube, moved, nodes);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
    // Written in the cube's frame it is 30 mm along X, which is where the
    // overlap actually is.
    expect(moved.pos![0]).toBeCloseTo(0.03, 9);
  });

  it('gives a shape a rotation when the two bodies are turned differently', () => {
    const half = Math.SQRT1_2;
    const target = bodyAt('t', [0, 0, 0], [], { quat: [half, 0, 0, half] });   // 90° about Z
    const source = bodyAt('s', [0.1, 0, 0], [{ name: 's_geom', type: 'box', size: [0.01, 0.02, 0.03] }]);
    const nodes = [target, source];

    const moved = rewriteGeom(source.geoms[0], relative(nodes, 's', 't'));
    // The source has no rotation of its own; the difference between the bodies
    // supplies one, and dropping it would leave the box square to the wrong axes.
    expect(moved.quat).toBeDefined();
    const back = new THREE.Vector3(1, 0, 0).applyQuaternion(
      new THREE.Quaternion(moved.quat![1], moved.quat![2], moved.quat![3], moved.quat![0]),
    );
    expect(back.y).toBeCloseTo(-1, 6);
    // And the world position is unchanged, which is the point.
    expect(worldOf(target, moved, nodes).x).toBeCloseTo(0.1, 9);
  });

  it('carries a mesh through in its vertices, not its pos', () => {
    // A mesh's vertices ARE its position — they are body coordinates, and a
    // quat on the geom is never applied to them. So the transform has to go
    // into the numbers themselves.
    const source = bodyAt('s', [0.1, 0, 0], [{
      name: 'm', type: 'mesh', size: [1],
      renderVertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0],
      vertices: [0, 0, 0, 0.01, 0, 0, 0, 0, -0.01],
      faces: [0, 1, 2],
    }]);
    const target = bodyAt('t', [0, 0, 0], []);
    const moved = rewriteGeom(source.geoms[0], relative([target, source], 's', 't'));

    expect(moved.pos).toEqual([0, 0, 0]);
    expect(moved.renderVertices!.slice(0, 3)).toEqual([0.1, 0, 0]);
    expect(moved.renderVertices!.slice(3, 6)).toEqual([0.11, 0, 0]);
    // The Y-up copy the renderer reads is rebuilt from it, not left stale.
    expect(moved.vertices!.slice(0, 3)).toEqual([0.1, 0, 0]);
    expect(moved.vertices!.slice(6, 9)).toEqual([0.1, 0, -0.01]);
  });

  it('moves both ends of a capsule written as fromto', () => {
    // fromto is two points in body coordinates; pos and quat are ignored for a
    // geom written this way, so composing a matrix onto them would do nothing.
    const source = bodyAt('s', [0, 0, 0.5], [{
      name: 'c', type: 'capsule', size: [0.01], fromto: [0, 0, 0, 0, 0, 0.1],
    }]);
    const target = bodyAt('t', [0, 0, 0], []);
    const moved = rewriteGeom(source.geoms[0], relative([target, source], 's', 't'));
    expect(moved.fromto).toEqual([0, 0, 0.5, 0, 0, 0.6]);
    expect(moved.pos).toBeUndefined();
  });
});

describe('geomsForCombine', () => {
  const cube = () => bodyAt('cube', [0, 0, 0], [{ name: 'shape', type: 'box', size: [0.05, 0.05, 0.05] }]);
  const ball = () => bodyAt('ball', [0.03, 0, 0], [{ name: 'shape', type: 'sphere', size: [0.03] }]);

  it('marks what it brings with the operation asked for', () => {
    const nodes = [cube(), ball()];
    const cut = geomsForCombine(nodes[1], relative(nodes, 'ball', 'cube'), 'difference', new Set());
    expect(cut[0].csg).toBe('difference');
    const added = geomsForCombine(nodes[1], relative(nodes, 'ball', 'cube'), 'union', new Set());
    expect(added[0].csg).toBeUndefined();
  });

  it('renames a shape that would collide, because MuJoCo will not build twins', () => {
    const nodes = [cube(), ball()];
    const brought = geomsForCombine(nodes[1], relative(nodes, 'ball', 'cube'), 'union', new Set(['shape']));
    expect(brought[0].name).toBe('shape_2');
  });

  it('leaves behind what belongs to the body it came from', () => {
    const source = bodyAt('s', [0, 0, 0], [
      { name: 'keep', type: 'box', size: [0.01, 0.01, 0.01] },
      // The previous boolean's output: regenerated from the sources anyway.
      { name: 'derived', type: 'mesh', size: [1], csgDerived: 'visual' },
      // A hole in a body that is about to stop existing.
      { name: 'hole', type: 'cylinder', size: [0.002, 0.05], csg: 'difference' },
      // Ground planes are not solids and cannot take part.
      { name: 'floor', type: 'plane', size: [1, 1, 1] },
    ]);
    const brought = geomsForCombine(source, new THREE.Matrix4(), 'union', new Set());
    expect(brought.map(g => g.name)).toEqual(['keep']);
  });

  it('strips the markers that belonged to the old body', () => {
    // A cage owns exactly one geom, and a cut is anchored to a surface that is
    // about to be part of something else. Carrying either across would have the
    // destination's next lattice edit rewrite the wrong mesh.
    const source = bodyAt('s', [0, 0, 0], [{
      name: 'm', type: 'mesh', size: [1], latticeGeom: true,
      renderVertices: [0, 0, 0], faces: [0, 0, 0],
      cutNormal: [0, 0, 1], cutAt: [0, 0, 0], cutDepth: 0.01,
    }]);
    const brought = geomsForCombine(source, new THREE.Matrix4(), 'union', new Set());
    expect(brought[0].latticeGeom).toBeUndefined();
    expect(brought[0].cutNormal).toBeUndefined();
    expect(brought[0].cutDepth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Carrying a cage across, which is what lets two lattice bodies be booleaned
// ---------------------------------------------------------------------------

describe('cageInFrame', () => {
  /** A 10 mm cube on a 1 mm grid, corners on 0 and 10. */
  function cube(): Lattice {
    const l = createLattice(0.001);
    const v = (i: number, j: number, k: number) => vertexAt(l, i * 10, j * 10, k * 10);
    addFace(l, [v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)]);
    addFace(l, [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)]);
    addFace(l, [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)]);
    addFace(l, [v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0)]);
    addFace(l, [v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)]);
    addFace(l, [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]);
    return l;
  }

  it('moves every corner by the transform, in whole grid steps', () => {
    const moved = cageInFrame(
      cube(),
      new THREE.Matrix4().makeTranslation(0.02, 0, 0), // 20 mm along x
      [0, 0, 0], [0, 0, 0], 0.001,
    );
    expect(latticeBounds(moved)).toEqual({ min: [20, 0, 0], max: [30, 10, 10] });
    expect(faceCount(moved)).toBe(6);
    expect(isWatertight(moved)).toBe(true);
  });

  it('takes the two bodies’ recentring offsets into account', () => {
    // The source was recentred 5 mm along x, the destination 2 mm the other
    // way: the corner at 0 has to come out 7 mm further on than a naive move.
    const moved = cageInFrame(
      cube(), new THREE.Matrix4(), [0.005, 0, 0], [-0.002, 0, 0], 0.001,
    );
    expect(latticeBounds(moved)!.min).toEqual([-7, 0, 0]);
  });

  it('brings a turned body across as the nearest shape the grid can hold', () => {
    const moved = cageInFrame(
      cube(),
      new THREE.Matrix4().makeRotationZ(Math.PI / 2),
      [0, 0, 0], [0, 0, 0], 0.001,
    );
    // A quarter turn is exact on the grid: the cube lands square again.
    expect(latticeBounds(moved)).toEqual({ min: [-10, 0, 0], max: [0, 10, 10] });
    expect(isWatertight(moved)).toBe(true);
  });

  it('hands back a cage a boolean can use', () => {
    const a = cube();
    const b = cageInFrame(cube(), new THREE.Matrix4().makeTranslation(0.005, 0, 0), [0,0,0], [0,0,0], 0.001);
    const out = latticeBoolean(a, b, 'union')!;
    expect(out).not.toBeNull();
    expect(isWatertight(out)).toBe(true);
    // Two 10 mm cubes overlapping by 5: a 15 x 10 x 10 slab.
    expect(latticeBounds(out)).toEqual({ min: [0, 0, 0], max: [15, 10, 10] });
    expect(faceCount(out)).toBe(6);
  });
});
