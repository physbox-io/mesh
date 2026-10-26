// A nut slot: the nut slides in from the side of the part and sits buried under
// the face, on the bolt's line. These place one in a 40 x 40 x 20 mm block and
// check where the material actually goes, by testing points against the slot's
// box as cutGeometry poses it.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HEX_NUTS, CLEARANCE_HOLES, NUT_SLOT_COVER_MM, hardwareCutGeoms, hardwareCutProblem, hardwareSpecOf, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry, reconcileCuts } from '../src/utils/csg';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const block = (hx = 0.02, hy = 0.02, hz = 0.01): SceneNode => ({
  id: 'block', name: 'block', pos: [0, 0, 0], csgEnabled: true,
  geoms: [{ name: 'b', type: 'box', size: [hx, hy, hz] } as SceneGeom],
} as SceneNode);

const spec = (over: Partial<HardwareCutSpec> = {}): HardwareCutSpec => ({
  group: 'g1', kind: 'nut_slot', size: 'M3', at: [0.012, 0, 0.01], normal: [0, 0, 1], ...over,
});

/** Builds the feature into the block the way the store does: each piece placed in turn. */
function place(node: SceneNode, s: HardwareCutSpec): SceneGeom[] {
  const pieces = hardwareCutGeoms(s, node.id, node);
  for (const piece of pieces) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return pieces;
}

/** Whether a body-frame point (mm) is inside a posed box cut. */
function inBox(g: SceneGeom, mm: [number, number, number]): boolean {
  const [w, x, y, z] = g.quat!;
  const q = new THREE.Quaternion(x, y, z, w).invert();
  const p = new THREE.Vector3(mm[0] / 1000, mm[1] / 1000, mm[2] / 1000).sub(new THREE.Vector3(...(g.pos as [number, number, number]))).applyQuaternion(q);
  return Math.abs(p.x) <= g.size[0] + 1e-9 && Math.abs(p.y) <= g.size[1] + 1e-9 && Math.abs(p.z) <= g.size[2] + 1e-9;
}

const [flats, height] = HEX_NUTS.M3;
const fit = 0.2;
const nutZ = 10 - NUT_SLOT_COVER_MM - (height + fit) / 2; // mm, the nut's middle

describe('nut slot', () => {
  it('is a clearance hole through and a slot, with the hole first', () => {
    const pieces = place(block(), spec());
    expect(pieces.map((p) => p.hardware!.part)).toEqual(['shank', 'slot']);
    expect(pieces[0].size[0]).toBeCloseTo(CLEARANCE_HOLES.M3 / 2000, 9);
  });

  it('runs out of the nearest side, and says which', () => {
    // 8 mm from +X, 28 from -X, 20 from either Y side.
    const [, slot] = place(block(), spec());
    expect(slot.hardware!.quarter).toBe(0);
    const nearY = place(block(), spec({ at: [0, -0.015, 0.01] }))[1];
    expect(nearY.hardware!.quarter).toBe(3);
  });

  it('holds the nut where it should be: under the cover, on the bolt line, open to the side', () => {
    const [, slot] = place(block(), spec());
    // The nut's middle and the way out to the +X face are slot.
    expect(inBox(slot, [12, 0, nutZ])).toBe(true);
    expect(inBox(slot, [19.9, 0, nutZ])).toBe(true);
    // The nut's far corner is inside; beyond it is part.
    const corner = (flats + fit) / Math.sqrt(3);
    expect(inBox(slot, [12 - corner + 0.05, 0, nutZ])).toBe(true);
    expect(inBox(slot, [12 - corner - 0.1, 0, nutZ])).toBe(false);
    // As wide as the nut across its flats, so it cannot turn.
    expect(inBox(slot, [15, (flats + fit) / 2 - 0.05, nutZ])).toBe(true);
    expect(inBox(slot, [15, (flats + fit) / 2 + 0.1, nutZ])).toBe(false);
    // The cover over it is left alone, and so is the floor under it.
    expect(inBox(slot, [15, 0, 10 - NUT_SLOT_COVER_MM + 0.1])).toBe(false);
    expect(inBox(slot, [15, 0, nutZ - (height + fit) / 2 - 0.1])).toBe(false);
  });

  it('turns to another side when asked, and reads the turn back', () => {
    const node = block();
    const [, slot] = place(node, spec({ quarter: 1 }));
    expect(inBox(slot, [12, 19.9, nutZ])).toBe(true);
    expect(inBox(slot, [19.9, 0, nutZ])).toBe(false);
    expect(hardwareSpecOf(node.geoms, 'g1')?.quarter).toBe(1);
  });

  it('stays at the nut when the part grows round it', () => {
    const node = block();
    place(node, spec());
    (node.geoms[0].size as number[])[0] = 0.03;
    reconcileCuts(node);
    const slot = node.geoms.find((g) => g.hardware?.part === 'slot')!;
    expect(inBox(slot, [12, 0, nutZ])).toBe(true);
    expect(inBox(slot, [29.9, 0, nutZ])).toBe(true);
    expect(slot.cutAt![0]).toBeCloseTo(0.012, 9);
  });

  it('is refused in a part too thin to bury the nut', () => {
    const thin = block(0.02, 0.02, 0.0025);
    const s = spec({ at: [0.012, 0, 0.0025] });
    expect(hardwareCutProblem(s, thin)).toMatch(/needs 5\.6 mm/);
    expect(hardwareCutGeoms(s, thin.id, thin)).toEqual([]);
  });
});
