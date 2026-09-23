// Does a dent actually move the surface, and only where it was struck?
//
// This is hard to check by looking: a 5 mm crater in a 24 mm plate is easy to
// miss on screen, and a dent applied to the wrong face — the underside, say,
// because the contact picked was the plate's contact with the ground — looks
// exactly like no dent at all. So the assertions are about which vertices moved
// and which way.

import { describe, it, expect, beforeEach } from 'vitest';
import { dentKey, useDentStore } from '../src/store/dentStore';
import { dentDepth, pierceVerdict } from '../src/utils/breakThresholds';
import { shatterPreset } from '../src/presets/shatter';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const plateGeom = (): SceneGeom =>
  ((shatterPreset.nodes as SceneNode[]).find((n) => n.id === 'plate')!).geoms[0];

/** Highest vertex within `r` of (x, y) — the top face under the brush. */
const topNear = (verts: ArrayLike<number>, x: number, y: number, r: number) => {
  let best = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    if (Math.hypot(verts[i] - x, verts[i + 1] - y) > r) continue;
    if (verts[i + 2] > best) best = verts[i + 2];
  }
  return best;
};

describe('the plate as authored', () => {
  it('has a gridded top face, because a six-vertex box cannot show a dent', () => {
    const g = plateGeom();
    expect(g.renderVertices!.length / 3).toBeGreaterThan(500);
    expect(g.dentYieldNs).toBeGreaterThan(0);
  });
});

