// The pachinko machine has to keep running: every part of the loop is
// mechanics, so nothing but a measurement says it does.
//
// Each bound stands for something that went wrong on the way. A thin box
// hammer threw a ball through the glass at 100 m/s; weak shots fell back on it
// and were knocked under the ramp, draining the machine; and a hammer that
// bottomed on the stand made every shot the same, all to one side.

import { describe, expect, it } from 'vitest';
import { arcBand, PACHINKO_BALLS, pachinkoPreset, pachinkoWorld, prismMesh } from '../src/presets/pachinko';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneNode } from '../src/types/scene';
import { simulate } from './helpers/simulate';

const toLocal = (p: number[]) => {
  const o = pachinkoWorld([0, 0, 0]);
  const axis = (a: number[]) => pachinkoWorld(a).map((v, i) => v - o[i]);
  const d = p.map((v, i) => v - o[i]);
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => {
    const e = axis(a);
    return d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
  });
};

describe('the pachinko machine', () => {
  it('builds its curved parts wound outward', () => {
    const a = analyzeMesh(...(({ renderVertices, faces }) => [renderVertices, faces] as const)(prismMesh(arcBand(0, 0.3, 0.165, 0.18, 0, 180, 48))));
    expect(a.closed).toBe(true);
    expect(a.consistentlyWound).toBe(true);
    expect(a.volume).toBeGreaterThan(0);
  });

  it('runs a minute: shots cross the field and no ball is lost', async () => {
    const nodes: SceneNode[] = pachinkoPreset.nodes.map(n => ({ ...n }));
    const cabinet = nodes.find(n => n.id === 'cabinet')!;
    const r = (await decomposeNodeColliders(cabinet))!;
    // The arc and tulips, cut exactly: nothing narrows the way through.
    expect(r.intrusion).toBeUndefined();
    cabinet.geoms = [...cabinet.geoms!, ...r.geoms];
    cabinet.collisionHash = r.hash;
    cabinet.collisionDecomposed = true;

    const sim = await simulate({ nodes } as never);
    const balls = Array.from({ length: PACHINKO_BALLS }, (_, i) => `ball_${i}`);
    let prev = balls.map(b => toLocal(sim.bodyPos(b)));
    let landed = 0, peak = 0, top = 0;
    const sides = new Set<number>();
    for (let s = 0; s < 60_000; s++) {
      sim.step(1);
      const now = balls.map(b => toLocal(sim.bodyPos(b)));
      now.forEach((p, i) => {
        peak = Math.max(peak, Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1], p[2] - prev[i][2]) * 1000);
        top = Math.max(top, p[2]);
        if (prev[i][2] >= 0.11 && p[2] < 0.11 && p[0] > -0.146) { landed++; sides.add(Math.sign(p[0])); }
      });
      prev = now;
    }
    // A hammer shot is 3 m/s. It was 100 when a ball went through the glass.
    expect(peak).toBeLessThan(15);
    // Over the top of the arc, and through the field in numbers.
    expect(top).toBeGreaterThan(0.44);
    expect(landed).toBeGreaterThan(30);
    expect(sides.size).toBe(2);
    // All still on the board: above the ramp's foot, inside the walls.
    for (const p of prev) {
      expect(p[2]).toBeGreaterThan(0.045);
      expect(Math.abs(p[0])).toBeLessThan(0.18);
      expect(p[1]).toBeLessThan(0);
      expect(p[1]).toBeGreaterThan(-0.013);
    }
    expect(Math.abs(sim.jointPos('windmill_0_axle'))).toBeGreaterThan(1);
    sim.dispose();
  }, 180_000);
});
