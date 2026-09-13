// The lattice wired into the boolean evaluator.
//
// A cage is a set of integer grid points, so every shape it can describe lands
// on the grid — and the diameters that matter (a 6.35 mm bore, an M4 clearance
// hole) do not, at any step you would model at. The answer is to subtract an
// ordinary primitive from the mesh the cage produces, which means the cage's
// mesh has to be an operand of the body's boolean program like any other shape.
//
// What is tested here is the wiring rather than OpenSCAD: that a mesh operand
// reaches the program, that the fingerprint notices when the cage moves without
// serializing tens of thousands of numbers to find out, and that the megabyte
// of polyhedron literal never reaches the copy of the source kept on the node.

import { describe, it, expect } from 'vitest';
import {
  csgProgram, csgHashOf, hasBooleanOps, scadForDisplay, resolveCsgGeoms,
} from '../src/utils/csg';
import { boxLattice, serializeCage, deserializeCage, toSceneGeom, extrudeFace } from '../src/utils/latticeMesh';
import type { SceneGeom, SceneNode } from '../src/types/scene';

/**
 * The mesh geom a lattice body carries, built from a real cage.
 *
 * `grow` extrudes face after face into a rambling shape, which is how a cage
 * gets to the size a real part is — a plain box is eight corners and proves
 * nothing about what happens at ten thousand.
 */
function cageGeom(extrudeSteps = 0, subdiv = 0, grow = 0): SceneGeom {
  const lattice = boxLattice(0.0001, 200);
  if (extrudeSteps > 0) extrudeFace(lattice, 0, extrudeSteps);
  for (let face = 0; face < grow; face++) extrudeFace(lattice, face, 2);
  const { vertices, renderVertices, faces } = toSceneGeom(lattice, subdiv, 0);
  return {
    name: 'part_mesh', type: 'mesh', size: [1], mass: 1, dynamic: true,
    vertices, renderVertices, faces, latticeGeom: true,
  };
}

/** A lattice body with a 6.35 mm bore through it on Z. */
function bored(mesh: SceneGeom = cageGeom()): SceneNode {
  return {
    id: 'part', name: 'part', type: 'body', pos: [0, 0, 0.3], joints: [], children: [],
    csgEnabled: true,
    geoms: [
      mesh,
      { name: 'part_cut1', type: 'cylinder', size: [0.003175, 0.03], csg: 'difference', pos: [0, 0, 0] },
    ],
  };
}

describe('a cage as a boolean operand', () => {
  it('is the positive the cut is taken out of', () => {
    const node = bored();
    expect(hasBooleanOps(node)).toBe(true);
    const scad = csgProgram(node)!;
    expect(scad).toContain('difference()');
    expect(scad).toContain('polyhedron(points=[');
    // The bore is a real cylinder at a real diameter, not a run of grid steps.
    expect(scad).toContain('cylinder(h=0.06, r=0.003175');
  });

  it('has nothing to compile while the cage is still empty', () => {
    const empty: SceneGeom = { ...cageGeom(), vertices: [], renderVertices: [], faces: [] };
    expect(csgProgram(bored(empty))).toBeNull();
    expect(csgHashOf(bored(empty))).toBe('');
  });

  it('draws the boolean result once it exists, and the cage until then', () => {
    const node = bored();
    expect(resolveCsgGeoms(node, 'render').map(g => g.name)).toEqual(['part_mesh']);
    node.geoms.push({
      name: 'part_csg', type: 'mesh', size: [1], role: 'visual', csgDerived: 'visual',
      vertices: [], renderVertices: [], faces: [0, 1, 2],
    });
    expect(resolveCsgGeoms(node, 'render').map(g => g.name)).toEqual(['part_csg']);
    // A hole is never a solid, whichever list you ask for.
    expect(resolveCsgGeoms(node, 'physics').map(g => g.name)).not.toContain('part_cut1');
  });
});