describe('denting', () => {
  beforeEach(() => useDentStore.getState().clear());

  const strike = (impulseNs: number, at: [number, number, number] = [0, 0, 0.012]) => {
    const g = plateGeom();
    const depth = dentDepth(impulseNs, g);
    useDentStore.getState().dent(
      dentKey('plate', g.name), g.renderVertices!, g.faces!,
      at, [0, 0, 1], depth, g.dentRadius ?? 0.05,
    );
    return { g, depth };
  };

  it('pushes the struck face in, and leaves the rest of the plate alone', () => {
    const g = plateGeom();
    const before = g.renderVertices!;
    const { depth } = strike(12);
    expect(depth).toBeGreaterThan(0.001);

    const after = useDentStore.getState().dents[dentKey('plate', g.name)];
    expect(after).toBeDefined();
    const verts = after!.mesh.positions.subarray(0, after!.mesh.vertexCount * 3);

    // The crater is where it was struck...
    const sank = topNear(before, 0, 0, 0.01) - topNear(verts, 0, 0, 0.01);
    expect(sank).toBeGreaterThan(depth * 0.5);

    // ...and the far corner of the plate has not moved at all.
    const farBefore = topNear(before, 0.22, 0.14, 0.02);
    const farAfter = topNear(verts, 0.22, 0.14, 0.02);
    expect(Math.abs(farAfter - farBefore)).toBeLessThan(1e-6);
  });

  it('answers to how hard the blow was, across the range blows actually land in', () => {
    /*
     * The bug this pins: with the depth rate set too high, `dentMaxDepth` was
     * reached at an impulse a hair over the yield, so every blow harder than
     * "just enough" left an identical crater and the weight's mass made no
     * visible difference whatsoever. A dent that cannot tell 10 N*s from 40 is
     * not modelling anything.
     *
     * The numbers are the ones this scene really produces: the slug lands about
     * 10.9 N*s at its authored mass, and twice that at twice the mass.
     */
    const g = plateGeom();
    const light = dentDepth(10.9, g);
    const heavy = dentDepth(21.8, g);
    expect(light).toBeGreaterThan(0.004);
    expect(heavy).toBeGreaterThan(light * 1.5);
    // And the cap is a cap, not the normal answer.
    expect(light).toBeLessThan(g.dentMaxDepth!);
  });

  it('does nothing at all below the yield — the soft weight', () => {
    const g = plateGeom();
    // The rubber weight lands about 5.6 N*s; the plate yields at 7.5.
    expect(dentDepth(5.6, g)).toBe(0);
    strike(5.6);
    expect(useDentStore.getState().dents[dentKey('plate', g.name)]).toBeUndefined();
  });

  it('dents the same spot deeper when it is struck twice, rather than resetting', () => {
    const g = plateGeom();
    strike(12);
    const first = useDentStore.getState().dents[dentKey('plate', g.name)]!;
    const afterOne = topNear(first.mesh.positions.subarray(0, first.mesh.vertexCount * 3), 0, 0, 0.01);
    strike(12);
    const second = useDentStore.getState().dents[dentKey('plate', g.name)]!;
    const afterTwo = topNear(second.mesh.positions.subarray(0, second.mesh.vertexCount * 3), 0, 0, 0.01);

    expect(second.count).toBe(2);
    expect(afterTwo).toBeLessThan(afterOne);
  });

  it('keeps the mesh drawable: same topology, normals refreshed', () => {
    const g = plateGeom();
    strike(12);
    const d = useDentStore.getState().dents[dentKey('plate', g.name)]!;
    expect(d.mesh.vertexCount).toBe(g.renderVertices!.length / 3);
    expect(d.mesh.faceCount).toBe(g.faces!.length / 3);
    expect(d.mesh.normals.length).toBeGreaterThanOrEqual(d.mesh.vertexCount * 3);
  });

  it('holes a surface clean through rather than creasing it', () => {
    const g = plateGeom();
    const before = { verts: g.renderVertices!.length / 3, tris: g.faces!.length / 3 };

    useDentStore.getState().pierce(
      dentKey('plate', g.name), g.renderVertices!, g.faces!,
      [0, 0, 0.012], [0, 0, 1], 0.03,
    );
    const d = useDentStore.getState().dents[dentKey('plate', g.name)]!;

    // Material is GONE, which is the difference between a hole and a dent.
    expect(d.mesh.faceCount).toBeLessThan(before.tris);
    expect(d.holes).toBe(1);

    // Through both faces, not a dimple with a lid: nothing is left anywhere
    // along the bore.
    for (let f = 0; f < d.mesh.faceCount; f++) {
      const a = d.mesh.faces[f * 3] * 3, b = d.mesh.faces[f * 3 + 1] * 3, c = d.mesh.faces[f * 3 + 2] * 3;
      const p = d.mesh.positions;
      const mx = (p[a] + p[b] + p[c]) / 3, my = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      expect(Math.hypot(mx, my)).toBeGreaterThanOrEqual(0.03 - 1e-9);
    }

    // ...and the plate still exists. A blow that removed everything would read
    // as a bug rather than as a hole.
    expect(d.mesh.faceCount).toBeGreaterThan(before.tris * 0.5);
  });

  it('refuses to remove the whole surface', () => {
    const g = plateGeom();
    // A bore far larger than the plate: nothing should be left to keep, so the
    // removal is declined outright rather than leaving a body that vanished.
    useDentStore.getState().pierce(
      dentKey('plate', g.name), g.renderVertices!, g.faces!,
      [0, 0, 0], [0, 0, 1], 10,
    );
    const d = useDentStore.getState().dents[dentKey('plate', g.name)]!;
    expect(d.mesh.faceCount).toBe(g.faces!.length / 3);
  });

  it('pierces instead of denting once the blow is hard enough', () => {
    const g = plateGeom();
    // The plate as authored cannot be pierced at all...
    expect(pierceVerdict(1e6, g)).toBe(false);
    // ...but the foil can, and well above where it starts to mark.
    const foil = ((shatterPreset.nodes as SceneNode[]).find((n) => n.id === 'foil')!).geoms[0];
    expect(pierceVerdict(11.1, foil)).toBe(true);
    expect(pierceVerdict(3, foil)).toBe(false);
    expect(dentDepth(3, foil)).toBeGreaterThan(0);
    expect(foil.pierceImpulseNs!).toBeGreaterThan(foil.dentYieldNs! * 1.5);
  });

  it('is cleared wholesale, which is what Reset does', () => {
    strike(12);
    expect(Object.keys(useDentStore.getState().dents)).toHaveLength(1);
    useDentStore.getState().clear();
    expect(Object.keys(useDentStore.getState().dents)).toHaveLength(0);
  });
});