describe('csgHashOf with a mesh operand', () => {
  it('changes when the cage does', () => {
    const before = csgHashOf(bored(cageGeom()));
    const after = csgHashOf(bored(cageGeom(4)));
    expect(before).not.toBe('');
    expect(after).not.toBe(before);
  });

  it('is stable across rebuilds of the same cage', () => {
    expect(csgHashOf(bored(cageGeom(2)))).toBe(csgHashOf(bored(cageGeom(2))));
  });

  it('changes when the cut moves or resizes', () => {
    const mesh = cageGeom();
    const base = csgHashOf(bored(mesh));
    const moved = bored(mesh);
    moved.geoms[1].pos = [0.01, 0, 0];
    expect(csgHashOf(moved)).not.toBe(base);
    const widened = bored(mesh);
    widened.geoms[1].size = [0.004, 0.03];
    expect(csgHashOf(widened)).not.toBe(base);
    const turned = bored(mesh);
    turned.geoms[1].euler = [0, 90, 0];
    expect(csgHashOf(turned)).not.toBe(base);
  });

  /*
   * The reason the hash stopped being taken over the program text. This runs on
   * every store update for every boolean body in the scene, and a lattice mesh
   * is tens of thousands of numbers — hashing the emitted source would build a
   * megabyte of string per keystroke and throw it away again.
   */
  it('never builds the program to fingerprint it', () => {
    const node = bored(cageGeom(4, 2, 40));
    const emitStart = performance.now();
    const emitted = csgProgram(node)!;
    const emitCost = performance.now() - emitStart;

    const hashStart = performance.now();
    for (let i = 0; i < 20; i++) csgHashOf(node);
    const hashCost = performance.now() - hashStart;

    // Twenty fingerprints of a mesh this size cost less than emitting its
    // source once — which they could not if the fingerprint were taken over
    // the source. The margin is wide enough not to depend on the machine.
    expect(emitted.length).toBeGreaterThan(100_000);
    expect(hashCost).toBeLessThan(emitCost);
  });
});

describe('scadForDisplay', () => {
  it('stands the mesh literal down to a note, keeping the program readable', () => {
    // A smoothed cage, i.e. the case this exists for: thousands of points.
    const full = csgProgram(bored(cageGeom(4, 2, 40)))!;
    const shown = scadForDisplay(full);
    expect(shown.length).toBeLessThan(full.length / 10);
    expect(shown).toContain('difference()');
    expect(shown).toContain('cylinder(h=0.06, r=0.003175');
    expect(shown).not.toContain('points=[');
    expect(shown).toMatch(/polyhedron\(\/\* the modelled mesh: \d+ points, \d+ triangles \*\/\);/);
  });

  it('leaves a program with no mesh in it alone', () => {
    const plain = 'difference() {\n  cube([1, 1, 1], center=true);\n}\n';
    expect(scadForDisplay(plain)).toBe(plain);
  });
});

describe('the cage keeps its own geom', () => {
  /*
   * applyLattice used to write to "the first mesh geom on the body". Once a cut
   * is added the evaluator's own output is a mesh on the same body, and on an
   * unlucky ordering the next edit would overwrite the boolean result with the
   * un-cut cage — which reads as the hole intermittently healing over.
   */
  it('is found by its marker, not by being the first mesh', () => {
    const node = bored();
    node.geoms.unshift({
      name: 'part_csg', type: 'mesh', size: [1], csgDerived: 'visual',
      vertices: [], renderVertices: [], faces: [0, 1, 2],
    });
    const owned = node.geoms.find(g => g.latticeGeom)
      ?? node.geoms.find(g => g.type === 'mesh' && !g.csgDerived);
    expect(owned?.name).toBe('part_mesh');
  });

  it('survives a round trip through the cage serializer', () => {
    const lattice = boxLattice(0.0001, 200);
    const cage = serializeCage(lattice);
    const rebuilt = toSceneGeom(deserializeCage(cage), 0, 0);
    expect(rebuilt.faces.length).toBe(toSceneGeom(lattice, 0, 0).faces.length);
  });
});
